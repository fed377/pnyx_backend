/**
 * Deletes one seed batch from a Supabase project — every account in it, with
 * everything they posted, voted, commented and uploaded — through
 * PnyxService.forgetMe, the same path a real "delete my account" takes.
 *
 *   npm run seed:clean -- --target <project-ref>                    # list batches
 *   npm run seed:clean -- --target <project-ref> --batch old        # list what would be deleted
 *   npm run seed:clean -- --target <project-ref> --batch old --yes  # actually delete
 *   npm run seed:clean -- --target <project-ref> --all --yes        # every batch
 *
 * An account is only deleted when BOTH its profile has is_seed = true (and,
 * with --batch, that seed_batch) AND its auth email is on a seed domain.
 *
 * Deleting a seed account also removes real users' votes on seed posts (they
 * cascade with the content); real users' own positions are recomputed the
 * next time they vote.
 */
import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import {
  adminClient,
  argString,
  DATA_DIR,
  describeError,
  installFetchRetry,
  LEGACY_SEED_EMAIL_DOMAIN,
  makeService,
  parseArgs,
  requireTarget,
  SEED_EMAIL_DOMAIN,
  statePath,
} from "./lib";

const isSeedEmail = (email: string) =>
  [SEED_EMAIL_DOMAIN, LEGACY_SEED_EMAIL_DOMAIN].some((d) => email.toLowerCase().endsWith(`@${d}`));

async function main() {
  const args = parseArgs();
  const ref = requireTarget(argString(args, "target"));
  const batch = argString(args, "batch");
  const all = args.all === true;
  const confirmed = args.yes === true;
  const db = adminClient();

  const { data, error } = await db.from("profiles").select("id, handle, seed_batch").eq("is_seed", true);
  if (error) throw new Error(`list seed profiles: ${error.message} (are migrations 0015 and 0018 applied?)`);

  if (!batch && !all) {
    const counts = new Map<string, number>();
    for (const row of data ?? []) counts.set(row.seed_batch, (counts.get(row.seed_batch) ?? 0) + 1);
    console.log(`Seed batches in ${ref}:`);
    for (const [name, n] of [...counts].sort()) console.log(`  ${name.padEnd(24)} ${n} account(s)`);
    if (!counts.size) console.log("  (none)");
    console.log("\nPass --batch <name> to delete one (dry run unless --yes), or --all for every batch.");
    return;
  }

  const { service } = makeService("none");
  const targets: { id: string; handle: string; batch: string }[] = [];
  for (const row of data ?? []) {
    if (batch && row.seed_batch !== batch) continue;
    const { data: user, error: userErr } = await db.auth.admin.getUserById(row.id);
    if (userErr) throw new Error(`getUserById ${row.id}: ${userErr.message}`);
    const email = user.user?.email ?? "";
    if (!isSeedEmail(email)) {
      console.log(`  ! @${row.handle} is flagged is_seed but its email (${email || "none"}) is not a seed address — skipped`);
      continue;
    }
    targets.push({ id: row.id, handle: row.handle, batch: row.seed_batch });
  }

  const what = batch ? `batch "${batch}"` : "all batches";
  console.log(`${targets.length} seed account(s) in ${ref}, ${what}${confirmed ? "" : " — dry run, pass --yes to delete"}`);
  for (const t of targets) {
    if (confirmed) await service.forgetMe(t.id);
    console.log(`  ${confirmed ? "- deleted" : "·"} @${t.handle}${batch ? "" : `  (${t.batch})`}`);
  }

  if (confirmed) {
    // Drop the load state too, so the next load of this batch starts fresh.
    const files = batch
      ? [statePath(ref, batch)]
      : existsSync(DATA_DIR)
        ? readdirSync(DATA_DIR)
            .filter((f) => f.startsWith(`state.${ref}.`) && f.endsWith(".json"))
            .map((f) => path.join(DATA_DIR, f))
        : [];
    for (const f of files) rmSync(f, { force: true });
    console.log(`\nDone. Removed ${files.length} state file(s) so the next load starts fresh.`);
  }
}

installFetchRetry();

main().catch((err) => {
  console.error("\nSeed clean failed:", describeError(err));
  process.exit(1);
});
