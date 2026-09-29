/**
 * Shared pieces for the seed pipeline:
 *
 *   generate.ts  personas, posts, comments, media → seed-data/manifest.json (no database)
 *   load.ts      replays the manifest through PnyxService into a Supabase project
 *   clean.ts     deletes every seed account from a Supabase project
 *
 * See scripts/seed/README.md for the full walkthrough.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { config } from "../../src/config";
import { GRIDS, GRID_IDS } from "../../src/core/grids";
import type { Positions } from "../../src/core/types";
import { SupabaseMediaStore } from "../../src/media";
import { SupabaseRepository } from "../../src/repo/supabase";
import { GeminiScorer } from "../../src/scoring/geminiScorer";
import { DeterministicScorer, type ContentScorer } from "../../src/scoring/scorer";
import { PnyxService } from "../../src/service";

/* ── Paths ─────────────────────────────────────────────────────────────────── */

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BACKEND_ROOT = path.resolve(HERE, "../..");
export const DATA_DIR = path.resolve(process.env.SEED_DATA_DIR ?? path.join(BACKEND_ROOT, "seed-data"));
export const MANIFEST_PATH = path.join(DATA_DIR, "manifest.json");
export const EXAMPLE_MANIFEST_PATH = path.join(HERE, "manifest.example.json");
export const statePath = (ref: string) => path.join(DATA_DIR, `state.${ref}.json`);
/** Media and avatar paths in the manifest are relative to DATA_DIR. */
export const dataFile = (rel: string) => path.join(DATA_DIR, rel);

/** Seed accounts get a dedicated domain, so clean.ts can double-check it is
 * only ever deleting accounts this pipeline created. */
export const SEED_EMAIL_DOMAIN = "seed.pnyx.local";
export const emailFor = (personaKey: string) => `${personaKey.replace(/[^a-z0-9.-]/gi, "")}@${SEED_EMAIL_DOMAIN}`;

/* ── Manifest ──────────────────────────────────────────────────────────────── */

const point = z.object({ x: z.number().min(-1).max(1), y: z.number().min(-1).max(1) });
const positions = z.object({ values: point, mind: point, soul: point, culture: point, focus: point });
const gridId = z.enum(["values", "mind", "soul", "culture", "focus"]);
const key = z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/, "keys are lowercase letters, digits and dashes");

export const personaSchema = z.object({
  key,
  handle: z.string().regex(/^[a-z0-9._]{2,20}$/),
  name: z.string().min(1).max(60),
  pronouns: z.string().max(20).default(""),
  bio: z.string().max(200).default(""),
  city: z.string().max(60).default(""),
  tier: z.enum(["speaker", "active", "private"]),
  /** YYYY-MM-DD. Must clear MIN_AGE (16). */
  birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Hidden "true" position. Only the vote simulator reads it — it is never
   * written to grid_positions; the account's real position comes from its votes. */
  truePosition: positions,
  temperament: z.object({
    /** 0..1 — how much of the feed this persona gets through (vote count). */
    activity: z.number().min(0).max(1),
    /** 0..1 — noise on top of pure affinity; high = less predictable taste. */
    volatility: z.number().min(0).max(1),
    /** 0..1 — shifts the love/like/dislike/hate cut-offs; high = harsher. */
    harshness: z.number().min(0).max(1),
  }),
  topics: z.array(z.string()).default([]),
  avatar: z.object({ file: z.string(), mimeType: z.enum(["image/png", "image/jpeg"]) }).optional(),
});

export const postSchema = z.object({
  key,
  authorKey: key,
  // createContent only accepts media posts — there is no text-only path.
  type: z.enum(["image", "video"]),
  text: z.string().min(1).max(280),
  context: z.string().max(80).optional(),
  music: z.string().max(80).optional(),
  categories: z.array(gridId).max(5).optional(),
  /** Stock-search words for generate.ts's media stage. */
  mediaQuery: z.string().min(1),
  media: z
    .object({
      file: z.string(),
      mimeType: z.enum(["image/jpeg", "video/mp4"]),
      source: z.literal("pexels"),
      sourceId: z.number(),
      sourceUrl: z.string(),
      credit: z.string(),
      /** Set once generate.ts's audio stage has mixed a track into the video file. */
      audio: z
        .object({
          /** Relative to DATA_DIR, e.g. "music/track.mp3". */
          track: z.string(),
          /** Seconds into the track the clip starts. */
          start: z.number(),
          /** From music/credits.json, when provided — keep for license attribution. */
          credit: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});

export const commentSchema = z.object({
  key,
  postKey: key,
  authorKey: key,
  text: z.string().min(1).max(500),
});

export const manifestSchema = z.object({
  version: z.literal(1),
  /** Everything random downstream (vote decisions, follows, timeline) derives from this. */
  seed: z.number().int(),
  personas: z.array(personaSchema),
  posts: z.array(postSchema),
  comments: z.array(commentSchema).default([]),
});

export type Persona = z.infer<typeof personaSchema>;
export type Post = z.infer<typeof postSchema>;
export type SeedComment = z.infer<typeof commentSchema>;
export type Manifest = z.infer<typeof manifestSchema>;

export function loadManifest(file = MANIFEST_PATH): Manifest {
  if (!existsSync(file)) {
    throw new Error(`No manifest at ${file}. Run \`npm run seed:generate\` or copy scripts/seed/manifest.example.json there.`);
  }
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  checkManifestIntegrity(manifest);
  return manifest;
}

export function saveManifest(manifest: Manifest, file = MANIFEST_PATH) {
  writeJsonAtomic(file, manifest);
}

/** Cross-references zod can't express: unique keys/handles, authors that exist and can post. */
export function checkManifestIntegrity(m: Manifest) {
  const problems: string[] = [];
  const dupes = (xs: string[]) => xs.filter((x, i) => xs.indexOf(x) !== i);
  for (const d of dupes(m.personas.map((p) => p.key))) problems.push(`duplicate persona key ${d}`);
  for (const d of dupes(m.personas.map((p) => p.handle))) problems.push(`duplicate handle ${d}`);
  for (const d of dupes(m.posts.map((p) => p.key))) problems.push(`duplicate post key ${d}`);
  for (const d of dupes(m.comments.map((c) => c.key))) problems.push(`duplicate comment key ${d}`);

  const personas = new Map(m.personas.map((p) => [p.key, p]));
  const posts = new Set(m.posts.map((p) => p.key));
  for (const post of m.posts) {
    const author = personas.get(post.authorKey);
    if (!author) problems.push(`post ${post.key}: unknown author ${post.authorKey}`);
    else if (author.tier !== "speaker") problems.push(`post ${post.key}: author ${author.key} is not a speaker`);
  }
  for (const c of m.comments) {
    if (!posts.has(c.postKey)) problems.push(`comment ${c.key}: unknown post ${c.postKey}`);
    if (!personas.has(c.authorKey)) problems.push(`comment ${c.key}: unknown author ${c.authorKey}`);
  }
  if (problems.length) throw new Error(`Manifest problems:\n  ${problems.join("\n  ")}`);
}

/* ── Load state (per target project) ───────────────────────────────────────── */

export type PostState =
  | { status: "created"; contentId: string }
  | { status: "rejected"; code: string; reason: string };

export type LoadState = {
  /** persona key → auth user id */
  users: Record<string, string>;
  /** persona keys whose avatar has been uploaded */
  avatars: Record<string, true>;
  posts: Record<string, PostState>;
  /** persona key → post keys, in the order the votes were cast. Order matters:
   * the timeline step must keep it, or the stored positions would no longer
   * match a replay of the votes. */
  votes: Record<string, string[]>;
  /** "followerKey>followeeKey" */
  follows: Record<string, true>;
  /** comment key → comment id */
  comments: Record<string, string>;
  /** "commentKey>voterKey" — voteComment toggles, so it must never be replayed. */
  commentVotes: Record<string, true>;
};

export function loadState(ref: string): LoadState {
  const file = statePath(ref);
  const empty: LoadState = { users: {}, avatars: {}, posts: {}, votes: {}, follows: {}, comments: {}, commentVotes: {} };
  if (!existsSync(file)) return empty;
  return { ...empty, ...(JSON.parse(readFileSync(file, "utf8")) as Partial<LoadState>) };
}

export function saveState(ref: string, state: LoadState) {
  writeJsonAtomic(statePath(ref), state);
}

export function writeJsonAtomic(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}

/* ── Target guard ──────────────────────────────────────────────────────────── */

/** `https://abcd.supabase.co` → "abcd"; anything else (a local stack) → "local". */
export function projectRef(url: string): string {
  const host = new URL(url).hostname;
  return host.endsWith(".supabase.co") ? host.split(".")[0]! : "local";
}

/**
 * Every command that writes to Supabase must be told, explicitly, which
 * project it is about to write to — and that must match SUPABASE_URL. Stops a
 * stale .env pointed at production from being seeded by accident.
 */
export function requireTarget(target: string | undefined): string {
  if (!config.supabaseUrl || !config.supabaseServiceKey) {
    throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env first.");
  }
  const ref = projectRef(config.supabaseUrl);
  if (!target) {
    throw new Error(`Pass --target ${ref} to confirm you mean to write to ${config.supabaseUrl}.`);
  }
  if (target !== ref) {
    throw new Error(`--target ${target} does not match SUPABASE_URL (${ref}). Refusing to continue.`);
  }
  return ref;
}

/* ── Service ───────────────────────────────────────────────────────────────── */

/**
 * The same wiring as src/server.ts, minus the push sender: PnyxService's
 * default NullPushSender means nothing done here can ever reach a phone.
 */
export function makeService(scoring: "gemini" | "none") {
  const repo = new SupabaseRepository(config.supabaseUrl, config.supabaseServiceKey);
  const media = new SupabaseMediaStore(config.supabaseUrl, config.supabaseServiceKey);
  let scorer: ContentScorer;
  if (scoring === "gemini") {
    if (!config.geminiApiKey) throw new Error("GEMINI_API_KEY is required: seed posts go through the real scorer.");
    scorer = new GeminiScorer({ apiKey: config.geminiApiKey, model: config.scorerModel });
  } else {
    // Only for commands that never create content (clean.ts).
    scorer = new DeterministicScorer();
  }
  return { repo, media, service: new PnyxService(repo, scorer, media) };
}

/** Raw service-role client, for what PnyxService has no method for: creating
 * auth users, the is_seed flag, the timeline RPC and post-run tidy-up. Never
 * used to write grid_positions. */
export function adminClient(): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Chunks a list so `.in(column, ids)` filters stay under URL-length limits. */
export function chunk<T>(xs: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/* ── Randomness (deterministic) ────────────────────────────────────────────── */

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 — small, fast, good enough for simulation. */
export function rngFor(...parts: (string | number)[]): () => number {
  let a = hashString(parts.join("|"));
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(rng: () => number): number {
  const u = Math.max(rng(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

export function shuffle<T>(xs: readonly T[], rng: () => number): T[] {
  const out = xs.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/* ── Network resilience ────────────────────────────────────────────────────── */

/** Failures where the request almost certainly never reached the server —
 * a dead kept-alive socket, a refused/unresolved connection. Safe to resend
 * whatever the method. */
const NEVER_SENT = new Set(["ECONNRESET", "EPIPE", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);
/** Timeouts may land after the server acted, so only reads are resent on them —
 * resending e.g. the adjust_tallies RPC could count a vote twice. */
const READ_ONLY_TOO = new Set(["ETIMEDOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);

function networkCode(err: unknown): string | undefined {
  const cause = (err as { cause?: { code?: string; errors?: { code?: string }[] } })?.cause;
  return cause?.code ?? cause?.errors?.[0]?.code;
}

/**
 * Wraps the global fetch — which supabase-js, the Gemini SDK and the storage
 * PUTs all go through — so a dropped connection is retried instead of killing
 * a long run. Seed scripts only; the server keeps plain fetch.
 */
export function installFetchRetry(delaysMs = [500, 2_000, 5_000, 10_000]) {
  const plain = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const replayable = !(init?.body instanceof ReadableStream) && !(input instanceof Request && input.body);
    for (let attempt = 0; ; attempt++) {
      try {
        return await plain(input, init);
      } catch (err) {
        const code = networkCode(err);
        const retry =
          replayable &&
          attempt < delaysMs.length &&
          code !== undefined &&
          (NEVER_SENT.has(code) || ((method === "GET" || method === "HEAD") && READ_ONLY_TOO.has(code)));
        if (!retry) throw err;
        await sleep(delaysMs[attempt]!);
      }
    }
  };
}

/** "fetch failed" alone says nothing — include the underlying network cause. */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as { code?: string }).code;
    return `${err.message} (${code ? `${code}: ` : ""}${cause.message})`;
  }
  return err.message;
}

/* ── Async helpers ─────────────────────────────────────────────────────────── */

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs `fn` over `items` with at most `limit` in flight. */
export async function mapPool<T>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
}

/** Retries with backoff while `isRetryable(err)` holds. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  isRetryable: (err: unknown) => boolean,
  delaysMs = [5_000, 15_000, 45_000],
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= delaysMs.length || !isRetryable(err)) throw err;
      await sleep(delaysMs[attempt]!);
    }
  }
}

/* ── Describing positions to a language model ──────────────────────────────── */

function strength(v: number): string {
  const a = Math.abs(v);
  return a < 0.15 ? "balanced between" : a < 0.45 ? "leaning" : a < 0.75 ? "clearly" : "strongly";
}

/** "Values: clearly Communitarian (x 0.62), leaning Progressive (y -0.31)" per grid. */
export function describePosition(p: Positions): string {
  return GRID_IDS.map((id) => {
    const g = GRIDS[id];
    const axis = (v: number, neg: string, pos: string, label: string) =>
      Math.abs(v) < 0.15
        ? `balanced between ${neg} and ${pos} (${label} ${v.toFixed(2)})`
        : `${strength(v)} ${v > 0 ? pos : neg} (${label} ${v.toFixed(2)})`;
    return `${g.label}: ${axis(p[id].x, g.axisX.neg, g.axisX.pos, "x")}, ${axis(p[id].y, g.axisY.neg, g.axisY.pos, "y")}`;
  }).join("\n");
}

/* ── Tiny arg parser ───────────────────────────────────────────────────────── */

/** `--name value` and bare `--flag` → { name: "value", flag: true }. */
export function parseArgs(argv = process.argv.slice(2)): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const name = a.slice(2);
    const value = argv[i + 1];
    if (value !== undefined && !value.startsWith("--")) {
      out[name] = value;
      i++;
    } else {
      out[name] = true;
    }
  }
  return out;
}

export const argString = (args: Record<string, string | true>, name: string) =>
  typeof args[name] === "string" ? (args[name] as string) : undefined;

export const argNumber = (args: Record<string, string | true>, name: string, fallback: number) => {
  const v = argString(args, name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number`);
  return n;
};

/** `--only a,b` → Set, or null when every stage should run. */
export const argStages = (args: Record<string, string | true>) => {
  const v = argString(args, "only");
  return v ? new Set(v.split(",").map((s) => s.trim())) : null;
};
