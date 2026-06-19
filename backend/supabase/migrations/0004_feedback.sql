-- ═══════════════════════════════════════════════════════════════════════════════
-- 0004_feedback.sql — in-app feedback / bug-report inbox
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- One row per submitted feedback / bug report / feature request / complaint. Written
-- by the `feedback` Edge Function (service_role), which the sidecar POSTs to. Same
-- access model as first_login: RLS on with NO client policies, so anon/authenticated
-- can neither read nor write — only the Edge Function (service_role) touches it.
--
-- Submissions are allowed for GUESTS too (user_sub null), so a bug can be reported
-- without signing in. `diagnostics` is an OPT-IN jsonb blob (recent in-app errors +
-- technical context like app version, OS, current screen) — only present when the
-- user ticked "include diagnostics"; never contains the YT Music cookie or PII.

create table if not exists public.feedback (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  type         text not null
                 check (type in ('bug', 'feedback', 'feature', 'complaint')),
  message      text not null
                 check (char_length(message) between 1 and 5000),
  email        text,                          -- optional contact; from account or typed
  user_sub     text,                          -- Google 'sub' when signed in; null = guest
  app_version  text,
  platform     text,                          -- e.g. "Windows 11"
  diagnostics  jsonb                          -- opt-in only; recent errors + context
);

-- Triage helpers.
create index if not exists feedback_created_at_idx on public.feedback (created_at desc);
create index if not exists feedback_type_idx on public.feedback (type);

-- RLS on, NO client policies → anon/authenticated denied everything. service_role
-- (the Edge Function) bypasses RLS. Defensive revoke mirrors first_login.
alter table public.feedback enable row level security;
revoke all on public.feedback from anon, authenticated;
