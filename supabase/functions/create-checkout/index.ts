import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SQUARE_ACCESS_TOKEN = Deno.env.get("SQUARE_ACCESS_TOKEN");
const SQUARE_LOCATION_ID = Deno.env.get("SQUARE_LOCATION_ID") ?? "L1Q0XJ67RBW2D";
const SQUARE_API_BASE = Deno.env.get("SQUARE_ENVIRONMENT") === "sandbox"
  ? "https://connect.squareupsandbox.com"
  : "https://connect.squareup.com";
const SITE_URL = Deno.env.get("SITE_URL") ?? "https://wisdomindscoop.com";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

// This function is called directly from the browser via
// supabaseClient.functions.invoke, which the browser preflights with an
// OPTIONS request before the real POST — without a response to it, the
// call never reaches this handler at all. supabase-js also attaches its own
// x-client-info (and, on some versions, apikey/x-supabase-api-version)
// headers to every invoke() call — omitting any of those from the allow
// list makes the preflight fail and the whole request never leaves the
// browser, silently, with no server-side log to explain why.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info, x-supabase-api-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return jsonResponse({ error: "Missing Authorization header" }, 401);
  }

  // Bound to the caller's own JWT — used only to confirm who they are.
  const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await callerClient.auth.getUser();
  if (userError || !userData.user) {
    return jsonResponse({ error: "Not authenticated" }, 401);
  }

  let bookingId: string | undefined;
  try {
    const body = await req.json();
    bookingId = body.booking_id;
  } catch {
    return jsonResponse({ error: "Invalid request body" }, 400);
  }
  if (!bookingId) {
    return jsonResponse({ error: "booking_id is required" }, 400);
  }

  // Service-role client to read across tables regardless of RLS — ownership
  // is still checked manually below, this isn't a trust shortcut.
  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: profile } = await adminClient
    .from("profiles")
    .select("id")
    .eq("auth_user_id", userData.user.id)
    .single();
  if (!profile) {
    return jsonResponse({ error: "No profile for this account" }, 403);
  }

  const { data: booking, error: bookingError } = await adminClient
    .from("bookings")
    .select("id, status, slot_start, student_profile_id, services(name, price_cents), providers(display_name)")
    .eq("id", bookingId)
    .single();
  if (bookingError || !booking) {
    return jsonResponse({ error: "Booking not found" }, 404);
  }
  if (booking.student_profile_id !== profile.id) {
    return jsonResponse({ error: "This booking doesn't belong to you" }, 403);
  }
  // Don't mint a payment link for a slot that's cancelled/completed or in the
  // past — a stale portal tab could otherwise let someone pay for a dead slot.
  if (booking.status === "cancelled" || booking.status === "completed") {
    return jsonResponse({ error: "This booking can no longer be paid for." }, 409);
  }
  if (new Date(booking.slot_start).getTime() < Date.now()) {
    return jsonResponse({ error: "This booking time has already passed." }, 409);
  }

  // Re-invoking checkout for a booking that's already paid would upsert the
  // payments row back to "pending" with a fresh Square link, desyncing our
  // record from reality even though nothing needs to be paid again.
  const { data: existingPayment } = await adminClient
    .from("payments")
    .select("status, square_payment_link_id")
    .eq("booking_id", bookingId)
    .maybeSingle();
  if (existingPayment?.status === "paid") {
    return jsonResponse({ error: "This booking has already been paid." }, 409);
  }

  if (!SQUARE_ACCESS_TOKEN) {
    return jsonResponse({ error: "Payments aren't configured yet — booking is saved as pending." }, 503);
  }

  const service = Array.isArray(booking.services) ? booking.services[0] : booking.services;
  const provider = Array.isArray(booking.providers) ? booking.providers[0] : booking.providers;

  const squareRes = await fetch(`${SQUARE_API_BASE}/v2/online-checkout/payment-links`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SQUARE_ACCESS_TOKEN}`,
      "Square-Version": "2025-01-23",
    },
    body: JSON.stringify({
      idempotency_key: crypto.randomUUID(),
      quick_pay: {
        name: `${service.name} with ${provider.display_name}`,
        price_money: { amount: service.price_cents, currency: "CAD" },
        location_id: SQUARE_LOCATION_ID,
      },
      checkout_options: {
        redirect_url: `${SITE_URL}/student-portal.html?paid=1`,
      },
      payment_note: `Booking ${booking.id}`,
    }),
  });

  const squareData = await squareRes.json();
  if (!squareRes.ok) {
    return jsonResponse(
      { error: squareData.errors?.[0]?.detail ?? "Square error creating checkout link" },
      502
    );
  }

  const paymentLink = squareData.payment_link;

  await adminClient.from("payments").upsert(
    {
      booking_id: booking.id,
      square_payment_link_id: paymentLink.id,
      square_order_id: paymentLink.order_id,
      amount_cents: service.price_cents,
      status: "pending",
    },
    { onConflict: "booking_id" }
  );

  return jsonResponse({ url: paymentLink.url }, 200);
});
