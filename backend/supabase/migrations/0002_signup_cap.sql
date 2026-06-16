-- ═══════════════════════════════════════════════════════════════════════════════
-- 0002_signup_cap.sql — server-enforced ≤100 sign-up cap (Phase 2, item #4)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Google's unverified-production OAuth client allows ≤100 users; we mirror that as a
-- hard cap on first_login rows. Enforced in the DB so it can NEVER be bypassed by a
-- tampered client. Returning users are exempt: when the table is full, an existing
-- user_sub may still "re-insert" (a no-op via ON CONFLICT) and sign in, while a
-- brand-new user_sub is rejected. Erasing dormant rows (item #7) reclaims slots.

create or replace function public.enforce_signup_cap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select count(*) from public.first_login) >= 100
     and not exists (select 1 from public.first_login where user_sub = new.user_sub) then
    raise exception 'signup_cap_reached'
      using errcode = 'check_violation',
            hint = 'Sign-ups are full (100). Existing users can still sign in.';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_signup_cap on public.first_login;
create trigger trg_enforce_signup_cap
  before insert on public.first_login
  for each row execute function public.enforce_signup_cap();
