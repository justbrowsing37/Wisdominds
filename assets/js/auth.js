async function getSession() {
  const { data } = await supabaseClient.auth.getSession();
  return data.session;
}

async function getProfile(authUserId) {
  const { data, error } = await supabaseClient
    .from("profiles")
    .select("id, role, name, property")
    .eq("auth_user_id", authUserId)
    .single();
  if (error) return null;
  return data;
}

function portalPathForRole(role) {
  if (role === "admin") return "admin-portal.html";
  if (role === "teacher") return "teacher-portal.html";
  return "student-portal.html";
}

// Only ever follow a same-page relative link (e.g. "student-portal.html?
// property=barbers"), never an absolute URL/other host — otherwise a
// crafted "?next=" could turn login.html into an open redirect. Also
// reject login.html/register.html themselves, since honoring those as a
// destination would just bounce straight back into redirectIfSignedIn()
// and loop.
function sanitizeNextPath(path) {
  if (!path) return null;
  if (path.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(path)) return null;
  var bare = path.split("?")[0].split("#")[0];
  if (bare === "" || bare === "login.html" || bare === "register.html") return null;
  return path;
}

function currentPathWithQuery() {
  return window.location.pathname.split("/").pop() + window.location.search;
}

// Shared by redirectIfSignedIn() and login.html/register.html's own
// post-auth handlers so "where do we send a signed-in user" stays in one
// place: honor an explicit ?next= (e.g. the booking page someone was
// bounced from) over the default portal-for-role.
function destinationAfterAuth(profile) {
  var next = sanitizeNextPath(new URLSearchParams(window.location.search).get("next"));
  return next || (profile ? portalPathForRole(profile.role) : "index.html");
}

// Call on login.html/register.html so an already-signed-in visitor gets
// routed straight to their portal (or ?next= destination) instead of
// seeing the auth form again.
async function redirectIfSignedIn() {
  const session = await getSession();
  if (!session) return;
  const profile = await getProfile(session.user.id);
  window.location.href = destinationAfterAuth(profile);
}

// Call at the top of a portal page. Redirects to login.html if there's no
// session, or if the signed-in role doesn't match what the page expects.
async function requireRole(expectedRoles) {
  const session = await getSession();
  if (!session) {
    window.location.href = "login.html?next=" + encodeURIComponent(currentPathWithQuery());
    return null;
  }
  const profile = await getProfile(session.user.id);
  if (!profile) {
    // Session exists but we couldn't load a profile — don't preserve
    // ?next= here: if the profile lookup keeps failing, honoring it would
    // bounce back to this same page after "login" and loop forever. Send
    // to a plain login instead, which is terminal (redirectIfSignedIn
    // falls back to index.html when profile is still null).
    window.location.href = "login.html";
    return null;
  }
  if (!expectedRoles.includes(profile.role)) {
    window.location.href = portalPathForRole(profile.role);
    return null;
  }
  return profile;
}

async function signOut() {
  await supabaseClient.auth.signOut();
  window.location.href = "login.html";
}

// Supabase persists the session in localStorage, so signing out in one tab
// fires a SIGNED_OUT event in every other open tab on this site too. Without
// this, a stale tab keeps showing booking/availability forms and only finds
// out its session is dead when a write fails with a generic RLS error. Only
// portal pages need to be bounced to login on that — index.html/barbers.html
// /music.html are public pages that also load auth.js just to check session
// state for the nav, and shouldn't be yanked to login.html when someone
// signs out elsewhere.
var PORTAL_PAGES = ["student-portal.html", "teacher-portal.html", "admin-portal.html"];
supabaseClient.auth.onAuthStateChange(function (event) {
  var page = window.location.pathname.split("/").pop();
  if (event === "SIGNED_OUT" && PORTAL_PAGES.includes(page)) {
    window.location.href = "login.html";
  }
});
