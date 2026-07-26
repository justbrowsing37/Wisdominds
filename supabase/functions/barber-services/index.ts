import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Returns the barbershop's bookable services for the guest wizard.
// Preference order:
//   1. The live Square catalog (real names/prices/durations/photos), when a
//      Square access token is configured and the catalog has services.
//   2. Otherwise the Supabase `services` table (property = 'barbers'), so the
//      menu still works during setup, in Square Sandbox (whose catalog is
//      empty), or if Square is briefly unreachable.
// Called from the browser with the Supabase anon key.

const SQUARE_ACCESS_TOKEN = Deno.env.get("SQUARE_ACCESS_TOKEN");
const SQUARE_API_BASE = Deno.env.get("SQUARE_ENVIRONMENT") === "sandbox"
  ? "https://connect.squareupsandbox.com"
  : "https://connect.squareup.com";
const SQUARE_VERSION = "2025-01-23";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

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

// Live Square catalog. Returns [] on any problem so the caller can fall back.
async function servicesFromSquare(): Promise<any[]> {
  if (!SQUARE_ACCESS_TOKEN) return [];
  try {
    const itemsRes = await squareFetch("/v2/catalog/search-catalog-items", {
      method: "POST",
      body: JSON.stringify({ product_types: ["APPOINTMENTS_SERVICE"], limit: 100 }),
    });
    const itemsData = await itemsRes.json();
    if (!itemsRes.ok) return [];

    const imageMap: Record<string, string> = {};
    try {
      const imgRes = await squareFetch("/v2/catalog/list?types=IMAGE", { method: "GET" });
      const imgData = await imgRes.json();
      (imgData.objects ?? []).forEach((o: any) => {
        if (o.id && o.image_data?.url) imageMap[o.id] = o.image_data.url;
      });
    } catch { /* images optional */ }

    return (itemsData.items ?? [])
      .map((item: any) => {
        const variation = item.item_data?.variations?.[0];
        const v = variation?.item_variation_data;
        if (!v || v.available_for_booking !== true) return null;
        const imageId = item.item_data?.image_ids?.[0];
        return {
          source: "square",
          serviceId: null,
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
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Supabase `services` catalog fallback (property = 'barbers').
async function servicesFromSupabase(): Promise<any[]> {
  try {
    const db = createClient(SUPABASE_URL, ANON_KEY);
    const { data, error } = await db
      .from("services")
      .select("id, name, duration_minutes, price_cents, category")
      .eq("property", "barbers");
    if (error || !data) return [];
    return data.map((s: any) => ({
      source: "supabase",
      serviceId: s.id,
      variationId: null,
      variationVersion: null,
      name: s.name,
      description: s.category ?? "",
      priceCents: s.price_cents,
      currency: "CAD",
      durationMin: s.duration_minutes,
      imageUrl: null,
    }));
  } catch {
    return [];
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  let services = await servicesFromSquare();
  let source = "square";
  if (!services.length) {
    services = await servicesFromSupabase();
    source = "supabase";
  }

  if (!services.length) {
    return jsonResponse({ error: "No services are set up for online booking yet." }, 503);
  }

  // Cheapest first feels natural for a services menu.
  services.sort((a: any, b: any) => a.priceCents - b.priceCents);
  return jsonResponse({ services, source }, 200);
});
