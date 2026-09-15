-- PNYX — onboarding completion, tracked server-side
--
-- Whether an account has been through Onboarding (handle, birthday/age-gate,
-- bio) previously lived only as a local AsyncStorage flag, reset on every
-- sign-out ("forget") and absent entirely on a fresh install or a second
-- device — so a real, already-onboarded account was shown the onboarding
-- screen again any time local state didn't remember it. This column is the
-- durable, account-level signal that survives all of that.

alter table profiles add column if not exists onboarded boolean not null default false;
