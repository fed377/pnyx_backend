/**
 * Deletes every seed account from a Supabase project — with everything they
 * posted, voted, commented and uploaded — through PnyxService.forgetMe, the
 * same path a real "delete my account" takes.
 *
 *   npm run seed:clean -- --target <project-ref>          # list what would be deleted
 *   npm run seed:clean -- --target <project-ref> --yes    # actually delete
 *
 * An account is only deleted when BOTH its profile has is_seed = true AND its
 * auth email is on the seed domain. Accounts from the older
 * scripts/seed-supabase.ts (@pnyx.local, no is_seed) are not touched.
 *
 * Deleting a seed account also removes real users' votes on seed posts (they
 * cascade with the content); real users' own positions are recomputed the
 * next time they vote.
 */
import { rmSync } from "node:fs";
import {
  adminClient,
  argString,
  describeError,
  installFetchRetry,
  makeService,
  parseArgs,
  requireTarget,
  SEED_EMAIL_DOMAIN,
  statePath,
} from "./lib";

async function main() {
  const args = parseArgs();
  const ref = requireTarget(argString(args, "target"));
  const confirmed = args.yes === true;
  const db = adminClient();
  const { service } = makeService("none");

  const { data, error } = await db.from("profiles").select("id, handle").eq("is_seed", true);
  if (error) throw new Error(`list seed profiles: ${error.message} (is migration 0015 applied?)`);

  const targets: { id: string; handle: string }[] = [];
  for (const row of data ?? []) {
    const { data: user, error: userErr } = await db.auth.admin.getUserById(row.id);
    if (userErr) throw new Error(`getUserById ${row.id}: ${userErr.message}`);
    const email = user.user?.email ?? "";
    if (!email.toLowerCase().endsWith(`@${SEED_EMAIL_DOMAIN}`)) {
      console.log(`  ! @${row.handle} is flagged is_seed but its email (${email || "none"}) is not a seed address — skipped`);
      continue;
    }
    targets.push({ id: row.id, handle: row.handle });
  }

  console.log(`${targets.length} seed account(s) in ${ref}${confirmed ? "" : " — dry run, pass --yes to delete"}`);
  for (const t of targets) {
    if (confirmed) await service.forgetMe(t.id);
    console.log(`  ${confirmed ? "- deleted" : "·"} @${t.handle}`);
  }

  if (confirmed) {
    rmSync(statePath(ref), { force: true });
    console.log(`\nDone. Removed ${statePath(ref)} too, so the next load starts fresh.`);
  }
}

installFetchRetry();

main().catch((err) => {
  console.error("\nSeed clean failed:", describeError(err));
  process.exit(1);
});
