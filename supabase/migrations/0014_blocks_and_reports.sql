-- Beta-readiness audit finding (blocker): there was no way for a user to
-- block another user or report content — no in-app safety mechanism at all
-- beyond the pre-publish AI moderation gate. Adds both.

create table if not exists blocks (
  blocker_id uuid not null references profiles on delete cascade,
  blocked_id uuid not null references profiles on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

create index if not exists blocks_blocked_idx on blocks (blocked_id);

alter table blocks enable row level security;

-- Private to the blocker, unlike follows (which are public) — who you've
-- blocked is nobody else's business, not even the blocked person's.
drop policy if exists blocks_own on blocks;
create policy blocks_own on blocks
  for all to authenticated using (blocker_id = auth.uid()) with check (blocker_id = auth.uid());

create table if not exists content_reports (
  id          uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references profiles on delete cascade,
  content_id  uuid not null references content on delete cascade,
  reason      text not null,
  created_at  timestamptz not null default now()
);

create index if not exists content_reports_content_idx on content_reports (content_id);

alter table content_reports enable row level security;

-- No select/insert policy for authenticated users at all: reports are an
-- operator concern with no admin surface yet (queried directly against the
-- store, same as moderation_strikes was before it had one) — only the
-- service role may insert one, via PnyxService.reportContent.
