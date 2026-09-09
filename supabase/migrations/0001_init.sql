-- PNYX — initial schema (spec §7)
--
-- Apply with:  supabase db push        (against a hosted project, no Docker needed)
-- or paste into the Supabase SQL editor.
--
-- Security model: a user's five grid positions are DERIVED from their votes by the
-- API and are never writable by the client. There is deliberately no INSERT/UPDATE
-- policy on grid_positions — only the service role can write it. Everything that
-- affects the algorithm goes through the API.

create extension if not exists "pgcrypto";
create extension if not exists "citext";

-- ── Profiles ────────────────────────────────────────────────────────────────

create table if not exists profiles (
  id            uuid primary key references auth.users on delete cascade,
  handle        citext not null unique,
  name          text not null default '',
  pronouns      text not null default '',
  bio           text not null default '',
  city          text not null default '',
  -- spec §6.5: only speakers may post
  privacy_tier  text not null default 'active'
                check (privacy_tier in ('speaker', 'active', 'private')),
  -- spec §4.4: per-grid alignment can be toggled public/private
  grid_public   jsonb not null default
                '{"values":true,"mind":true,"soul":true,"culture":false,"focus":true}'::jsonb,
  premium       boolean not null default false,
  tier_changed_at timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

create index if not exists profiles_handle_idx on profiles (handle);

-- ── Grid positions (server-owned, derived from votes) ───────────────────────

create table if not exists grid_positions (
  user_id     uuid primary key references profiles on delete cascade,
  values_x    double precision not null default 0,
  values_y    double precision not null default 0,
  mind_x      double precision not null default 0,
  mind_y      double precision not null default 0,
  soul_x      double precision not null default 0,
  soul_y      double precision not null default 0,
  culture_x   double precision not null default 0,
  culture_y   double precision not null default 0,
  focus_x     double precision not null default 0,
  focus_y     double precision not null default 0,
  -- total reactions ever cast, not the size of the decay window
  vote_count  integer not null default 0,
  -- spec §4.3: the type unlocks at 50 reactions
  unlocked    boolean generated always as (vote_count >= 50) stored,
  updated_at  timestamptz not null default now()
);

-- ── Content ─────────────────────────────────────────────────────────────────

create table if not exists content (
  id                uuid primary key default gen_random_uuid(),
  author_id         uuid not null references profiles on delete cascade,
  type              text not null check (type in ('video', 'image', 'text')),
  body              text not null,
  context           text,
  music             text,
  media_url         text,
  -- spec §8: AI scores are cached per item — scored once, reused for every voter
  scores            jsonb not null,
  scorer            text not null default 'unknown',
  moderation_status text not null default 'pending'
                    check (moderation_status in ('pending', 'approved', 'rejected')),
  -- denormalised tallies so the global split is one read (spec §6.2)
  love_count        integer not null default 0,
  like_count        integer not null default 0,
  dislike_count     integer not null default 0,
  hate_count        integer not null default 0,
  created_at        timestamptz not null default now()
);

create index if not exists content_author_idx on content (author_id, created_at desc);
create index if not exists content_feed_idx on content (type, moderation_status, created_at desc);

-- ── Votes ───────────────────────────────────────────────────────────────────

create table if not exists votes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references profiles on delete cascade,
  content_id  uuid not null references content on delete cascade,
  -- spec §4.1: ±1 like/dislike, ±2 love/hate
  power       smallint not null check (power in (-2, -1, 1, 2)),
  -- spec §7: r and C at cast time, so position history can be replayed exactly
  scores_snapshot jsonb not null,
  created_at  timestamptz not null default now(),
  -- re-voting replaces the previous reaction rather than stacking a second one
  unique (user_id, content_id)
);

-- the decay window reads the newest 250 votes for one user (spec §4.2)
create index if not exists votes_window_idx on votes (user_id, created_at desc);

-- a user may never vote on their own post (spec §5)
create or replace function reject_self_vote() returns trigger
language plpgsql as $$
begin
  if exists (select 1 from content c where c.id = new.content_id and c.author_id = new.user_id) then
    raise exception 'cannot vote on your own post';
  end if;
  return new;
end;
$$;

drop trigger if exists votes_no_self_vote on votes;
create trigger votes_no_self_vote
  before insert or update on votes
  for each row execute function reject_self_vote();

-- ── Social graph ────────────────────────────────────────────────────────────

create table if not exists follows (
  follower_id uuid not null references profiles on delete cascade,
  followee_id uuid not null references profiles on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (follower_id, followee_id),
  check (follower_id <> followee_id)
);

create index if not exists follows_followee_idx on follows (followee_id);

-- ── Messages (spec §6.7) ────────────────────────────────────────────────────

create table if not exists conversations (
  id         uuid primary key default gen_random_uuid(),
  user_a     uuid not null references profiles on delete cascade,
  user_b     uuid not null references profiles on delete cascade,
  created_at timestamptz not null default now(),
  check (user_a < user_b),
  unique (user_a, user_b)
);

create table if not exists messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations on delete cascade,
  sender_id       uuid not null references profiles on delete cascade,
  body            text,
  -- a forwarded post carries the sender's vote on it
  content_id      uuid references content on delete set null,
  vote_snapshot   smallint check (vote_snapshot in (-2, -1, 1, 2)),
  created_at      timestamptz not null default now(),
  check (body is not null or content_id is not null)
);

create index if not exists messages_convo_idx on messages (conversation_id, created_at);

-- ── Notifications ───────────────────────────────────────────────────────────

create table if not exists notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references profiles on delete cascade,
  actor_id    uuid references profiles on delete cascade,
  kind        text not null,
  body        text not null,
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists notifications_user_idx on notifications (user_id, created_at desc);

-- ── Alignment cache (spec §7: computed, cacheable) ──────────────────────────

create table if not exists alignments (
  user_a       uuid not null references profiles on delete cascade,
  user_b       uuid not null references profiles on delete cascade,
  per_grid     jsonb not null,
  total_pct    double precision not null,
  computed_at  timestamptz not null default now(),
  primary key (user_a, user_b),
  check (user_a < user_b)
);

create index if not exists alignments_total_idx on alignments (user_a, total_pct desc);

-- ── Row level security ──────────────────────────────────────────────────────

alter table profiles       enable row level security;
alter table grid_positions enable row level security;
alter table content        enable row level security;
alter table votes          enable row level security;
alter table follows        enable row level security;
alter table conversations  enable row level security;
alter table messages       enable row level security;
alter table notifications  enable row level security;
alter table alignments     enable row level security;

-- Profiles: everyone signed in can read; you may only write your own.
drop policy if exists profiles_read on profiles;
create policy profiles_read on profiles
  for select to authenticated using (true);

drop policy if exists profiles_write_own on profiles;
create policy profiles_write_own on profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- Positions: readable unless the owner is Private. Deliberately no write policy —
-- only the API (service role) may write these.
drop policy if exists positions_read on grid_positions;
create policy positions_read on grid_positions
  for select to authenticated using (
    user_id = auth.uid()
    or exists (
      select 1 from profiles p
      where p.id = grid_positions.user_id and p.privacy_tier <> 'private'
    )
  );

-- Content: approved posts are public to signed-in users; authors see their own.
drop policy if exists content_read on content;
create policy content_read on content
  for select to authenticated using (
    moderation_status = 'approved' or author_id = auth.uid()
  );

-- Only Speakers may post, and only as themselves (spec §5 / §6.8).
drop policy if exists content_insert_speaker on content;
create policy content_insert_speaker on content
  for insert to authenticated with check (
    author_id = auth.uid()
    and exists (
      select 1 from profiles p where p.id = auth.uid() and p.privacy_tier = 'speaker'
    )
  );

-- Votes are private to the voter.
drop policy if exists votes_own on votes;
create policy votes_own on votes
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists follows_read on follows;
create policy follows_read on follows for select to authenticated using (true);

drop policy if exists follows_write_own on follows;
create policy follows_write_own on follows
  for all to authenticated using (follower_id = auth.uid()) with check (follower_id = auth.uid());

drop policy if exists convo_participants on conversations;
create policy convo_participants on conversations
  for select to authenticated using (user_a = auth.uid() or user_b = auth.uid());

drop policy if exists messages_participants on messages;
create policy messages_participants on messages
  for select to authenticated using (
    exists (
      select 1 from conversations c
      where c.id = messages.conversation_id
        and (c.user_a = auth.uid() or c.user_b = auth.uid())
    )
  );

drop policy if exists messages_send on messages;
create policy messages_send on messages
  for insert to authenticated with check (
    sender_id = auth.uid()
    and exists (
      select 1 from conversations c
      where c.id = conversation_id and (c.user_a = auth.uid() or c.user_b = auth.uid())
    )
  );

drop policy if exists notifications_own on notifications;
create policy notifications_own on notifications
  for select to authenticated using (user_id = auth.uid());

drop policy if exists alignments_own on alignments;
create policy alignments_own on alignments
  for select to authenticated using (user_a = auth.uid() or user_b = auth.uid());

-- ── New signups ─────────────────────────────────────────────────────────────
-- Supabase Auth writes auth.users; nothing else does. Without this trigger a new
-- account has no profile and every API call 404s.

create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  base      text;
  candidate text;
  n         integer := 0;
begin
  base := lower(regexp_replace(coalesce(split_part(new.email, '@', 1), 'pnyx'), '[^a-z0-9._]', '', 'g'));
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

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ── Vote tallies ────────────────────────────────────────────────────────────
-- Atomic increment so two concurrent voters cannot clobber each other's count.

create or replace function adjust_tallies(
  target uuid, d_love int, d_like int, d_dislike int, d_hate int
) returns void
language sql as $$
  update content set
    love_count    = greatest(0, love_count + d_love),
    like_count    = greatest(0, like_count + d_like),
    dislike_count = greatest(0, dislike_count + d_dislike),
    hate_count    = greatest(0, hate_count + d_hate)
  where id = target;
$$;

-- ── Right to be forgotten (spec §6.5, §9) ───────────────────────────────────
-- Deleting the auth user cascades through every table above. Exposed as an API
-- endpoint; kept here so the guarantee lives with the schema.

create or replace function forget_me(target uuid) returns void
language plpgsql security definer as $$
begin
  delete from auth.users where id = target;
end;
$$;
