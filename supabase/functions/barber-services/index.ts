// Read-only: returns the barbershop's real bookable services straight from
// the Square catalog (APPOINTMENTS_SERVICE items), so the guest booking
// wizard shows correct names, prices, and durations without duplicating the
// catalog into Supabase. Called from the browser with the Supabase anon key.

const SQUARE_ACCESS_TOKEN = Deno.env.get("SQUARE_ACCESS_TOKEN");
const SQUARE_API_BASE = Deno.env.get("SQUARE_ENVIRONMENT") === "sandbox"
  ? "https://connect.squareupsandbox.com"
  : "https://connect.squareup.com";
const SQUARE_VERSION = "2025-01-23";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info, x-supabase-api-version",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (!SQUARE_ACCESS_TOKEN) {
    return jsonResponse({ error: "Square isn't configured yet." }, 503);
  }

  // Pull all appointment services.
  const itemsRes = await squareFetch("/v2/catalog/search-catalog-items", {
    method: "POST",
    body: JSON.stringify({ product_types: ["APPOINTMENTS_SERVICE"], limit: 100 }),
  });
  const itemsData = await itemsRes.json();
  if (!itemsRes.ok) {
    return jsonResponse(
      { error: itemsData.errors?.[0]?.detail ?? "Couldn't load services from Square." },
      502,
    );
  }

  // Resolve image ids → urls in one pass so cards can show real photos.
  const imageMap: Record<string, string> = {};
  try {
    const imgRes = await squareFetch("/v2/catalog/list?types=IMAGE", { method: "GET" });
    const imgData = await imgRes.json();
    (imgData.objects ?? []).forEach((o: any) => {
      if (o.id && o.image_data?.url) imageMap[o.id] = o.image_data.url;
    });
  } catch {
    // Images are a nice-to-have; the wizard falls back to a local photo.
  }

  const services = (itemsData.items ?? [])
    .map((item: any) => {
      const variation = item.item_data?.variations?.[0];
      const v = variation?.item_variation_data;
      if (!v || v.available_for_booking !== true) return null;
      const imageId = item.item_data?.image_ids?.[0];
      return {
        itemId: item.id,
        variationId: variation.id,
        variationVersion: variation.version,
        name: item.item_data?.name ?? "Service",
        description: item.item_data?.description_plaintext ?? item.item_data?.description ?? "",
        priceCents: v.price_money?.amount ?? 0,
        currency: v.price_money?.currency ?? "CAD",
        durationMin: v.service_duration ? Math.round(v.service_duration / 60000) : 30,
        imageUrl: imageId ? imageMap[imageId] ?? null : null,
      };
    })
    .filter(Boolean)
    // Cheapest / shortest first feels natural for a services menu.
    .sort((a: any, b: any) => a.priceCents - b.priceCents);

  return jsonResponse({ services }, 200);
});
