-- PNYX — hot takes
--
-- A short, text-only, ephemeral opinion filed under a grid category. Unlike
-- regular content, hot takes are not votable by other users (spec: the
-- up/down/comment counts shown in the viewer are display-only) and they
-- expire — the client's "expires in 14h" copy is real here, not decorative.

create table if not exists hot_takes (
  id             uuid primary key default gen_random_uuid(),
  author_id      uuid not null references profiles on delete cascade,
  category       text not null,
  body           text not null check (char_length(body) between 1 and 220),
  up_count       integer not null default 0,
  down_count     integer not null default 0,
  comment_count  integer not null default 0,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null default (now() + interval '14 hours')
);

create index if not exists hot_takes_active_idx on hot_takes (expires_at desc);

alter table hot_takes enable row level security;

drop policy if exists hot_takes_read_active on hot_takes;
create policy hot_takes_read_active on hot_takes
  for select to authenticated using (expires_at > now() or author_id = auth.uid());

drop policy if exists hot_takes_insert_speaker on hot_takes;
create policy hot_takes_insert_speaker on hot_takes
  for insert to authenticated with check (
    author_id = auth.uid()
    and exists (select 1 from profiles p where p.id = auth.uid() and p.privacy_tier = 'speaker')
  );
