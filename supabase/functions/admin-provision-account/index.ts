import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

// Called directly from the browser via supabaseClient.functions.invoke, same
// as create-checkout — needs the same OPTIONS preflight response or the
// browser never sends the real POST. supabase-js also attaches its own
// x-client-info (and, on some versions, apikey/x-supabase-api-version)
// headers to every invoke() call — omitting any of those from the allow
// list makes the preflight fail silently, with no server-side log at all.
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

const ALLOWED_ROLES = ["student", "teacher"];
const ALLOWED_PROPERTIES = ["music", "barbers", "coop"];

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

  // Service-role client to check the caller's own role and, if authorized,
  // perform the privileged writes below. profiles.role/property are outside
  // the `authenticated` grant (see profiles_insert_role_lockdown.sql and the
  // column-restricted UPDATE grant in the init migration) for every caller
  // including admins, so this function — not RLS — is the actual boundary.
  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: callerProfile } = await adminClient
    .from("profiles")
    .select("role")
    .eq("auth_user_id", userData.user.id)
    .single();
  if (!callerProfile || callerProfile.role !== "admin") {
    return jsonResponse({ error: "Admin access required" }, 403);
  }

  let body: {
    mode?: string;
    email?: string;
    temp_password?: string;
    name?: string;
    phone?: string;
    property?: string;
    role?: string;
    profile_id?: string;
  };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid request body" }, 400);
  }

  const { mode, role, phone } = body;

  // Never trust role from the request beyond this whitelist — in
  // particular, "admin" is never accepted here, even though the UI never
  // offers it. Granting admin stays a deliberate action outside this path.
  if (!role || !ALLOWED_ROLES.includes(role)) {
    return jsonResponse({ error: "role must be student or teacher" }, 400);
  }

  if (mode === "update") {
    // Changing an existing member's role — same column-grant wall applies,
    // so this still has to go through the service-role client rather than
    // a plain client-side update from the admin's own session.
    const { profile_id } = body;
    if (!profile_id) {
      return jsonResponse({ error: "profile_id is required" }, 400);
    }
    const { data: profile, error: updateError } = await adminClient
      .from("profiles")
      .update({ role, phone: phone ?? null })
      .eq("id", profile_id)
      .select("id")
      .single();
    if (updateError || !profile) {
      return jsonResponse({ error: updateError?.message ?? "Role update failed" }, 500);
    }
    return jsonResponse({ profile_id: profile.id }, 200);
  }

  // Default / mode === "create": provision a brand-new account.
  const { email, temp_password, name, property } = body;
  if (!email || !temp_password || !name || !property) {
    return jsonResponse({ error: "email, temp_password, name, and property are required" }, 400);
  }
  if (!ALLOWED_PROPERTIES.includes(property)) {
    return jsonResponse({ error: "Invalid property" }, 400);
  }

  const { data: created, error: createError } = await adminClient.auth.admin.createUser({
    email,
    password: temp_password,
    email_confirm: true,
    user_metadata: { name, property },
  });
  if (createError || !created.user) {
    return jsonResponse({ error: createError?.message ?? "Failed to create account" }, 400);
  }

  // handle_new_user() has already inserted a profiles row defaulting to
  // role: 'student' with the property from user_metadata above — this is
  // the one update that needs the service-role client, since role isn't
  // authenticated-grantable even for an admin's own browser session.
  const { data: profile, error: updateError } = await adminClient
    .from("profiles")
    .update({ role, phone: phone ?? null })
    .eq("auth_user_id", created.user.id)
    .select("id")
    .single();
  if (updateError || !profile) {
    return jsonResponse({ error: updateError?.message ?? "Account created but role assignment failed" }, 500);
  }

  return jsonResponse({ profile_id: profile.id }, 200);
});
