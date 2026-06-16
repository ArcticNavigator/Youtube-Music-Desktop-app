import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// whoami — echo the caller's public IP (Phase 2, item #5, location)
// ═══════════════════════════════════════════════════════════════════════════════
//
// So the sidecar can resolve approximate location WITHOUT sending the IP to a
// third-party geolocation service: this returns the caller's public IP (which only
// ever reaches OUR own Supabase, which already sees it on every request), and the
// sidecar then looks the city/region/country up locally against the bundled DB-IP
// .mmdb. No DB access, no token needed. Deploy with "Verify JWT" = OFF.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve((req) => {
  const xff = req.headers.get("x-forwarded-for") || "";
  const ip = xff.split(",")[0].trim();
  return json({ ip });
});
