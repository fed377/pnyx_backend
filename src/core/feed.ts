import { distance, MAX_DIST } from "./algorithm";
import { GRID_IDS } from "./grids";
import type { Person, Positions, Scores, VotePower } from "./types";

/**
 * How close a piece of content sits to a position, weighted by the model's
 * confidence on each grid. 1 = identical, 0 = maximally far.
 */
export function affinity(positions: Positions, scores: Scores): number {
  let num = 0;
  let den = 0;
  for (const g of GRID_IDS) {
    const s = scores[g];
    num += s.confidence * (1 - distance(positions[g], { x: s.x, y: s.y }) / MAX_DIST);
    den += s.confidence;
  }
  return den === 0 ? 0.5 : num / den;
}

/** Mean confidence across the five grids. */
export function meanConfidence(scores: Scores): number {
  return GRID_IDS.reduce((sum, g) => sum + scores[g].confidence, 0) / GRID_IDS.length;
}

export type OpinionTallies = { love: number; like: number; dislike: number; hate: number };

/** Below this many total votes, a piece of content's opinion split is too
 * noisy a sample to move ranking — one or two early votes shouldn't swing it. */
const MIN_VOTES_FOR_OPINION_SIGNAL = 5;

/** How far the opinion-split incentive can move a reel's ranking score:
 * unanimous content (everyone reacts the same way) is pushed down toward
 * this floor, perfectly split content is pushed up toward the ceiling. */
const OPINION_SPLIT_FLOOR = 0.5;
const OPINION_SPLIT_CEILING = 1.5;

/**
 * How divided reactions are on a piece of content: 0 = total consensus (every
 * reaction on the same side), 1 = an even split between positive (love/like)
 * and negative (dislike/hate). Independent of which side "won" — a post
 * everyone hates scores the same as a post everyone loves.
 */
export function opinionSplit(t: OpinionTallies): number {
  const positive = t.love + t.like;
  const negative = t.dislike + t.hate;
  const total = positive + negative;
  if (total === 0) return 0;
  return 1 - Math.abs(positive - negative) / total;
}

/**
 * User-incentive mechanism: content that provokes real disagreement earns
 * more reach than content everyone just nods along to. Neutral (1×) until
 * there's enough votes to trust the split at all.
 */
export function opinionSplitMultiplier(t: OpinionTallies): number {
  const total = t.love + t.like + t.dislike + t.hate;
  if (total < MIN_VOTES_FOR_OPINION_SIGNAL) return 1;
  return OPINION_SPLIT_FLOOR + (OPINION_SPLIT_CEILING - OPINION_SPLIT_FLOOR) * opinionSplit(t);
}

/** Once the unvoted reels are flowing, one slot in this many revisits a reel already voted on. */
const VOTED_REEL_EVERY = 15;

/** How far `random` can lift a reel's score: enough to reorder close calls, not to bury a clear winner. */
const SCORE_JITTER = 0.35;

/** Below this many views, a reel's average completion is too noisy to rank on. */
const MIN_VIEWS_FOR_QUALITY = 20;
const QUALITY_FLOOR = 0.6;
const QUALITY_RANGE = 0.8;

/** A reel's freshness boost halves every this many days, towards the floor. */
const FRESHNESS_HALF_LIFE_DAYS = 7;
const FRESHNESS_FLOOR = 0.7;
const FRESHNESS_RANGE = 0.5;

/** At most this many reels by one creator in any run of `AUTHOR_WINDOW`. */
const MAX_PER_AUTHOR = 2;
const AUTHOR_WINDOW = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

export type ReelSignals = {
  authorId: string;
  createdAtMs: number;
  views: number;
  /** Sum of each viewer's 0-1 completion. */
  completionSum: number;
};

export type RankOptions<T> = {
  /** Content the viewer has already voted on or watched; it comes up only rarely. */
  voted?: ReadonlySet<string>;
  /** Varies the order between loads. Without it the ranking is deterministic. */
  random?: () => number;
  /** Quality, freshness and creator variety. Without it none of those apply. */
  signals?: (item: T) => ReelSignals;
  now?: number;
};

/** 1× until enough people have watched; then rewards reels people finish. */
export function qualityMultiplier(views: number, completionSum: number): number {
  if (views < MIN_VIEWS_FOR_QUALITY) return 1;
  return QUALITY_FLOOR + QUALITY_RANGE * Math.min(1, completionSum / views);
}

export function freshnessMultiplier(createdAtMs: number, now: number): number {
  const ageDays = Math.max(0, now - createdAtMs) / DAY_MS;
  return FRESHNESS_FLOOR + FRESHNESS_RANGE * 0.5 ** (ageDays / FRESHNESS_HALF_LIFE_DAYS);
}

/** Holds back any reel whose creator is already at the cap for this stretch of the feed. */
function spaceAuthors<T>(items: T[], authorOf: (item: T) => string): T[] {
  const waiting = [...items];
  const out: T[] = [];
  while (waiting.length > 0) {
    const recent = out.slice(-(AUTHOR_WINDOW - 1)).map(authorOf);
    const next = waiting.findIndex(
      (item) => recent.filter((a) => a === authorOf(item)).length < MAX_PER_AUTHOR,
    );
    // Everyone left is at the cap: better a repeat than a shorter feed.
    out.push(waiting.splice(Math.max(next, 0), 1)[0]);
  }
  return out;
}

/**
 * Recommendation order. Reels the viewer hasn't voted on come first, with one
 * they have slotted in every `VOTED_REEL_EVERY`; the rest follow once the
 * unvoted ones run out.
 */
export function rankReels<T extends { id: string; scores: Scores }>(
  reels: T[],
  positions: Positions,
  voteCount: number,
  getTallies: (item: T) => OpinionTallies,
  { voted, random, signals, now = Date.now() }: RankOptions<T> = {},
): T[] {
  const boost = signals
    ? (item: T) => {
        const s = signals(item);
        return qualityMultiplier(s.views, s.completionSum) * freshnessMultiplier(s.createdAtMs, now);
      }
    : undefined;
  const rank = (items: T[]) => rankGroup(items, positions, voteCount, getTallies, random, boost);
  const spaced = (items: T[]) => (signals ? spaceAuthors(items, (c) => signals(c).authorId) : items);
  if (!voted) return spaced(rank(reels));

  const fresh = rank(reels.filter((c) => !voted.has(c.id)));
  const seen = rank(reels.filter((c) => voted.has(c.id)));

  const out: T[] = [];
  let si = 0;
  for (const item of fresh) {
    if ((out.length + 1) % VOTED_REEL_EVERY === 0 && si < seen.length) out.push(seen[si++]);
    out.push(item);
  }
  return spaced([...out, ...seen.slice(si)]);
}

/**
 * Cold start: the first 50 reactions get a deliberately broad spread rather than
 * a proximity ranking. After that, score favours content that is close to the
 * user *and* confidently scored *and* provokes disagreement rather than
 * consensus (and, with `boost`, that people finish and that's recent), and
 * every 20th slot is handed to the most against-the-grain item still unseen.
 */
function rankGroup<T extends { id: string; scores: Scores }>(
  reels: T[],
  positions: Positions,
  voteCount: number,
  getTallies: (item: T) => OpinionTallies,
  random?: () => number,
  boost?: (item: T) => number,
): T[] {
  const scored = reels.map((c) => ({
    c,
    aff: affinity(positions, c.scores),
    conf: meanConfidence(c.scores),
    split:
      opinionSplitMultiplier(getTallies(c)) *
      (random ? 1 + random() * SCORE_JITTER : 1) *
      (voteCount >= 50 && boost ? boost(c) : 1),
  }));

  if (voteCount < 50) {
    // Broad and diverse: alternate ends of the affinity range. Cold-start
    // exposure is about the viewer seeing a wide spread, not the creator
    // incentive below — the opinion-split multiplier doesn't apply here.
    const sorted = [...scored].sort((a, b) => b.aff - a.aff);
    const out: T[] = [];
    let head = 0;
    let tail = sorted.length - 1;
    while (head <= tail) {
      out.push(sorted[head++].c);
      if (head <= tail) out.push(sorted[tail--].c);
    }
    if (!random) return out;
    // Start somewhere different each load; the spread itself is unchanged.
    const start = Math.floor(random() * out.length);
    return [...out.slice(start), ...out.slice(0, start)];
  }

  const byScore = [...scored].sort(
    (a, b) => b.aff * b.conf * b.split - a.aff * a.conf * a.split,
  );
  const contrarian = [...scored].sort((a, b) => a.aff - b.aff).map((s) => s.c);

  const out: T[] = [];
  const used = new Set<string>();
  let ci = 0;
  for (const item of byScore) {
    // 1 in 20 is deliberately against the grain.
    if (out.length > 0 && out.length % 20 === 19) {
      while (ci < contrarian.length && used.has(contrarian[ci].id)) ci++;
      if (ci < contrarian.length) {
        out.push(contrarian[ci]);
        used.add(contrarian[ci].id);
      }
    }
    if (used.has(item.c.id)) continue;
    out.push(item.c);
    used.add(item.c.id);
  }
  return out;
}

/**
 * Offline/local-mode stand-in only — there's no real vote to look up without a
 * backend, so this guesses from affinity between each friend's own grid
 * position and the content's scores instead. Deterministic (not invented per
 * render), so the split stays consistent wherever it's shown, but it is a
 * guess, not a real cast vote. Remote mode uses `useFriendVotes()`
 * (state/useFriendVotes.ts), which looks up actual votes instead.
 */
export function friendVotes<T extends { scores: Scores }>(
  content: T,
  friends: Person[],
): { person: Person; power: VotePower }[] {
  return friends.map((person) => {
    const a = affinity(person.positions, content.scores);
    const power: VotePower = a > 0.78 ? 2 : a > 0.6 ? 1 : a > 0.45 ? -1 : -2;
    return { person, power };
  });
}

export const POWER_LABEL: Record<VotePower, string> = {
  2: "Loved",
  1: "Liked",
  [-1]: "Disliked",
  [-2]: "Hated",
};
