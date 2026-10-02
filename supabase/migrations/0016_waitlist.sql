-- Pre-launch waitlist, filled by the public POST /waitlist route that the
-- pnyx-waitlist site calls. Not tied to an account: these are email
-- addresses of people who don't have one yet.

create table if not exists waitlist (
  id         uuid primary key default gen_random_uuid(),
  -- Stored lowercased (the service normalizes it), so plain uniqueness is
  -- case-insensitive uniqueness — and a plain unique constraint is what
  -- PostgREST's on-conflict upsert needs.
  email      text not null unique check (email = lower(email) and length(email) <= 254),
  source     text check (length(source) <= 40),
  created_at timestamptz not null default now()
);

alter table waitlist enable row level security;

-- No policies at all: nobody but the service role may read or write it. The
-- list is personal data with no client surface — export it from the
-- dashboard (Table Editor → waitlist → Export to CSV).
