-- PNYX — content-moderation strikes
--
-- The content scorer (spec §8) doubles as the moderation gate: a post that
-- violates policy (as opposed to one that's merely low-effort/meaningless,
-- which is rejected but not a strike) logs one of these against its author.
-- Kept as its own table, not a counter column on profiles, since the reason
-- text matters for a human moderator reviewing repeat offenders.

create table if not exists moderation_strikes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles on delete cascade,
  reason     text not null,
  created_at timestamptz not null default now()
);

create index if not exists moderation_strikes_user_idx on moderation_strikes (user_id, created_at desc);

alter table moderation_strikes enable row level security;

-- A user can see their own strike history; nobody else can, and nobody can
-- insert one directly — only the service role (via record_strike) may.
drop policy if exists moderation_strikes_own on moderation_strikes;
create policy moderation_strikes_own on moderation_strikes
  for select to authenticated using (user_id = auth.uid());

create or replace function record_strike(target uuid, why text) returns integer
language plpgsql set search_path = public as $$
declare
  total integer;
begin
  insert into moderation_strikes (user_id, reason) values (target, why);
  select count(*) into total from moderation_strikes where user_id = target;
  return total;
end;
$$;
