/**
 * The behavioural model behind seed accounts: which posts a persona votes on
 * and how hard, whom it follows, how it reacts to comments, and when all of
 * that plausibly happened. Pure functions of the manifest and its `seed`, so
 * a re-run makes the same decisions.
 *
 * Nothing here decides a position. Personas cast votes through
 * PnyxService.castVote and their positions fall out of the real replay.
 */
import { totalAlignment, UNLOCK_AT } from "../../src/core/algorithm";
import { affinity } from "../../src/core/feed";
import type { Scores, VotePower } from "../../src/core/types";
import { gaussian, rngFor, shuffle, type Persona } from "./lib";

/** Enough to unlock identity (UNLOCK_AT), with headroom for posts that fail moderation. */
export const MIN_VOTES = UNLOCK_AT + 10;

/**
 * Cut-offs on a persona's standardised affinity. For a normal distribution
 * they give roughly 25% love / 45% like / 22% dislike / 8% hate — the kind of
 * positive skew most reaction systems see. `harshness` slides them all.
 */
const LOVE_ABOVE = 0.67;
const LIKE_ABOVE = -0.52;
const DISLIKE_ABOVE = -1.4;

export type VoteCandidate = {
  postKey: string;
  scores: Scores;
  /** 0..1 — where the post sits on the seed timeline. Votes are cast oldest first. */
  timeFraction: number;
};

export type PlannedVote = { postKey: string; power: VotePower };

/**
 * Decides one persona's votes. Affinity (the feed ranker's own measure) is
 * standardised per persona, so the split is driven by *relative* taste rather
 * than by how far this persona happens to sit from the grids' centre.
 */
export function planVotes(persona: Persona, candidates: VoteCandidate[], seed: number): PlannedVote[] {
  const n = candidates.length;
  if (n === 0) return [];
  const rng = rngFor(seed, "votes", persona.key);
  const { activity, volatility, harshness } = persona.temperament;

  const raw = candidates.map((c) => affinity(persona.truePosition, c.scores));
  const mean = raw.reduce((s, a) => s + a, 0) / n;
  const std = Math.sqrt(raw.reduce((s, a) => s + (a - mean) ** 2, 0) / n) || 1e-6;
  const shift = (harshness - 0.5) * 0.6;

  const decided = candidates.map((c, i) => {
    const z = (raw[i]! - mean) / std + volatility * 1.5 * gaussian(rng);
    const power: VotePower =
      z > LOVE_ABOVE + shift ? 2 : z > LIKE_ABOVE + shift ? 1 : z > DISLIKE_ABOVE + shift ? -1 : -2;
    return { postKey: c.postKey, power, timeFraction: c.timeFraction };
  });

  const want = Math.round(n * (0.35 + 0.65 * activity));
  const count = Math.max(Math.min(MIN_VOTES, n), Math.min(want, n));

  return shuffle(decided, rng)
    .slice(0, count)
    .sort((a, b) => a.timeFraction - b.timeFraction)
    .map(({ postKey, power }) => ({ postKey, power }));
}

/**
 * Follows mostly go to the people a persona is genuinely close to, plus the
 * odd random one — nobody's follow list is perfectly aligned. Private
 * profiles are never followed.
 */
export function planFollows(personas: Persona[], seed: number): [follower: string, followee: string][] {
  const out: [string, string][] = [];
  const followable = personas.filter((p) => p.tier !== "private");
  for (const p of personas) {
    const rng = rngFor(seed, "follows", p.key);
    const ranked = followable
      .filter((o) => o.key !== p.key)
      .map((o) => ({ key: o.key, pct: totalAlignment(p.truePosition, o.truePosition) }))
      .sort((a, b) => b.pct - a.pct);
    const k = 2 + Math.round(p.temperament.activity * 6);
    const chosen = ranked.slice(0, k).map((r) => r.key);
    const rest = ranked.slice(k);
    if (rest.length && rng() < 0.7) chosen.push(rest[Math.floor(rng() * rest.length)]!.key);
    for (const followee of chosen) out.push([p.key, followee]);
  }
  return out;
}

/** Who agrees or disagrees with a comment: likelier to agree the more aligned they are with its author. */
export function planCommentVotes(
  commentKey: string,
  author: Persona,
  personas: Persona[],
  seed: number,
): { voterKey: string; power: 1 | -1 }[] {
  const rng = rngFor(seed, "comment-votes", commentKey);
  const voters = shuffle(
    personas.filter((p) => p.key !== author.key),
    rng,
  ).slice(0, 2 + Math.floor(rng() * 8));
  return voters.map((v) => ({
    voterKey: v.key,
    power: rng() < totalAlignment(v.truePosition, author.truePosition) / 100 ? 1 : -1,
  }));
}

/** Where each post sits on the seed timeline, 0 (oldest) .. 1 (newest). Stable per key. */
export const postTimeFraction = (seed: number, postKey: string) => rngFor(seed, "post-time", postKey)();

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** Exponential delay with the given mean, capped. */
const delay = (rng: () => number, mean: number, cap: number) => Math.min(-Math.log(Math.max(rng(), 1e-9)) * mean, cap);

export type Timeline = {
  content: { key: string; at: number }[];
  votes: { personaKey: string; postKey: string; at: number }[];
  comments: { key: string; at: number }[];
  profiles: { personaKey: string; at: number }[];
};

/**
 * Spreads the seed activity over the last `spanDays`. Each persona's votes get
 * strictly increasing times *in the order they were cast* — the decay replay
 * orders by `created_at`, so preserving that order keeps the stored positions
 * identical to a replay of the backdated votes (load.ts verifies this).
 */
export function buildTimeline(input: {
  seed: number;
  now: number;
  spanDays: number;
  posts: { key: string; authorKey: string }[];
  castOrder: Record<string, string[]>;
  comments: { key: string; postKey: string; authorKey: string }[];
  personaKeys: string[];
}): Timeline {
  const { seed, now } = input;
  const start = now - input.spanDays * DAY;
  const end = now - 2 * HOUR;
  const postAt = new Map(input.posts.map((p) => [p.key, start + postTimeFraction(seed, p.key) * (end - start)]));

  const firstActivity = new Map<string, number>();
  const touch = (personaKey: string, at: number) =>
    firstActivity.set(personaKey, Math.min(firstActivity.get(personaKey) ?? Infinity, at));

  const content = input.posts.map((p) => {
    const at = postAt.get(p.key)!;
    touch(p.authorKey, at);
    return { key: p.key, at };
  });

  const votes: Timeline["votes"] = [];
  for (const [personaKey, order] of Object.entries(input.castOrder)) {
    const rng = rngFor(seed, "vote-times", personaKey);
    let prev = -Infinity;
    for (const postKey of order) {
      const posted = postAt.get(postKey);
      if (posted === undefined) continue;
      let at = Math.max(prev + 30_000 + rng() * 20 * 60_000, posted + 60_000 + delay(rng, 10 * HOUR, 3 * DAY));
      at = Math.min(at, now);
      if (at <= prev) at = prev + 1_000;
      prev = at;
      votes.push({ personaKey, postKey, at });
      touch(personaKey, at);
    }
  }

  const comments = input.comments
    .filter((c) => postAt.has(c.postKey))
    .map((c) => {
      const posted = postAt.get(c.postKey)!;
      const rng = rngFor(seed, "comment-time", c.key);
      const at = Math.min(posted + 5 * 60_000 + delay(rng, 6 * HOUR, 2 * DAY), now - 60_000);
      touch(c.authorKey, at);
      return { key: c.key, at: Math.max(at, posted + 60_000) };
    });

  const profiles = input.personaKeys.map((personaKey) => {
    const rng = rngFor(seed, "joined", personaKey);
    const first = firstActivity.get(personaKey) ?? start;
    return { personaKey, at: first - (1 + rng() * 9) * DAY };
  });

  return { content, votes, comments, profiles };
}
