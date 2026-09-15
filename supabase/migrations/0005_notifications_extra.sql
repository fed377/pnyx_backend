-- PNYX — notification accessories
--
-- The client shows a thumbnail for a vote/reply notification, or a percentage
-- pill for an alignment one — both need a reference alongside the rendered
-- body text, not just the text itself.

alter table notifications add column if not exists content_id uuid references content on delete set null;
alter table notifications add column if not exists pct integer;
