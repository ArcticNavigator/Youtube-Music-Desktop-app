import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// me-data — data-subject access & erasure (Phase 2, item #6)
// ═══════════════════════════════════════════════════════════════════════════════
//
//   GET    → export: returns the caller's own first_login row as JSON.
//   DELETE → erasure: hard-deletes the caller's row (no retention).
//
// Auth is the Google access token in the Authorization header; we verify it against
// Google userinfo to learn the caller's sub, then act ONLY on that sub (a user can
// never reach another user's row). service_role is auto-injected, never shipped.
// Deploy with "Verify JWT" = OFF.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const svc = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function verifyGoogle(accessToken?: string | null) {
  if (!accessToken) return null;
  const r = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) return null;
  const u = await r.json();
  if (!u.sub) return null;
  return { sub: String(u.sub) };
}

Deno.serve(async (req) => {
  // Read the Google token from a custom header first (so the Authorization header
  // stays free for a Supabase key when JWT verification is left on), falling back
  // to Authorization when the function is public. Works in both modes.
  const token = req.headers.get("X-Google-Token")
    || (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const id = await verifyGoogle(token);
  if (!id) return json({ error: "invalid_token" }, 401);
  const filter = `user_sub=eq.${encodeURIComponent(id.sub)}`;

  if (req.method === "GET") {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/first_login?${filter}`, { headers: svc });
    const rows = await r.json().catch(() => []);
    return json({ data: Array.isArray(rows) ? rows[0] ?? null : null });
  }

  if (req.method === "DELETE") {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/first_login?${filter}`, {
      method: "DELETE",
      headers: { ...svc, Prefer: "return=minimal" },
    });
    if (!r.ok) return json({ error: "db_error", detail: await r.text() }, 500);
    return json({ ok: true });
  }

  return json({ error: "method_not_allowed" }, 405);
});
