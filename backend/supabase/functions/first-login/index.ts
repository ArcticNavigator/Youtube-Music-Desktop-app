import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// first-login — idempotent first-login record write (Phase 2, items #4/#5)
// ═══════════════════════════════════════════════════════════════════════════════
//
// The trust boundary. The sidecar POSTs the user's Google access token (+ already
// resolved coarse location + policy version). We verify the token against Google's
// userinfo endpoint to get the authenticated { sub, email, name }, then upsert-IGNORE
// into first_login using the service_role key (auto-injected by Supabase, never
// shipped in the app). First login creates the row; later logins are a no-op for the
// PII but bump last_active_at (dormancy signal). The DB trigger enforces the ≤100 cap.
//
// Deploy with "Verify JWT" = OFF — auth here is the Google token, not a Supabase JWT.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const svc = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function verifyGoogle(accessToken?: string) {
  if (!accessToken) return null;
  const r = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) return null;
  const u = await r.json();
  if (!u.sub || !u.email) return null;
  return { sub: String(u.sub), email: String(u.email), name: String(u.name ?? u.email) };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const body = await req.json().catch(() => ({}));
  const id = await verifyGoogle(body.access_token);
  if (!id) return json({ error: "invalid_token" }, 401);

  const now = new Date().toISOString();
  const row = {
    user_sub: id.sub,
    name: id.name,
    email: id.email,
    first_login_at: now,
    location_city: body.location_city ?? null,
    location_region: body.location_region ?? null,
    location_country: body.location_country ?? null,
    policy_version: String(body.policy_version ?? "1"),
    last_active_at: now,
  };

  // Insert, ignoring duplicates → "first login only". The BEFORE INSERT cap trigger
  // rejects the 101st brand-new user_sub (returning users are exempt).
  const res = await fetch(`${SUPABASE_URL}/rest/v1/first_login`, {
    method: "POST",
    headers: { ...svc, "Content-Type": "application/json", Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify(row),
  });

  if (!res.ok) {
    const detail = await res.text();
    if (detail.includes("signup_cap_reached")) return json({ error: "signups_full" }, 403);
    return json({ error: "db_error", detail }, 500);
  }
  const inserted = await res.json().catch(() => []);
  const created = Array.isArray(inserted) && inserted.length > 0;

  // Returning users: bump last_active_at (the dormancy signal) without touching PII.
  if (!created) {
    await fetch(`${SUPABASE_URL}/rest/v1/first_login?user_sub=eq.${encodeURIComponent(id.sub)}`, {
      method: "PATCH",
      headers: { ...svc, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ last_active_at: now }),
    });
  }
  return json({ ok: true, created });
});
