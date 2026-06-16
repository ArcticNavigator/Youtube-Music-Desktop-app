-- ═══════════════════════════════════════════════════════════════════════════════
-- 0001_first_login.sql — the compliant first-login record (Phase 2, item #4)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- One row per registered account, written ONCE on the user's first successful
-- sign-in (after the pre-sign-in transparency notice). See docs/plans/phase2-auth.md
-- Part B for the lawful-basis / minimization rationale.
--
-- ACCESS MODEL: this app authenticates with Google (not Supabase Auth), so there is
-- no Supabase JWT carrying the user's id. We therefore lock the table down with RLS
-- that grants NO policies to anon/authenticated — i.e. the client (anon key) cannot
-- read or write it at all. Only our Edge Functions, which run with the service_role
-- key (kept server-side, never shipped), touch this table. The Edge Function is the
-- trust boundary: it verifies the caller's Google access token, then acts as them.

create table if not exists public.first_login (
  user_sub         text primary key,            -- Google 'sub' (stable, non-email id)
  name             text not null,
  email            text not null,
  first_login_at   timestamptz not null,        -- UTC, source of truth (UI renders local)
  location_city    text,                         -- coarse only; nullable (may be deferred)
  location_region  text,
  location_country text,
  policy_version   text not null,               -- privacy notice version shown at sign-in
  created_at       timestamptz not null default now(),
  last_active_at   timestamptz not null default now()  -- bumped each launch → drives dormancy (item #7)
);

-- RLS on, with NO client policies → anon/authenticated are denied everything.
-- service_role (Edge Functions) bypasses RLS. This is the intended lock.
alter table public.first_login enable row level security;

-- Defensive: make sure the anon/authenticated roles cannot reach the table even if
-- a policy is added later by mistake. (service_role is unaffected.)
revoke all on public.first_login from anon, authenticated;
