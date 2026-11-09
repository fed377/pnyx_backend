-- Lets the feeds and People ask the database for good candidates instead of
-- loading whole tables into the API process.
--
-- Each grid position or content score becomes a 10-number vector (x, y for each
-- grid, in GRID_IDS order) so "closest to this person" can use an index. The
-- API still does the exact ranking on the few hundred candidates this returns.

create extension if not exists vector with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- ── Content embeddings ───────────────────────────────────────────────────

alter table content
  add column if not exists embedding extensions.vector(10),
  -- Lets "a random sample of reels" be an index range instead of a table sort.
  add column if not exists random_key double precision not null default random(),
  add column if not exists view_count integer not null default 0,
  -- Sum of each viewer's 0-1 completion; divide by view_count for the average.
  add column if not exists completion_sum double precision not null default 0;

create or replace function content_embedding(s jsonb) returns extensions.vector
language sql immutable
set search_path = public, extensions
as $$
  select array[
    coalesce((s->'values'->>'x')::real, 0),  coalesce((s->'values'->>'y')::real, 0),
    coalesce((s->'mind'->>'x')::real, 0),    coalesce((s->'mind'->>'y')::real, 0),
    coalesce((s->'soul'->>'x')::real, 0),    coalesce((s->'soul'->>'y')::real, 0),
    coalesce((s->'culture'->>'x')::real, 0), coalesce((s->'culture'->>'y')::real, 0),
    coalesce((s->'focus'->>'x')::real, 0),   coalesce((s->'focus'->>'y')::real, 0)
  ]::real[]::extensions.vector(10)
$$;

create or replace function set_content_embedding() returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  new.embedding := content_embedding(new.scores);
  return new;
end;
$$;

drop trigger if exists content_set_embedding on content;
create trigger content_set_embedding
  before insert or update of scores on content
  for each row execute function set_content_embedding();

update content set embedding = content_embedding(scores) where embedding is null;

create index if not exists content_reel_embedding_idx on content
  using hnsw (embedding extensions.vector_l2_ops)
  where type = 'video' and moderation_status = 'approved';

create index if not exists content_reel_random_idx on content (random_key)
  where type = 'video' and moderation_status = 'approved';

-- ── Views ────────────────────────────────────────────────────────────────

create table if not exists reel_views (
  user_id        uuid not null references profiles on delete cascade,
  content_id     uuid not null references content on delete cascade,
  watch_ms       bigint not null default 0,
  completion     real,
  view_count     integer not null default 1,
  last_viewed_at timestamptz not null default now(),
  primary key (user_id, content_id)
);

-- Written only by the API, with the service-role key.
alter table reel_views enable row level security;

-- Counts one view per person per reel towards the reel's quality signal, and
-- never the author's own.
create or replace function record_reel_views(viewer uuid, items jsonb) returns void
language sql
set search_path = public
as $$
  with input as (
    select distinct on (cid) cid, watch, done
    from (
      select
        (i->>'contentId')::uuid as cid,
        least(greatest(coalesce((i->>'watchMs')::bigint, 0), 0), 3600000) as watch,
        least(greatest((i->>'completion')::real, 0), 1) as done
      from jsonb_array_elements(items) i
    ) raw
    order by cid
  ),
  saved as (
    insert into reel_views as v (user_id, content_id, watch_ms, completion)
    select viewer, i.cid, i.watch, i.done
    from input i
    join content c on c.id = i.cid
    on conflict (user_id, content_id) do update set
      watch_ms = v.watch_ms + excluded.watch_ms,
      completion = greatest(v.completion, excluded.completion),
      view_count = v.view_count + 1,
      last_viewed_at = now()
    returning content_id, completion, (xmax = 0) as first_view
  )
  update content c set
    view_count = c.view_count + 1,
    completion_sum = c.completion_sum + s.completion
  from saved s
  where c.id = s.content_id and s.first_view and s.completion is not null and c.author_id <> viewer
$$;

-- ── Reel candidates ──────────────────────────────────────────────────────

-- Never a reel the viewer has voted on; a reel they've watched only when
-- `ignore_views` is set, which is how a small catalogue still fills the feed.
create or replace function reel_is_new(viewer uuid, reel uuid, ignore_views boolean) returns boolean
language sql stable
set search_path = public
as $$
  select not exists (select 1 from votes v where v.user_id = viewer and v.content_id = reel)
    and (ignore_views or not exists (
      select 1 from reel_views w
      where w.user_id = viewer and w.content_id = reel and w.last_viewed_at > now() - interval '30 days'
    ))
$$;

-- Three sources: closest to the viewer, newest, and a random sample. The last
-- two are what surface reels outside a viewer's usual area and give new
-- accounts their broad spread. Nearest neighbours are filtered after the index
-- search, so ef_search is at pgvector's maximum to leave enough after filtering.
create or replace function reel_candidates(
  viewer uuid,
  viewer_position real[],
  excluded uuid[],
  hidden uuid[],
  near_count integer,
  recent_count integer,
  explore_count integer,
  ignore_views boolean default false
) returns table (
  id uuid,
  author_id uuid,
  scores jsonb,
  love_count integer,
  like_count integer,
  dislike_count integer,
  hate_count integer,
  view_count integer,
  completion_sum double precision,
  created_at timestamptz
)
language sql
set search_path = public, extensions
set hnsw.ef_search = 1000
as $$
  with near as (
    select a.id
    from (
      select c.id, c.author_id, c.embedding <-> viewer_position::extensions.vector as dist
      from content c
      where c.type = 'video' and c.moderation_status = 'approved'
      order by c.embedding <-> viewer_position::extensions.vector
      limit 1000
    ) a
    where not (a.id = any(excluded)) and not (a.author_id = any(hidden))
      and reel_is_new(viewer, a.id, ignore_views)
    order by a.dist
    limit near_count
  ),
  recent as (
    select c.id from content c
    where c.type = 'video' and c.moderation_status = 'approved'
      and not (c.id = any(excluded)) and not (c.author_id = any(hidden))
      and reel_is_new(viewer, c.id, ignore_views)
    order by c.created_at desc
    limit recent_count
  ),
  explore as (
    select c.id from content c
    where c.type = 'video' and c.moderation_status = 'approved'
      and c.random_key >= random() * 0.95
      and not (c.id = any(excluded)) and not (c.author_id = any(hidden))
      and reel_is_new(viewer, c.id, ignore_views)
    order by c.random_key
    limit explore_count
  ),
  picked as (
    select near.id from near
    union select recent.id from recent
    union select explore.id from explore
  )
  select c.id, c.author_id, c.scores, c.love_count, c.like_count, c.dislike_count, c.hate_count,
         c.view_count, c.completion_sum, c.created_at
  from content c
  join picked p on p.id = c.id
$$;

-- ── People ───────────────────────────────────────────────────────────────

alter table grid_positions add column if not exists embedding extensions.vector(10);

create or replace function set_position_embedding() returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  new.embedding := array[
    new.values_x, new.values_y, new.mind_x, new.mind_y, new.soul_x,
    new.soul_y, new.culture_x, new.culture_y, new.focus_x, new.focus_y
  ]::real[]::extensions.vector(10);
  return new;
end;
$$;

drop trigger if exists grid_positions_set_embedding on grid_positions;
create trigger grid_positions_set_embedding
  before insert or update on grid_positions
  for each row execute function set_position_embedding();

update grid_positions set embedding = array[
  values_x, values_y, mind_x, mind_y, soul_x, soul_y, culture_x, culture_y, focus_x, focus_y
]::real[]::extensions.vector(10)
where embedding is null;

create index if not exists grid_positions_embedding_idx on grid_positions
  using hnsw (embedding extensions.vector_l2_ops);

create or replace function nearest_people(viewer uuid, viewer_position real[], hidden uuid[], match_count integer)
returns setof uuid
language sql
set search_path = public, extensions
set hnsw.ef_search = 1000
as $$
  select a.user_id
  from (
    select g.user_id, g.embedding <-> viewer_position::extensions.vector as dist
    from grid_positions g
    order by g.embedding <-> viewer_position::extensions.vector
    limit 1000
  ) a
  where a.user_id <> viewer and not (a.user_id = any(hidden))
  order by a.dist
  limit match_count
$$;

create index if not exists profiles_name_trgm_idx on profiles using gin (name extensions.gin_trgm_ops);
create index if not exists profiles_handle_trgm_idx on profiles using gin (handle extensions.gin_trgm_ops);

create or replace function search_profiles(term text, except_id uuid, match_count integer)
returns setof profiles
language sql stable
set search_path = public, extensions
as $$
  with pattern as (
    select '%' || replace(replace(replace(term, '\', '\\'), '%', '\%'), '_', '\_') || '%' as p
  )
  select pr.* from profiles pr, pattern
  where pr.id <> except_id and (pr.name ilike pattern.p or pr.handle ilike pattern.p)
  limit match_count
$$;

-- These take the viewer as an argument, so only the API may call them.
revoke execute on function record_reel_views(uuid, jsonb) from public, anon, authenticated;
revoke execute on function reel_candidates(uuid, real[], uuid[], uuid[], integer, integer, integer, boolean)
  from public, anon, authenticated;
revoke execute on function nearest_people(uuid, real[], uuid[], integer) from public, anon, authenticated;
revoke execute on function search_profiles(text, uuid, integer) from public, anon, authenticated;
