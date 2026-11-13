-- PNYX — seed batches
--
-- 0015's is_seed says an account is a seed persona, but not which seed run
-- made it, so clean.ts could only delete every seed at once. seed_batch names
-- the run ("old", "2026-12-cities", …): scripts/seed/load.ts stamps it from
-- the manifest, and `seed:clean --batch <name>` deletes just that run. Content,
-- votes and comments belong to their author, so tagging the account tags
-- everything it made.

alter table profiles add column if not exists seed_batch text
  check (seed_batch ~ '^[a-z0-9][a-z0-9-]{0,39}$');

-- Backfill: everything seeded before batches existed becomes batch "old" —
-- the 0015 pipeline's accounts, plus the older scripts/seed-supabase.ts ones
-- (@pnyx.local, never flagged is_seed). The privileged-column trigger only
-- lets the service role touch is_seed, so it's off for the backfill.
alter table profiles disable trigger profiles_protect_privileged_columns;

update profiles set seed_batch = 'old' where is_seed and seed_batch is null;

update profiles p set is_seed = true, seed_batch = 'old'
  from auth.users u
 where u.id = p.id and lower(u.email) like '%@pnyx.local' and not p.is_seed;

alter table profiles enable trigger profiles_protect_privileged_columns;

-- A seed account always names its batch, and only seed accounts have one, so
-- nothing seeded from here on can be left untagged.
alter table profiles add constraint profiles_seed_batch_iff_seed
  check (is_seed = (seed_batch is not null));

create index if not exists profiles_seed_batch_idx on profiles (seed_batch) where seed_batch is not null;

-- Same rule as is_seed: clean.ts deletes by it, so only the API may set it.
create or replace function protect_privileged_profile_columns()
returns trigger
language plpgsql
as $$
begin
  if current_user <> 'service_role' then
    if new.premium is distinct from old.premium
       or new.privacy_tier is distinct from old.privacy_tier
       or new.tier_changed_at is distinct from old.tier_changed_at
       or new.is_seed is distinct from old.is_seed
       or new.seed_batch is distinct from old.seed_batch then
      raise exception 'privacy_tier, premium, tier_changed_at, is_seed and seed_batch can only be changed by the API';
    end if;
  end if;
  return new;
end;
$$;
