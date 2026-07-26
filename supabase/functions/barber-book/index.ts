import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Guest booking + payment for the barbershop wizard. No account required:
// the visitor picks a Square service, a Supabase barber, and a time, enters
// name/email + card, and this function does everything server-side:
//   1. re-prices the service from Square (never trusts the client amount),
//   2. reserves the slot as a pending Supabase booking (DB no-overlap
//      constraint stops double-booking),
//   3. charges the card via the Square Payments API,
//   4. best-effort creates a real Square Appointment on the shop calendar,
//   5. marks the booking confirmed + payment paid in Supabase,
//   6. best-effort emails a confirmation via Resend.
// If the charge fails, the reserved slot is released so it stays bookable.

const SQUARE_ACCESS_TOKEN = Deno.env.get("SQUARE_ACCESS_TOKEN");
const SQUARE_LOCATION_ID = Deno.env.get("SQUARE_LOCATION_ID") ?? "L1Q0XJ67RBW2D";
// Real barbers aren't Square team members (only the account holder is), so
// website appointments are recorded on the shop calendar under this team
// member, with the chosen barber named in the appointment note.
const SQUARE_BOOKING_TEAM_MEMBER_ID = Deno.env.get("SQUARE_BOOKING_TEAM_MEMBER_ID") ?? "TMEBXHjxgprwYDaM";
const SQUARE_API_BASE = Deno.env.get("SQUARE_ENVIRONMENT") === "sandbox"
  ? "https://connect.squareupsandbox.com"
  : "https://connect.squareup.com";
const SQUARE_VERSION = "2025-01-23";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const BOOKING_EMAIL_FROM = Deno.env.get("BOOKING_EMAIL_FROM") ?? "Wisdominds Barbers <onboarding@resend.dev>";
const SHOP_TIMEZONE = "America/Toronto";
const SHOP_NAME = "Wisdominds Barbers & Braiders";
const SHOP_ADDRESS = "2400 Finch Ave W, Unit 5, North York, ON";
const SHOP_PHONE = "(416) 844-8287";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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

async function squareFetch(path: string, init?: RequestInit) {
  return fetch(`${SQUARE_API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SQUARE_ACCESS_TOKEN}`,
      "Square-Version": SQUARE_VERSION,
      ...(init?.headers ?? {}),
    },
  });
}

function isEmail(s: string) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
}

function formatWhen(iso: string) {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat("en-CA", {
    weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: SHOP_TIMEZONE,
  }).format(d);
  const time = new Intl.DateTimeFormat("en-CA", {
    hour: "numeric", minute: "2-digit", timeZone: SHOP_TIMEZONE,
  }).format(d);
  return `${date} at ${time}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid request body" }, 400);
  }

  // A service is identified either by a Square catalog variation (preferred,
  // enables real Square appointments) or by a Supabase services row id (used
  // when the menu came from the Supabase fallback catalog).
  const { providerId, variationId, serviceId, startAt, guestName, guestEmail, sourceId, verificationToken } = body;
  if (!providerId || (!variationId && !serviceId) || !startAt || !guestName || !guestEmail || !sourceId) {
    return jsonResponse({ error: "Missing required booking details." }, 400);
  }
  if (!isEmail(String(guestEmail))) {
    return jsonResponse({ error: "Please enter a valid email address." }, 400);
  }

  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // Barber must be a real Supabase provider for this property.
  const { data: provider, error: providerError } = await adminClient
    .from("providers")
    .select("id, display_name, property")
    .eq("id", providerId)
    .single();
  if (providerError || !provider || provider.property !== "barbers") {
    return jsonResponse({ error: "That barber isn't available." }, 404);
  }

  if (!SQUARE_ACCESS_TOKEN) {
    return jsonResponse({ error: "Payments aren't set up yet — please call the shop to book." }, 503);
  }

  // Re-price + re-name the service server-side so the charged amount can't be
  // tampered with client-side. Two sources: the Square catalog (by variation,
  // which also lets us create a real Square appointment) or the Supabase
  // services table (fallback catalog — charge only, no Square appointment).
  let priceCents = 0;
  let currency = "CAD";
  let durationMin = 30;
  let variationVersion: number | null = null;
  let serviceName = "Barbershop Service";

  if (variationId) {
    const catRes = await squareFetch(
      `/v2/catalog/object/${encodeURIComponent(variationId)}?include_related_objects=true`,
      { method: "GET" },
    );
    const catData = await catRes.json();
    if (!catRes.ok || !catData.object?.item_variation_data) {
      return jsonResponse({ error: "That service is no longer available." }, 404);
    }
    const variation = catData.object;
    const vData = variation.item_variation_data;
    priceCents = vData.price_money?.amount ?? 0;
    currency = vData.price_money?.currency ?? "CAD";
    durationMin = vData.service_duration ? Math.round(vData.service_duration / 60000) : 30;
    variationVersion = variation.version;
    const parentItem = (catData.related_objects ?? []).find(
      (o: any) => o.type === "ITEM" && o.id === vData.item_id,
    );
    serviceName = parentItem?.item_data?.name ?? "Barbershop Service";
  } else {
    const { data: svc, error: svcError } = await adminClient
      .from("services")
      .select("name, price_cents, duration_minutes, property")
      .eq("id", serviceId)
      .single();
    if (svcError || !svc || svc.property !== "barbers") {
      return jsonResponse({ error: "That service is no longer available." }, 404);
    }
    priceCents = svc.price_cents;
    durationMin = svc.duration_minutes;
    serviceName = svc.name;
  }

  const startDate = new Date(startAt);
  if (isNaN(startDate.getTime())) {
    return jsonResponse({ error: "Invalid appointment time." }, 400);
  }
  const endDate = new Date(startDate.getTime() + durationMin * 60000);

  // Reserve the slot first. The bookings_no_overlap exclusion constraint
  // rejects (Postgres 23P01) if this provider already has an overlapping
  // pending/confirmed booking — so two people can't pay for the same slot.
  const { data: booking, error: bookingError } = await adminClient
    .from("bookings")
    .insert({
      provider_id: providerId,
      student_profile_id: null,
      service_id: serviceId ?? null,
      square_variation_id: variationId ?? null,
      service_name: serviceName,
      service_price_cents: priceCents,
      guest_name: String(guestName).trim(),
      guest_email: String(guestEmail).trim(),
      slot_start: startDate.toISOString(),
      slot_end: endDate.toISOString(),
      status: "pending",
    })
    .select("id")
    .single();
  if (bookingError || !booking) {
    if (bookingError?.code === "23P01") {
      return jsonResponse({ error: "Sorry, that time was just booked. Please pick another." }, 409);
    }
    return jsonResponse({ error: "Couldn't hold that time. Please try again." }, 500);
  }

  // Charge the card. On any failure, release the reserved slot.
  const payRes = await squareFetch("/v2/payments", {
    method: "POST",
    body: JSON.stringify({
      idempotency_key: crypto.randomUUID(),
      source_id: sourceId,
      ...(verificationToken ? { verification_token: verificationToken } : {}),
      amount_money: { amount: priceCents, currency },
      location_id: SQUARE_LOCATION_ID,
      buyer_email_address: String(guestEmail).trim(),
      note: `${serviceName} with ${provider.display_name} — booking ${booking.id}`,
    }),
  });
  const payData = await payRes.json();
  if (!payRes.ok || payData.payment?.status === "FAILED") {
    await adminClient.from("bookings").delete().eq("id", booking.id);
    return jsonResponse(
      { error: payData.errors?.[0]?.detail ?? "Your card was declined. Please try another card." },
      402,
    );
  }
  const payment = payData.payment;

  // Record the payment (unique on booking_id) as paid.
  await adminClient.from("payments").upsert(
    {
      booking_id: booking.id,
      square_payment_link_id: payment.id,
      square_order_id: payment.order_id ?? null,
      amount_cents: priceCents,
      status: "paid",
      paid_at: new Date().toISOString(),
    },
    { onConflict: "booking_id" },
  );

  // Best-effort: put the appointment on the Square calendar. Only possible
  // when the service came from the Square catalog (we have a variation +
  // version); the Supabase fallback catalog has no Square variation, so we
  // skip the calendar and keep the confirmed Supabase booking + paid record.
  // Even with a variation this needs a customer and (for seller-level create)
  // an Appointments Plus/Premium subscription; a failure never blocks the
  // customer.
  let squareBookingId: string | null = null;
  if (variationId && variationVersion) try {
    let customerId: string | null = null;
    const custSearch = await squareFetch("/v2/customers/search", {
      method: "POST",
      body: JSON.stringify({
        query: { filter: { email_address: { exact: String(guestEmail).trim() } } },
        limit: 1,
      }),
    });
    const custSearchData = await custSearch.json();
    customerId = custSearchData.customers?.[0]?.id ?? null;
    if (!customerId) {
      const nameParts = String(guestName).trim().split(/\s+/);
      const custRes = await squareFetch("/v2/customers", {
        method: "POST",
        body: JSON.stringify({
          idempotency_key: crypto.randomUUID(),
          given_name: nameParts[0] ?? String(guestName).trim(),
          family_name: nameParts.slice(1).join(" ") || undefined,
          email_address: String(guestEmail).trim(),
        }),
      });
      const custData = await custRes.json();
      customerId = custData.customer?.id ?? null;
    }

    if (customerId) {
      const bookRes = await squareFetch("/v2/bookings", {
        method: "POST",
        body: JSON.stringify({
          idempotency_key: crypto.randomUUID(),
          booking: {
            location_id: SQUARE_LOCATION_ID,
            start_at: startDate.toISOString(),
            customer_id: customerId,
            customer_note: `Barber: ${provider.display_name} — booked & paid via website`,
            appointment_segments: [
              {
                team_member_id: SQUARE_BOOKING_TEAM_MEMBER_ID,
                service_variation_id: variationId,
                service_variation_version: variationVersion,
              },
            ],
          },
        }),
      });
      const bookData = await bookRes.json();
      squareBookingId = bookData.booking?.id ?? null;
    }
  } catch {
    // Calendar sync is optional; ignore and keep the confirmed booking.
  }

  await adminClient
    .from("bookings")
    .update({ status: "confirmed", square_booking_id: squareBookingId })
    .eq("id", booking.id);

  // Best-effort confirmation email.
  if (RESEND_API_KEY) {
    try {
      const when = formatWhen(startDate.toISOString());
      const price = `$${(priceCents / 100).toFixed(2)} ${currency}`;
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: BOOKING_EMAIL_FROM,
          to: [String(guestEmail).trim()],
          subject: `Booking confirmed — ${serviceName} at ${SHOP_NAME}`,
          html: `
            <div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:0 auto;color:#1b2333">
              <h2 style="color:#0f172a">You're booked in 💈</h2>
              <p>Hi ${String(guestName).trim()}, your appointment at <strong>${SHOP_NAME}</strong> is confirmed and paid.</p>
              <table style="width:100%;border-collapse:collapse;margin:20px 0">
                <tr><td style="padding:8px 0;color:#5b6478">Service</td><td style="padding:8px 0;text-align:right"><strong>${serviceName}</strong></td></tr>
                <tr><td style="padding:8px 0;color:#5b6478">Barber</td><td style="padding:8px 0;text-align:right">${provider.display_name}</td></tr>
                <tr><td style="padding:8px 0;color:#5b6478">When</td><td style="padding:8px 0;text-align:right">${when}</td></tr>
                <tr><td style="padding:8px 0;color:#5b6478">Paid</td><td style="padding:8px 0;text-align:right"><strong>${price}</strong></td></tr>
              </table>
              <p style="color:#5b6478;font-size:14px">${SHOP_ADDRESS} · ${SHOP_PHONE}</p>
              <p style="color:#5b6478;font-size:13px">Need to change or cancel? Give us a call and we'll sort it out.</p>
            </div>`,
        }),
      });
    } catch {
      // Email is a courtesy; never fail the booking over it.
    }
  }

  return jsonResponse(
    {
      ok: true,
      booking: {
        id: booking.id,
        serviceName,
        providerName: provider.display_name,
        startAt: startDate.toISOString(),
        priceCents,
        currency,
        durationMin,
        squareAppointmentCreated: Boolean(squareBookingId),
        emailSent: Boolean(RESEND_API_KEY),
      },
    },
    200,
  );
});
