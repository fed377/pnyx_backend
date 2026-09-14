-- PNYX — profile photos
--
-- Uploaded through the existing content bucket/signed-URL flow (media.ts),
-- under the same u/<userId>/ prefix as post media — no new bucket needed.
-- Just the column to remember which object is the current avatar.

alter table profiles add column if not exists avatar_url text;
