import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

// Same CORS/auth shape as admin-provision-account — see the comment there
// for why every one of these headers has to be present or the browser's
// preflight silently eats the real request.
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

  const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await callerClient.auth.getUser();
  if (userError || !userData.user) {
    return jsonResponse({ error: "Not authenticated" }, 401);
  }

  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: callerProfile } = await adminClient
    .from("profiles")
    .select("id, role")
    .eq("auth_user_id", userData.user.id)
    .single();
  if (!callerProfile || callerProfile.role !== "admin") {
    return jsonResponse({ error: "Admin access required" }, 403);
  }

  let body: { profile_id?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid request body" }, 400);
  }

  const { profile_id } = body;
  if (!profile_id) {
    return jsonResponse({ error: "profile_id is required" }, 400);
  }
  if (profile_id === callerProfile.id) {
    return jsonResponse({ error: "You can't delete your own account" }, 400);
  }

  const { data: target, error: targetError } = await adminClient
    .from("profiles")
    .select("id, auth_user_id")
    .eq("id", profile_id)
    .single();
  if (targetError || !target) {
    return jsonResponse({ error: "Account not found" }, 404);
  }

  // profiles/providers/availability/provider_services all cascade off the
  // auth.users delete below, but bookings.provider_id and
  // bookings.student_profile_id are deliberately NOT cascading (so a real
  // booking history survives an accidental profile edit) — which means a
  // leftover booking would block the profile delete with a FK violation
  // unless we clear those out first. payments cascade off bookings, so
  // deleting the booking rows here takes their payments with them too.
  const { data: provider } = await adminClient
    .from("providers")
    .select("id")
    .eq("profile_id", profile_id)
    .maybeSingle();

  if (provider) {
    await adminClient.from("bookings").delete().eq("provider_id", provider.id);
  }
  await adminClient.from("bookings").delete().eq("student_profile_id", profile_id);

  const { error: deleteError } = await adminClient.auth.admin.deleteUser(target.auth_user_id);
  if (deleteError) {
    return jsonResponse({ error: deleteError.message }, 500);
  }

  return jsonResponse({ ok: true }, 200);
});
