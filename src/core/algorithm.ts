import { GRID_IDS, GRIDS, nearestPoint } from "./grids";
import type { GridId, Point, Positions, Scores, Vote, VotePower } from "./types";

/* ── Constants (spec §4.2 / §4.3) ─────────────────────────────────────────── */

/** A full-strength vote moves the user 10% of the remaining distance. */
export const STEP = 1 / 10;
export const DECAY_BASE = 0.99;
/** Below this a vote leaves the active window entirely. */
export const DECAY_FLOOR = 0.0810585161622;
/** 0.99^250 ≈ 0.0810585 — so the effective sample caps at ~250 votes. */
export const MAX_WINDOW = 250;
/** Type stays locked until this many reactions (spec §4.3). */
export const UNLOCK_AT = 50;
/** The first N reels are deliberately broad, to bootstrap a profile. */
export const COLD_START = 50;
/**
 * A vote sits pending — shown immediately, cancellable by tapping again —
 * before it commits: dispatched into the movement equation and sent to the
 * server. Once committed it's permanent; the replay-based positions make an
 * arbitrary historical vote well-defined to remove locally, but the server
 * has no such endpoint, and retroactively undoing a vote that isn't your
 * most recent one would be a confusing thing for the product to support
 * even where it's technically possible.
 */
export const VOTE_GRACE_MS = 7000;
/** Furthest two positions can be on a [-1,1]² grid. */
export const MAX_DIST = 2 * Math.SQRT2;

export const ORIGIN: Positions = {
  values: { x: 0, y: 0 },
  mind: { x: 0, y: 0 },
  soul: { x: 0, y: 0 },
  culture: { x: 0, y: 0 },
  focus: { x: 0, y: 0 },
};

/* ── Movement ─────────────────────────────────────────────────────────────── */

const clamp = (n: number) => (n < -1 ? -1 : n > 1 ? 1 : n);

/** Decay factor for a vote that has `age` newer votes after it. */
export function decayFor(age: number): number {
  return DECAY_BASE ** age;
}

/** Votes still inside the decay window, oldest first. */
export function activeVotes(votes: Vote[]): Vote[] {
  const recent = votes.slice(-MAX_WINDOW);
  const n = recent.length;
  return recent.filter((_, i) => decayFor(n - 1 - i) >= DECAY_FLOOR);
}

/**
 * One vote's displacement on one grid:
 *   P += (q · C · D)/10 · (r − P)
 */
export function stepGrid(p: Point, r: Point, power: VotePower, confidence: number, decay: number): Point {
  const k = (power * confidence * decay) / 10;
  return {
    x: clamp(p.x + k * (r.x - p.x)),
    y: clamp(p.y + k * (r.y - p.y)),
  };
}

/** Replays the active window from the origin. */
export function computePositions(votes: Vote[]): Positions {
  const active = activeVotes(votes);
  const n = active.length;
  const out: Positions = {
    values: { ...ORIGIN.values },
    mind: { ...ORIGIN.mind },
    soul: { ...ORIGIN.soul },
    culture: { ...ORIGIN.culture },
    focus: { ...ORIGIN.focus },
  };
  active.forEach((vote, i) => {
    const decay = decayFor(n - 1 - i);
    for (const g of GRID_IDS) {
      const s = vote.scores[g];
      out[g] = stepGrid(out[g], { x: s.x, y: s.y }, vote.power, s.confidence, decay);
    }
  });
  return out;
}

/** Where a vote would move the user, without recording it. */
export function previewVote(current: Positions, scores: Scores, power: VotePower): Positions {
  const out = {} as Positions;
  for (const g of GRID_IDS) {
    const s = scores[g];
    out[g] = stepGrid(current[g], { x: s.x, y: s.y }, power, s.confidence, 1);
  }
  return out;
}

/** Position after every `every` votes — used by Statistics. */
export function positionHistory(votes: Vote[], every = 5): Positions[] {
  const active = activeVotes(votes);
  const n = active.length;
  const out: Positions[] = [{ ...ORIGIN }];
  let cur: Positions = {
    values: { ...ORIGIN.values },
    mind: { ...ORIGIN.mind },
    soul: { ...ORIGIN.soul },
    culture: { ...ORIGIN.culture },
    focus: { ...ORIGIN.focus },
  };
  active.forEach((vote, i) => {
    const decay = decayFor(n - 1 - i);
    const next = {} as Positions;
    for (const g of GRID_IDS) {
      const s = vote.scores[g];
      next[g] = stepGrid(cur[g], { x: s.x, y: s.y }, vote.power, s.confidence, decay);
    }
    cur = next;
    if ((i + 1) % every === 0 || i === n - 1) out.push(cur);
  });
  return out;
}

/* ── Alignment (spec §4.4) ────────────────────────────────────────────────── */

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Percentage closeness of two positions on one grid. */
export function gridAlignment(a: Point, b: Point): number {
  return (1 - distance(a, b) / MAX_DIST) * 100;
}

export function perGridAlignment(a: Positions, b: Positions): Record<GridId, number> {
  const out = {} as Record<GridId, number>;
  for (const g of GRID_IDS) out[g] = gridAlignment(a[g], b[g]);
  return out;
}

/** Average of the five per-grid percentages. */
export function totalAlignment(a: Positions, b: Positions): number {
  const per = perGridAlignment(a, b);
  return GRID_IDS.reduce((sum, g) => sum + per[g], 0) / GRID_IDS.length;
}

/* ── Identity ─────────────────────────────────────────────────────────────── */

/**
 * How many leading letters of a grid's position names are needed before no two
 * collide — spec §6.4 flags a fixed two-letter prefix as an unresolved collision
 * risk (e.g. focus's "Burnt"/"Burgundy" both start "BU"), so this grows the
 * prefix per grid until every name in it is distinguishable, instead of
 * guessing a width that happens to work for today's name list.
 */
const codeLengthCache = new Map<GridId, number>();
function codeLength(g: GridId): number {
  const cached = codeLengthCache.get(g);
  if (cached !== undefined) return cached;

  const names = GRIDS[g].points.map((point) => point.name.toUpperCase());
  const longest = Math.max(...names.map((n) => n.length));
  let len = 2;
  while (len < longest) {
    const prefixes = names.map((n) => n.slice(0, len));
    if (new Set(prefixes).size === prefixes.length) break;
    len++;
  }
  codeLengthCache.set(g, len);
  return len;
}

/** Shareable code: each grid's named position, truncated just enough to stay unique within that grid. */
export function identityCode(p: Positions): string {
  return GRID_IDS.map((g) => nearestPoint(g, p[g]).name.slice(0, codeLength(g)).toUpperCase()).join("·");
}

/** Distance travelled from the origin, as a share of the maximum. */
export function conviction(p: Positions): number {
  const total = GRID_IDS.reduce((sum, g) => sum + Math.hypot(p[g].x, p[g].y), 0);
  return Math.min(1, total / (GRID_IDS.length * Math.SQRT2));
}

export const round = (n: number) => Math.round(n);
