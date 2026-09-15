-- PNYX — comments (spec §5: comments are votable too)
--
-- Comment agree/disagree tallies are real per-user votes, not an
-- increment-only counter, for the same reason post votes are: so one person
-- can't inflate a count by tapping repeatedly, and a vote is changeable.

create table if not exists comments (
  id          uuid primary key default gen_random_uuid(),
  content_id  uuid not null references content on delete cascade,
  author_id   uuid not null references profiles on delete cascade,
  body        text not null check (char_length(body) between 1 and 500),
  created_at  timestamptz not null default now()
);

create index if not exists comments_content_idx on comments (content_id, created_at);

create table if not exists comment_votes (
  comment_id  uuid not null references comments on delete cascade,
  user_id     uuid not null references profiles on delete cascade,
  power       smallint not null check (power in (-1, 1)),
  created_at  timestamptz not null default now(),
  primary key (comment_id, user_id)
);

alter table comments      enable row level security;
alter table comment_votes enable row level security;

-- Readable under the same rule as the post itself: approved, or you're the author.
drop policy if exists comments_read on comments;
create policy comments_read on comments
  for select to authenticated using (
    exists (
      select 1 from content c
      where c.id = comments.content_id
        and (c.moderation_status = 'approved' or c.author_id = auth.uid())
    )
  );

drop policy if exists comments_insert_own on comments;
create policy comments_insert_own on comments
  for insert to authenticated with check (author_id = auth.uid());

drop policy if exists comment_votes_read on comment_votes;
create policy comment_votes_read on comment_votes
  for select to authenticated using (
    exists (
      select 1 from comments cm
      join content c on c.id = cm.content_id
      where cm.id = comment_votes.comment_id
        and (c.moderation_status = 'approved' or c.author_id = auth.uid())
    )
  );

drop policy if exists comment_votes_own on comment_votes;
create policy comment_votes_own on comment_votes
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
