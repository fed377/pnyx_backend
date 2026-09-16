-- Security audit finding (high): profiles_write_own (0001_init.sql) lets a user
-- update any column on their own row, with no restriction. Every rule that's
-- supposed to gate privacy_tier/premium/tier_changed_at lives only in
-- PnyxService (premium can't be self-granted, Speaker requires unlock, the
-- 30-day tier-change cooldown) — none of it is backed by the database. A
-- request straight to PostgREST with a user's own access token, bypassing the
-- API entirely, could set premium=true or reset tier_changed_at directly.
--
-- The API itself writes these columns through the service-role key, which
-- connects as the literal `service_role` Postgres role and is therefore
-- unaffected by this trigger (RLS predicates don't apply to triggers, so the
-- role check below is what distinguishes "the API" from "a direct client
-- request" — not RLS itself).

create or replace function protect_privileged_profile_columns()
returns trigger
language plpgsql
as $$
begin
  if current_user <> 'service_role' then
    if new.premium is distinct from old.premium
       or new.privacy_tier is distinct from old.privacy_tier
       or new.tier_changed_at is distinct from old.tier_changed_at then
      raise exception 'privacy_tier, premium and tier_changed_at can only be changed by the API';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_protect_privileged_columns on profiles;
create trigger profiles_protect_privileged_columns
  before update on profiles
  for each row
  execute function protect_privileged_profile_columns();
