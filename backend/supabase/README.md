# Supabase backend — Phase 2 (first-login record)

This is the server side of the compliant first-login record. The desktop app never
holds the `service_role` key; all privileged DB access goes through the four Edge
Functions, which verify the caller's **Google** access token and act as that user.

## What's here
```
migrations/
  0001_first_login.sql   table + RLS (deny all client access; service_role only)
  0002_signup_cap.sql    BEFORE INSERT trigger enforcing the ≤100 cap
functions/
  first-login/           idempotent record write (verifies Google token)
  me-data/               GET export / DELETE erasure of the caller's own row
  signups-open/          { open, count } — is there room under the cap?
  whoami/                echoes the caller's public IP (for on-device geo)
```

## Deploy — no CLI needed (Supabase dashboard)

### 1. Apply the SQL  (Dashboard → SQL Editor → New query)
Paste and run, in order, **`0001_first_login.sql`** → **`0002_signup_cap.sql`** →
**`0003_dormancy.sql`**. Re-running any of them is safe (idempotent). The "destructive
operation" warning on `0002`/`0003` is expected (`drop trigger`/`revoke`) — click **Run**.

**Before `0003`:** enable **pg_cron** once — Dashboard → **Database → Extensions** → search
`pg_cron` → enable. (`0003` schedules the daily 6-month dormancy sweep + anonymous churn log.)

### 2. Create the 4 Edge Functions  (Dashboard → Edge Functions → Create a function)
For each of `first-login`, `me-data`, `signups-open`, `whoami`:
- Name it **exactly** as the folder.
- Paste the contents of that folder's `index.ts`.
- **Turn OFF "Verify JWT with legacy secret" / "Enforce JWT"** for the function — auth
  here is the Google token, not a Supabase JWT. (This is the single most important step;
  if it's left on, every call returns 401 before our code runs.)
- Deploy.

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are **auto-injected** into Edge Functions
by Supabase — you do **not** set any secrets.

### 3. Smoke-check (optional, from a terminal)
```
# room under the cap?
curl https://<PROJECT-REF>.supabase.co/functions/v1/signups-open
#   → {"open":true,"count":0}

# your public IP (used for on-device location)
curl https://<PROJECT-REF>.supabase.co/functions/v1/whoami
#   → {"ip":"<your.public.ip>"}

# first-login rejects a bad token (proves verification runs)
curl -X POST https://<PROJECT-REF>.supabase.co/functions/v1/first-login \
  -H "Content-Type: application/json" -d '{"access_token":"bogus"}'
#   → {"error":"invalid_token"}   (HTTP 401)
```

When those three respond as shown, the backend is live and I'll wire the sidecar +
frontend against it.

## Notes
- **Cap behaviour:** the trigger blocks the 101st *brand-new* `user_sub`; an existing
  user can always sign back in even when full. Erasing dormant rows (item #7) frees slots.
- **RLS:** `first_login` grants no policies to `anon`/`authenticated`, so the app's anon
  key can't read or write it. Only the Edge Functions (service_role) can.
