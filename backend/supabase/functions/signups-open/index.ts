import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// signups-open — is there room under the ≤100 cap? (Phase 2, item #4)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Returns { open, count }. The frontend hides "Sign in" and shows "sign-ups full —
// using guest mode" when open=false. This is only a UX hint; the real cap is enforced
// by the DB trigger. No user token needed (it leaks only an aggregate count).
// Deploy with "Verify JWT" = OFF.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async () => {
  // HEAD-style count via PostgREST: Prefer: count=exact + an empty range → the total
  // arrives in the Content-Range header ("0-0/NN") without transferring any rows.
  const r = await fetch(`${SUPABASE_URL}/rest/v1/first_login?select=user_sub`, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      Prefer: "count=exact",
      Range: "0-0",
    },
  });
  const cr = r.headers.get("content-range") || "";        // e.g. "0-0/42" or "*/0"
  const count = parseInt(cr.split("/")[1] || "0", 10) || 0;
  return json({ open: count < 100, count });
});
