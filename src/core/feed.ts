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

/**
 * Recommendation order (spec §4.3).
 *
 * Cold start: the first 50 reactions get a deliberately broad spread rather than
 * a proximity ranking. After that, score favours content that is close to the
 * user *and* confidently scored, and every 20th slot is handed to the most
 * against-the-grain item still unseen.
 */
export function rankReels<T extends { id: string; scores: Scores }>(
  reels: T[],
  positions: Positions,
  voteCount: number,
): T[] {
  const scored = reels.map((c) => ({
    c,
    aff: affinity(positions, c.scores),
    conf: meanConfidence(c.scores),
  }));

  if (voteCount < 50) {
    // Broad and diverse: alternate ends of the affinity range.
    const sorted = [...scored].sort((a, b) => b.aff - a.aff);
    const out: T[] = [];
    let head = 0;
    let tail = sorted.length - 1;
    while (head <= tail) {
      out.push(sorted[head++].c);
      if (head <= tail) out.push(sorted[tail--].c);
    }
    return out;
  }

  const byScore = [...scored].sort(
    (a, b) => b.aff * b.conf - a.aff * a.conf,
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
