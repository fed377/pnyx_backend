-- Beta-readiness audit finding (blocker): the under-16 age gate in
-- Onboarding.tsx was purely client-side — birthday was deliberately never
-- sent to the server ("kept only for the under-16 gate — there's no backend
-- column for it yet", per the native store's own comment), so calling
-- PATCH /me with onboarded=true directly bypassed it entirely.
--
-- Nullable: existing accounts onboarded before this column existed have no
-- birthday on file and aren't retroactively affected. PnyxService.updateProfile
-- now requires one (and enforces the minimum age) at the moment `onboarded`
-- is first set to true, going forward.

alter table profiles add column if not exists birthday date;
