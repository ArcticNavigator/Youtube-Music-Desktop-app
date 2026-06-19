import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// feedback — store an in-app feedback / bug report / feature request / complaint
// ═══════════════════════════════════════════════════════════════════════════════
//
// The sidecar POSTs { type, message, email?, app_version?, platform?, diagnostics?,
// access_token? }. If a Google access_token is present we verify it (to link the
// account via user_sub and prefill the contact email), but it's OPTIONAL — guests
// can submit too, so a bug can be reported without signing in. We insert with the
// service_role key (auto-injected by Supabase, never shipped in the app).
//
// Deploy with "Verify JWT" = OFF — auth here is the optional Google token, not a
// Supabase JWT (matches first-login / me-data).

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const svc = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const TYPES = new Set(["bug", "feedback", "feature", "complaint"]);
const MAX_MESSAGE = 5000;

async function verifyGoogle(accessToken?: string) {
  if (!accessToken) return null;
  const r = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) return null;
  const u = await r.json();
  if (!u.sub) return null;
  return { sub: String(u.sub), email: u.email ? String(u.email) : null };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const body = await req.json().catch(() => ({}));
  const type = String(body.type ?? "").toLowerCase();
  const message = String(body.message ?? "").trim();
  if (!TYPES.has(type)) return json({ error: "invalid_type" }, 400);
  if (message.length < 1 || message.length > MAX_MESSAGE) {
    return json({ error: "invalid_message" }, 400);
  }

  // Optional identity — links the report to an account when signed in.
  const id = await verifyGoogle(body.access_token);
  const email =
    (typeof body.email === "string" && body.email.trim()
      ? body.email.trim()
      : id?.email) ?? null;

  const row = {
    type,
    message,
    email,
    user_sub: id?.sub ?? null,
    app_version: body.app_version ? String(body.app_version).slice(0, 64) : null,
    platform: body.platform ? String(body.platform).slice(0, 128) : null,
    // diagnostics is opt-in; pass through whatever the client built (already small).
    diagnostics: body.diagnostics ?? null,
  };

  const res = await fetch(`${SUPABASE_URL}/rest/v1/feedback`, {
    method: "POST",
    headers: { ...svc, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(row),
  });

  if (!res.ok) {
    const detail = await res.text();
    return json({ error: "db_error", detail }, 500);
  }
  return json({ ok: true });
});
