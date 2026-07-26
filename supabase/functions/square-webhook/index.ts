import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SIGNATURE_KEY = Deno.env.get("SQUARE_WEBHOOK_SIGNATURE_KEY");
const NOTIFICATION_URL = Deno.env.get("SQUARE_WEBHOOK_NOTIFICATION_URL");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Square signs webhooks as base64(HMAC-SHA256(notification_url + raw_body)).
// See https://developer.squareup.com/docs/webhooks/step3validate
//
// NOTIFICATION_URL used to default to "" — if SIGNATURE_KEY was set but this
// wasn't, the HMAC silently degraded to body-only, which a forged request
// could satisfy without knowing the real notification URL. Fail closed
// instead: if either half of the secret pair is missing, refuse to verify.
async function verifySignature(rawBody: string, signatureHeader: string | null): Promise<boolean> {
  if (!SIGNATURE_KEY || !NOTIFICATION_URL || !signatureHeader) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SIGNATURE_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signatureBytes = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(NOTIFICATION_URL + rawBody)
  );
  const computed = btoa(String.fromCharCode(...new Uint8Array(signatureBytes)));
  return timingSafeEqual(computed, signatureHeader);
}

// Constant-time string comparison so the signature check can't be probed via
// early-exit timing. (Length is allowed to differ fast — the HMAC is a
// fixed-length base64 string, so that leaks nothing useful.)
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

Deno.serve(async (req) => {
  const rawBody = await req.text();
  const signature = req.headers.get("x-square-hmacsha256-signature");

  if (!(await verifySignature(rawBody, signature))) {
    return new Response("Invalid signature", { status: 401 });
  }

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // A valid signature only proves Square (or someone who captured a valid
  // delivery) sent this payload — it doesn't stop the same delivery being
  // replayed later. Record the event id first; a unique-violation means
  // we've already processed it, so no-op instead of re-applying it.
  if (event.event_id) {
    const { error: dedupeError } = await adminClient
      .from("webhook_events")
      .insert({ event_id: event.event_id });
    if (dedupeError) {
      // 23505 = unique_violation: we've already recorded this event id, so
      // this is a genuine replay — no-op instead of re-applying it. Any
      // other error (e.g. a transient DB issue) should not silently drop a
      // real event, so fall through and process it.
      if (dedupeError.code === "23505") {
        return new Response("ok", { status: 200 });
      }
    }
  }

  const payment = event?.data?.object?.payment;

  if (event.type === "payment.updated" && payment?.status === "COMPLETED" && payment?.order_id) {
    const { data: paymentRow } = await adminClient
      .from("payments")
      .select("id, booking_id, status")
      .eq("square_order_id", payment.order_id)
      .single();

    if (paymentRow && paymentRow.status !== "paid") {
      await adminClient
        .from("payments")
        .update({ status: "paid", paid_at: new Date().toISOString() })
        .eq("id", paymentRow.id);

      await adminClient
        .from("bookings")
        .update({ status: "confirmed" })
        .eq("id", paymentRow.booking_id);
    }
  }

  return new Response("ok", { status: 200 });
});
