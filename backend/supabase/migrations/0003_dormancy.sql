-- ═══════════════════════════════════════════════════════════════════════════════
-- 0003_dormancy.sql — 6-month retention sweep + anonymous churn log (Phase 2, #7)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Storage-limitation duty (GDPR 5(1)(e), DPDP 8(7)): accounts inactive for 6 months
-- are permanently erased. last_active_at is bumped by the app on each launch/sign-in
-- (see first-login Edge Function). A daily pg_cron job erases lapsed rows and records
-- an ANONYMOUS churn row (country + date only — never name/email/sub) so departures
-- can be counted indefinitely without keeping an identifiable "departed users" list.
--
-- PREREQUISITE: enable the pg_cron extension once in
--   Dashboard → Database → Extensions → search "pg_cron" → enable.
-- (The CREATE EXTENSION below also works if your role is allowed.)

create extension if not exists pg_cron;

-- Anonymous churn counter — no PII, safe to keep forever.
create table if not exists public.churn_events (
  id      bigint generated always as identity primary key,
  event   text not null default 'dormant_erased',
  at      timestamptz not null default now(),
  country text                                   -- coarse only; may be null
);
alter table public.churn_events enable row level security;   -- no client policies → service_role only
revoke all on public.churn_events from anon, authenticated;

-- Erase PII for rows dormant > 6 months, logging an anonymous churn row for each.
create or replace function public.sweep_dormant()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  swept integer;
begin
  with gone as (
    delete from public.first_login
    where last_active_at < now() - interval '6 months'
    returning location_country
  ), logged as (
    insert into public.churn_events (event, at, country)
    select 'dormant_erased', now(), location_country from gone
    returning 1
  )
  select count(*)::int into swept from logged;
  return swept;
end;
$$;

-- Daily at 03:17 UTC. Re-running this migration replaces the schedule cleanly.
select cron.unschedule('dormancy-sweep')
  where exists (select 1 from cron.job where jobname = 'dormancy-sweep');
select cron.schedule('dormancy-sweep', '17 3 * * *', $$select public.sweep_dormant()$$);
