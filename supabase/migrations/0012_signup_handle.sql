-- The create-account screen now lets someone pick their handle at signup
-- (with live availability checking client-side) instead of getting a
-- derived-from-email placeholder to edit later in Onboarding. The chosen
-- handle travels through auth.signUp()'s user_metadata (same way `name`
-- already does), so this trigger just prefers it when present.
--
-- Falls back to the original email-derived candidate if the metadata handle
-- is missing, empty, or too short — and the existing collision loop below
-- still applies to whichever base is chosen, so a handle that lost a race
-- with someone else since the client's availability check gets a numeric
-- suffix instead of failing signup outright.

create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  base      text;
  candidate text;
  n         integer := 0;
begin
  base := lower(regexp_replace(coalesce(new.raw_user_meta_data ->> 'handle', ''), '[^a-z0-9._]', '', 'g'));
  if base is null or length(base) < 2 then
    base := lower(regexp_replace(coalesce(split_part(new.email, '@', 1), 'pnyx'), '[^a-z0-9._]', '', 'g'));
  end if;
  if base is null or base = '' then
    base := 'pnyx';
  end if;
  base := left(base, 20);

  candidate := base;
  while exists (select 1 from profiles p where p.handle = candidate) loop
    n := n + 1;
    candidate := base || n::text;
  end loop;

  insert into profiles (id, handle, name)
  values (new.id, candidate, coalesce(new.raw_user_meta_data ->> 'name', ''));

  -- Start them at the origin so /me has something to read before the first vote.
  insert into grid_positions (user_id) values (new.id);

  return new;
end;
$$;
