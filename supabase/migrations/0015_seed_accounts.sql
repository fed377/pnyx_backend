-- PNYX — seed accounts
--
-- `scripts/seed/load.ts` creates persona accounts that post, vote, follow and
-- comment through PnyxService exactly like real users, so their positions are
-- derived rather than written. This column is what tells them apart from real
-- people afterwards: `scripts/seed/clean.ts` deletes by it, and analytics can
-- exclude by it.

alter table profiles add column if not exists is_seed boolean not null default false;

create index if not exists profiles_is_seed_idx on profiles (is_seed) where is_seed;

-- is_seed is privileged: clean.ts deletes every account carrying it, so a user
-- flipping it on themselves through PostgREST (profiles_write_own allows any
-- column) would be volunteering their account for deletion — and flipping it
-- off would hide a seed account from cleanup. Same rule as 0011's columns.
create or replace function protect_privileged_profile_columns()
returns trigger
language plpgsql
as $$
begin
  if current_user <> 'service_role' then
    if new.premium is distinct from old.premium
       or new.privacy_tier is distinct from old.privacy_tier
       or new.tier_changed_at is distinct from old.tier_changed_at
       or new.is_seed is distinct from old.is_seed then
      raise exception 'privacy_tier, premium, tier_changed_at and is_seed can only be changed by the API';
    end if;
  end if;
  return new;
end;
$$;

-- Seeding happens in minutes, so every post, vote and comment would otherwise
-- be timestamped "just now". The loader computes a believable timeline itself
-- (it keeps each voter's votes in the order they were cast, which is all the
-- decay replay depends on) and applies it here in bulk.
--
-- Every update is restricted to rows owned by a seed account, so even a buggy
-- payload cannot rewrite a real user's history.
create or replace function seed_apply_timeline(
  content_rows  jsonb default '[]'::jsonb,  -- [{ "id": uuid, "at": timestamptz }]
  vote_rows     jsonb default '[]'::jsonb,  -- [{ "user_id": uuid, "content_id": uuid, "at": timestamptz }]
  comment_rows  jsonb default '[]'::jsonb,  -- [{ "id": uuid, "at": timestamptz }]
  profile_rows  jsonb default '[]'::jsonb   -- [{ "id": uuid, "at": timestamptz }]
) returns void
language plpgsql security definer set search_path = public as $$
begin
  update content c set created_at = r.at
    from jsonb_to_recordset(content_rows) as r(id uuid, at timestamptz), profiles p
   where c.id = r.id and p.id = c.author_id and p.is_seed;

  update votes v set created_at = r.at
    from jsonb_to_recordset(vote_rows) as r(user_id uuid, content_id uuid, at timestamptz), profiles p
   where v.user_id = r.user_id and v.content_id = r.content_id and p.id = v.user_id and p.is_seed;

  update comments c set created_at = r.at
    from jsonb_to_recordset(comment_rows) as r(id uuid, at timestamptz), profiles p
   where c.id = r.id and p.id = c.author_id and p.is_seed;

  update profiles p set created_at = r.at
    from jsonb_to_recordset(profile_rows) as r(id uuid, at timestamptz)
   where p.id = r.id and p.is_seed;
end;
$$;

-- Functions in `public` are executable by anon/authenticated by default, and
-- this one is security definer. Only the backend's service role may call it.
revoke execute on function seed_apply_timeline(jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function seed_apply_timeline(jsonb, jsonb, jsonb, jsonb) to service_role;

-- ── Unrelated hardening: forget_me ─────────────────────────────────────────
-- forget_me (0001_init.sql) is security definer and deletes whichever auth
-- user it is given, but was never revoked from the default roles — so anyone
-- holding the anon key could POST /rest/v1/rpc/forget_me with any user's id
-- (profile ids are publicly readable) and delete that account. Only the API,
-- via PnyxService.forgetMe with the service-role key, may call it.
revoke execute on function forget_me(uuid) from public, anon, authenticated;
grant execute on function forget_me(uuid) to service_role;

-- ── Unrelated hardening: votes are read-only to their owner ────────────────
-- votes_own (0001_init.sql) was `for all`, letting a signed-in user insert or
-- update their own vote rows straight through PostgREST — scores_snapshot and
-- created_at included. recomputePositions replays exactly those rows, so a
-- forged snapshot would steer the user's position on their next real vote:
-- a client asserting its own position by the back door. Every legitimate
-- write goes through the API's service role (castVote), which RLS doesn't
-- apply to, so the owner only ever needs to read.
drop policy if exists votes_own on votes;
create policy votes_own on votes
  for select to authenticated using (user_id = auth.uid());
