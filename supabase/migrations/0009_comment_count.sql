-- PNYX — denormalised comment count on content
--
-- The client showed a comment count next to every post/reel, but nothing
-- ever populated it server-side (`toContent()` on the native side hardcoded
-- an empty array with a stale "comments are not served by the API yet"
-- comment) — comments were live for a while, the count just never was.
-- Same denormalisation as the vote tallies (love_count etc.): one read per
-- list item instead of a COUNT per row.

alter table content add column if not exists comment_count integer not null default 0;

-- Backfill: any comment already posted before this column existed.
update content set comment_count = (
  select count(*) from comments where comments.content_id = content.id
);

create or replace function increment_comment_count(target uuid) returns void
language sql as $$
  update content set comment_count = comment_count + 1 where id = target;
$$;
