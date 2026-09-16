-- Spec §6.5: privacy tier can change at most once per 30 days.
--
-- tier_changed_at previously defaulted to now() at signup, which would have
-- blocked every new account's very first deliberate tier choice for 30 days.
-- Make it nullable (null = never explicitly changed) so the cooldown only
-- starts counting after a user's first real change. Existing rows are reset
-- to null since no one has legitimately "used up" a change against a cooldown
-- that wasn't enforced yet.

alter table profiles alter column tier_changed_at drop default;
alter table profiles alter column tier_changed_at drop not null;
update profiles set tier_changed_at = null;
