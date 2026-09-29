/**
 * Replays seed-data/manifest.json into a Supabase project through PnyxService,
 * so seed accounts post, vote, follow and comment exactly the way real users
 * do: real Gemini scoring and moderation, positions derived by the vote
 * replay, tallies from real vote rows.
 *
 *   npm run seed:load -- --dry-run                 # validate manifest + files, touch nothing
 *   npm run seed:load -- --target <project-ref>    # load everything
 *   npm run seed:load -- --target <ref> --only votes,timeline,report
 *
 * Options:
 *   --target <ref>      required; must match SUPABASE_URL's project ref ("local" for a local stack)
 *   --only a,b          stages: accounts avatars posts votes follows comments timeline tidy report
 *   --concurrency <n>   personas voting in parallel (default 6). Each persona's votes stay sequential.
 *   --span-days <n>     how far back the timeline stretches (default 30)
 *
 * Resumable: progress is kept in seed-data/state.<ref>.json and every stage
 * skips what it already did. Requires migration 0015_seed_accounts.sql.
 */
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { computePositions, MAX_WINDOW, totalAlignment, UNLOCK_AT } from "../../src/core/algorithm";
import { GRID_IDS } from "../../src/core/grids";
import type { Positions, Vote } from "../../src/core/types";
import { ApiError, type ContentRow } from "../../src/domain";
import {
  adminClient,
  argNumber,
  argStages,
  argString,
  chunk,
  dataFile,
  describeError,
  emailFor,
  installFetchRetry,
  loadManifest,
  loadState,
  makeService,
  mapPool,
  parseArgs,
  requireTarget,
  saveState,
  withRetry,
  type LoadState,
  type Manifest,
  type Persona,
} from "./lib";
import { buildTimeline, planCommentVotes, planFollows, planVotes, postTimeFraction } from "./simulation";

const STAGES = ["accounts", "avatars", "posts", "votes", "follows", "comments", "timeline", "tidy", "report"] as const;
type Stage = (typeof STAGES)[number];

const args = parseArgs();
const only = argStages(args);
const concurrency = argNumber(args, "concurrency", 6);
const spanDays = argNumber(args, "span-days", 30);

if (only) {
  const unknown = [...only].filter((s) => !(STAGES as readonly string[]).includes(s));
  if (unknown.length) throw new Error(`Unknown stage(s): ${unknown.join(", ")}. Stages: ${STAGES.join(", ")}`);
}
const runs = (stage: Stage) => !only || only.has(stage);

/* ── Dry run ───────────────────────────────────────────────────────────────── */

function dryRun(manifest: Manifest) {
  const speakers = manifest.personas.filter((p) => p.tier === "speaker");
  const withMedia = manifest.posts.filter((p) => p.media && existsSync(dataFile(p.media.file)));
  const missingMedia = manifest.posts.filter((p) => !p.media || !existsSync(dataFile(p.media.file)));
  const avatars = manifest.personas.filter((p) => p.avatar && existsSync(dataFile(p.avatar.file)));

  console.log(`Manifest OK (seed ${manifest.seed})`);
  console.log(`  personas  ${manifest.personas.length} (${speakers.length} speakers), ${avatars.length} with avatar files`);
  console.log(`  posts     ${manifest.posts.length}, ${withMedia.length} with media on disk`);
  if (missingMedia.length) {
    console.log(`            ${missingMedia.length} without media will be skipped: ${missingMedia.map((p) => p.key).join(", ")}`);
    console.log(`            run \`npm run seed:generate -- --only media\` to fetch it`);
  }
  console.log(`  comments  ${manifest.comments.length}`);
  const perPersona = Math.max(0, withMedia.length - 1);
  console.log(`  votes     up to ~${manifest.personas.length * perPersona} (at most ${perPersona} per persona)`);
  if (perPersona < UNLOCK_AT) {
    console.log(`  NOTE: fewer than ${UNLOCK_AT} votable posts per persona — nobody will unlock an identity.`);
  }
}

/* ── Stages ────────────────────────────────────────────────────────────────── */

type Ctx = {
  ref: string;
  manifest: Manifest;
  state: LoadState;
  save: () => void;
  db: ReturnType<typeof adminClient>;
  repo: ReturnType<typeof makeService>["repo"];
  media: ReturnType<typeof makeService>["media"];
  service: ReturnType<typeof makeService>["service"];
  personas: Map<string, Persona>;
};

async function putFile(uploadUrl: string, file: string, mimeType: string) {
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "content-type": mimeType },
    body: readFileSync(dataFile(file)),
  });
  if (!res.ok) throw new Error(`upload failed (${res.status}): ${await res.text()}`);
}

async function stageAccounts(ctx: Ctx) {
  console.log("\n── accounts");
  const missing = ctx.manifest.personas.filter((p) => !ctx.state.users[p.key]);

  // Recover accounts from an earlier run whose state file was lost.
  const byEmail = new Map<string, string>();
  if (missing.length) {
    for (let page = 1; page <= 100; page++) {
      const { data, error } = await ctx.db.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) throw new Error(`listUsers: ${error.message}`);
      for (const u of data.users) if (u.email) byEmail.set(u.email.toLowerCase(), u.id);
      if (data.users.length < 1000) break;
    }
  }

  for (const p of ctx.manifest.personas) {
    let id = ctx.state.users[p.key] ?? byEmail.get(emailFor(p.key).toLowerCase());
    if (!id) {
      const { data, error } = await ctx.db.auth.admin.createUser({
        email: emailFor(p.key),
        password: `${randomUUID()}Aa1!`,
        email_confirm: true,
        // The signup trigger (0012) takes the handle from here, suffixing it if taken.
        user_metadata: { name: p.name, handle: p.handle, seed: true },
      });
      if (error) throw new Error(`createUser ${p.key}: ${error.message}`);
      id = data.user.id;
    }
    ctx.state.users[p.key] = id;
    ctx.save();

    // Profile details are account data, not algorithm state — written directly,
    // as an admin creating an account would. The handle is left to the trigger.
    const { data: row, error } = await ctx.db
      .from("profiles")
      .update({
        name: p.name,
        pronouns: p.pronouns,
        bio: p.bio,
        city: p.city,
        privacy_tier: p.tier,
        birthday: p.birthday,
        onboarded: true,
        is_seed: true,
      })
      .eq("id", id)
      .select("handle")
      .single();
    if (error) throw new Error(`profile ${p.key}: ${error.message}`);
    const note = row.handle === p.handle ? "" : `  (handle taken — got @${row.handle})`;
    console.log(`  ${p.key.padEnd(24)} @${p.handle} ${p.tier}${note}`);
  }
}

async function stageAvatars(ctx: Ctx) {
  console.log("\n── avatars");
  for (const p of ctx.manifest.personas) {
    const userId = ctx.state.users[p.key];
    if (!userId || ctx.state.avatars[p.key]) continue;
    if (!p.avatar || !existsSync(dataFile(p.avatar.file))) {
      console.log(`  ${p.key}: no avatar file, skipped`);
      continue;
    }
    const ticket = await ctx.media.createUploadTicket(userId, p.avatar.mimeType);
    await putFile(ticket.uploadUrl, p.avatar.file, p.avatar.mimeType);
    // Through the service, so the own-media check on avatarUrl applies.
    await ctx.service.updateProfile(userId, { avatarUrl: ticket.publicUrl });
    ctx.state.avatars[p.key] = true;
    ctx.save();
    console.log(`  + ${p.key}`);
  }
}

async function stagePosts(ctx: Ctx) {
  console.log("\n── posts (Gemini scoring + moderation, one at a time)");
  let created = 0;
  let rejected = 0;
  for (const post of ctx.manifest.posts) {
    if (ctx.state.posts[post.key]) continue;
    const userId = ctx.state.users[post.authorKey];
    if (!userId) continue;
    if (!post.media || !existsSync(dataFile(post.media.file))) {
      console.log(`  ${post.key}: no media on disk, skipped`);
      continue;
    }

    const ticket = await ctx.media.createUploadTicket(userId, post.media.mimeType);
    await putFile(ticket.uploadUrl, post.media.file, post.media.mimeType);

    try {
      const row = await withRetry(
        () =>
          ctx.service.createContent(userId, {
            type: post.type,
            body: post.text,
            context: post.context,
            music: post.music,
            categories: post.categories,
            mediaPath: ticket.path,
            mediaType: post.media!.mimeType,
          }),
        // 503 = Gemini busy/rate-limited (GeminiScorer already retried twice).
        (err) => err instanceof ApiError && err.status === 503,
      );
      ctx.state.posts[post.key] = { status: "created", contentId: row.id };
      created++;
      console.log(`  + ${post.key}`);
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 422) throw err;
      const code = String(err.details?.code ?? "rejected");
      ctx.state.posts[post.key] = { status: "rejected", code, reason: err.message };
      rejected++;
      console.log(`  ✗ ${post.key}: ${code} — ${err.message}`);
      // The uploaded file is orphaned; clean.ts's media.deleteAll removes it with the account.
    }
    ctx.save();
  }
  console.log(`  ${created} created, ${rejected} rejected this run`);
}

/** Every created seed post, re-read so votes use the scores actually stored. */
async function loadCreatedPosts(ctx: Ctx) {
  const entries = Object.entries(ctx.state.posts).flatMap(([key, s]) =>
    s.status === "created" ? [{ key, contentId: s.contentId }] : [],
  );
  const rows = new Map<string, ContentRow>();
  await mapPool(entries, 8, async ({ key, contentId }) => {
    const row = await ctx.repo.getContent(contentId);
    if (row && row.moderationStatus === "approved") rows.set(key, row);
  });
  return rows;
}

async function stageVotes(ctx: Ctx) {
  console.log(`\n── votes (${concurrency} personas in parallel, each sequential)`);
  const posts = await loadCreatedPosts(ctx);
  const personas = ctx.manifest.personas.filter((p) => ctx.state.users[p.key]);

  await mapPool(personas, concurrency, async (p) => {
    const userId = ctx.state.users[p.key]!;
    const candidates = [...posts.entries()]
      .filter(([, row]) => row.authorId !== userId)
      .map(([postKey, row]) => ({ postKey, scores: row.scores, timeFraction: postTimeFraction(ctx.manifest.seed, postKey) }));

    const done = new Set(ctx.state.votes[p.key] ?? []);
    const todo = planVotes(p, candidates, ctx.manifest.seed).filter((v) => !done.has(v.postKey));
    let cast = 0;
    for (const v of todo) {
      await ctx.service.castVote(userId, posts.get(v.postKey)!.id, v.power);
      (ctx.state.votes[p.key] ??= []).push(v.postKey);
      if (++cast % 10 === 0) ctx.save();
    }
    ctx.save();
    console.log(`  ${p.key.padEnd(24)} +${cast} (total ${ctx.state.votes[p.key]?.length ?? 0})`);
  });
}

async function stageFollows(ctx: Ctx) {
  console.log("\n── follows");
  const pairs = planFollows(
    ctx.manifest.personas.filter((p) => ctx.state.users[p.key]),
    ctx.manifest.seed,
  ).filter(([a, b]) => !ctx.state.follows[`${a}>${b}`]);
  await mapPool(pairs, 4, async ([a, b]) => {
    await ctx.service.setFollow(ctx.state.users[a]!, ctx.state.users[b]!, true);
    ctx.state.follows[`${a}>${b}`] = true;
  });
  ctx.save();
  console.log(`  +${pairs.length} (total ${Object.keys(ctx.state.follows).length})`);
}

async function stageComments(ctx: Ctx) {
  console.log("\n── comments");
  let added = 0;
  for (const c of ctx.manifest.comments) {
    if (ctx.state.comments[c.key]) continue;
    const post = ctx.state.posts[c.postKey];
    const userId = ctx.state.users[c.authorKey];
    if (post?.status !== "created" || !userId) continue;
    const row = await ctx.service.addComment(userId, post.contentId, c.text);
    ctx.state.comments[c.key] = row.id;
    if (++added % 25 === 0) {
      ctx.save();
      console.log(`  … ${added} comments`);
    }
  }
  ctx.save();

  let votes = 0;
  for (const c of ctx.manifest.comments) {
    const commentId = ctx.state.comments[c.key];
    const author = ctx.personas.get(c.authorKey);
    if (!commentId || !author) continue;
    for (const v of planCommentVotes(c.key, author, [...ctx.personas.values()], ctx.manifest.seed)) {
      const voterId = ctx.state.users[v.voterKey];
      // voteComment toggles off on a repeat, so each pair is cast exactly once.
      if (!voterId || ctx.state.commentVotes[`${c.key}>${v.voterKey}`]) continue;
      await ctx.service.voteComment(voterId, commentId, v.power);
      ctx.state.commentVotes[`${c.key}>${v.voterKey}`] = true;
      if (++votes % 200 === 0) {
        ctx.save();
        console.log(`  … ${votes} comment votes`);
      }
    }
  }
  ctx.save();
  console.log(`  +${added} comments, +${votes} comment votes`);
}

async function stageTimeline(ctx: Ctx) {
  console.log(`\n── timeline (spread over the last ${spanDays} days)`);
  const createdPosts = ctx.manifest.posts.filter((p) => ctx.state.posts[p.key]?.status === "created");
  const timeline = buildTimeline({
    seed: ctx.manifest.seed,
    now: Date.now(),
    spanDays,
    posts: createdPosts,
    castOrder: ctx.state.votes,
    comments: ctx.manifest.comments.filter((c) => ctx.state.comments[c.key]),
    personaKeys: Object.keys(ctx.state.users),
  });

  const iso = (ms: number) => new Date(ms).toISOString();
  const contentId = (key: string) => (ctx.state.posts[key] as { contentId: string }).contentId;
  const contentRows = timeline.content.map((c) => ({ id: contentId(c.key), at: iso(c.at) }));
  const commentRows = timeline.comments.map((c) => ({ id: ctx.state.comments[c.key]!, at: iso(c.at) }));
  const profileRows = timeline.profiles.map((p) => ({ id: ctx.state.users[p.personaKey]!, at: iso(p.at) }));
  const voteRows = timeline.votes.map((v) => ({
    user_id: ctx.state.users[v.personaKey]!,
    content_id: contentId(v.postKey),
    at: iso(v.at),
  }));

  const call = async (params: Record<string, unknown>) => {
    const { error } = await ctx.db.rpc("seed_apply_timeline", params);
    if (error) throw new Error(`seed_apply_timeline: ${error.message} (is migration 0015 applied?)`);
  };
  await call({ content_rows: contentRows, comment_rows: commentRows, profile_rows: profileRows });
  for (const part of chunk(voteRows, 2000)) await call({ vote_rows: part });
  console.log(`  ${contentRows.length} posts, ${voteRows.length} votes, ${commentRows.length} comments, ${profileRows.length} profiles`);
}

async function stageTidy(ctx: Ctx) {
  console.log("\n── tidy");
  const ids = Object.values(ctx.state.users);
  let notifications = 0;
  let strikes = 0;
  for (const part of chunk(ids, 100)) {
    // Every vote/follow/comment notified someone. Nobody reads a seed account's
    // inbox, and nothing a seed account did should sit in a real user's.
    for (const column of ["user_id", "actor_id"]) {
      const { count, error } = await ctx.db.from("notifications").delete({ count: "exact" }).in(column, part);
      if (error) throw new Error(`delete notifications: ${error.message}`);
      notifications += count ?? 0;
    }
    // Strikes from posts the moderation gate rejected — the rejection is
    // already recorded in the state file.
    const { count, error } = await ctx.db.from("moderation_strikes").delete({ count: "exact" }).in("user_id", part);
    if (error) throw new Error(`delete strikes: ${error.message}`);
    strikes += count ?? 0;
  }
  console.log(`  removed ${notifications} notifications, ${strikes} moderation strikes`);
}

async function stageReport(ctx: Ctx) {
  console.log("\n── report");
  const rows: { key: string; tier: string; votes: number; unlocked: boolean; fidelity: number; replayOk: boolean }[] = [];

  await mapPool(ctx.manifest.personas, 8, async (p) => {
    const userId = ctx.state.users[p.key];
    if (!userId) return;
    const stored = await ctx.repo.getPositions(userId);
    // Replay exactly as PnyxService.recomputePositions does. After the
    // timeline stage this proves backdating kept every voter's order intact.
    const recent = await ctx.repo.recentVotes(userId, MAX_WINDOW);
    const replayed = computePositions(
      recent
        .slice()
        .reverse()
        .map((v): Vote => ({ contentId: v.contentId, power: v.power, at: Date.parse(v.createdAt), scores: v.scoresSnapshot })),
    );
    rows.push({
      key: p.key,
      tier: p.tier,
      votes: stored.voteCount,
      unlocked: stored.unlocked,
      fidelity: totalAlignment(p.truePosition, stored.positions),
      replayOk: samePositions(stored.positions, replayed),
    });
  });

  rows.sort((a, b) => a.key.localeCompare(b.key));
  console.log(`  ${"persona".padEnd(24)} ${"tier".padEnd(8)} votes  unlocked  true↔derived  replay`);
  for (const r of rows) {
    console.log(
      `  ${r.key.padEnd(24)} ${r.tier.padEnd(8)} ${String(r.votes).padStart(5)}  ${(r.unlocked ? "yes" : "no").padEnd(8)}  ` +
        `${r.fidelity.toFixed(0).padStart(11)}%  ${r.replayOk ? "ok" : "MISMATCH"}`,
    );
  }

  const posts = Object.values(ctx.state.posts);
  const rejected = Object.entries(ctx.state.posts).filter(([, s]) => s.status === "rejected");
  const mean = rows.length ? rows.reduce((s, r) => s + r.fidelity, 0) / rows.length : 0;
  const tallies = await loadCreatedPosts(ctx);
  const split = { love: 0, like: 0, dislike: 0, hate: 0 };
  for (const row of tallies.values()) for (const k of Object.keys(split) as (keyof typeof split)[]) split[k] += row.tallies[k];
  const total = split.love + split.like + split.dislike + split.hate || 1;

  console.log(`\n  posts      ${posts.length - rejected.length} created, ${rejected.length} rejected`);
  for (const [key, s] of rejected) if (s.status === "rejected") console.log(`             ✗ ${key}: ${s.code} — ${s.reason}`);
  console.log(
    `  vote split love ${pct(split.love, total)} · like ${pct(split.like, total)} · dislike ${pct(split.dislike, total)} · hate ${pct(split.hate, total)}`,
  );
  console.log(`  unlocked   ${rows.filter((r) => r.unlocked).length}/${rows.length}`);
  console.log(`  true↔derived alignment, mean ${mean.toFixed(1)}% — how well votes pulled each persona toward its hidden position`);
  const mismatches = rows.filter((r) => !r.replayOk);
  if (mismatches.length) {
    console.log(`  REPLAY MISMATCH for ${mismatches.map((r) => r.key).join(", ")} — stored positions no longer match a replay of the votes.`);
    process.exitCode = 1;
  } else {
    console.log("  replay     every stored position matches a fresh replay of its votes");
  }
}

const pct = (n: number, total: number) => `${((100 * n) / total).toFixed(0)}%`;

function samePositions(a: Positions, b: Positions) {
  return GRID_IDS.every((g) => Math.abs(a[g].x - b[g].x) < 1e-6 && Math.abs(a[g].y - b[g].y) < 1e-6);
}

/* ── Main ──────────────────────────────────────────────────────────────────── */

async function main() {
  const manifest = loadManifest();
  if (args["dry-run"]) {
    dryRun(manifest);
    return;
  }

  const ref = requireTarget(argString(args, "target"));
  const { repo, media, service } = makeService("gemini");
  const state = loadState(ref);
  const ctx: Ctx = {
    ref,
    manifest,
    state,
    save: () => saveState(ref, state),
    db: adminClient(),
    repo,
    media,
    service,
    personas: new Map(manifest.personas.map((p) => [p.key, p])),
  };

  console.log(`Seeding ${ref} — ${manifest.personas.length} personas, ${manifest.posts.length} posts`);
  if (runs("accounts")) await stageAccounts(ctx);
  if (runs("avatars")) await stageAvatars(ctx);
  if (runs("posts")) await stagePosts(ctx);
  if (runs("votes")) await stageVotes(ctx);
  if (runs("follows")) await stageFollows(ctx);
  if (runs("comments")) await stageComments(ctx);
  if (runs("timeline")) await stageTimeline(ctx);
  if (runs("tidy")) await stageTidy(ctx);
  if (runs("report")) await stageReport(ctx);
  console.log("\nDone.");
}

installFetchRetry();

main().catch((err) => {
  console.error("\nSeed load failed:", describeError(err));
  process.exit(1);
});
