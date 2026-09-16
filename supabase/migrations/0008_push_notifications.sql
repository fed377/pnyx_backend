-- PNYX — OS push notifications
--
-- Two pieces: where a device's Expo push token lives, and which notification
-- kinds an account actually wants pushed (Settings' toggles controlled
-- nothing server-side until now — see the "no rate limiting" audit's sibling
-- finding on notifPrefs).

create table if not exists push_tokens (
  token text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists push_tokens_user_id_idx on push_tokens (user_id);

-- Same model as grid_positions: RLS on, deliberately no policy at all — only
-- the service role (this API) ever reads or writes a push token.
alter table push_tokens enable row level security;

alter table profiles add column if not exists notif_prefs jsonb not null
  default '{"votes": true, "replies": true, "alignments": false}'::jsonb;
