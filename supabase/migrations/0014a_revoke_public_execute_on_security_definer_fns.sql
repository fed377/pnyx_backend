-- PNYX — revoke direct execute on the security-definer functions
--
-- Recovered from the hosted project's migration history (applied there as
-- version 20260923150306, between 0014 and 0015) — it was run against the
-- database directly and never saved here, so a fresh setup from this folder
-- didn't match production. Named 0014a so it sorts where it actually ran.
--
-- On its own this was NOT enough: Postgres grants EXECUTE on new functions to
-- PUBLIC, which every role (anon and authenticated included) inherits, and
-- this only removed the direct grants. forget_me stayed callable by anyone
-- holding the anon key until 0015_seed_accounts.sql revoked it from PUBLIC as
-- well. handle_new_user returns `trigger`, so it can't be called directly
-- through PostgREST either way.

revoke execute on function public.forget_me(uuid) from anon, authenticated;
revoke execute on function public.handle_new_user() from anon, authenticated;
