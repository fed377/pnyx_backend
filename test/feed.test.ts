import { describe, expect, it } from "vitest";
import { ORIGIN } from "../src/core/algorithm";
import { GRID_IDS } from "../src/core/grids";
import { opinionSplit, opinionSplitMultiplier, rankReels } from "../src/core/feed";
import type { Scores } from "../src/core/types";
import type { OpinionTallies } from "../src/core/feed";

const tallies = (t: Partial<OpinionTallies>): OpinionTallies => ({
  love: 0,
  like: 0,
  dislike: 0,
  hate: 0,
  ...t,
});

/** Every grid centered and fully confident, so affinity/confidence are equal across reels. */
const neutralScores = (): Scores => {
  const out = {} as Scores;
  for (const g of GRID_IDS) out[g] = { x: 0, y: 0, confidence: 1 };
  return out;
};

describe("opinionSplit", () => {
  it("is 0 for total consensus, whichever side it's on", () => {
    expect(opinionSplit(tallies({ love: 20 }))).toBe(0);
    expect(opinionSplit(tallies({ hate: 20 }))).toBe(0);
  });

  it("is 1 for a perfectly even split", () => {
    expect(opinionSplit(tallies({ love: 10, hate: 10 }))).toBe(1);
    expect(opinionSplit(tallies({ like: 5, dislike: 5 }))).toBe(1);
  });

  it("is 0 with no votes at all", () => {
    expect(opinionSplit(tallies({}))).toBe(0);
  });

  it("scales between the extremes for a partial split", () => {
    // 8 positive, 2 negative: |8-2|/10 = 0.6 away from even, so split = 0.4.
    expect(opinionSplit(tallies({ love: 8, hate: 2 }))).toBeCloseTo(0.4);
  });
});

describe("opinionSplitMultiplier", () => {
  it("is neutral (1x) below the minimum-votes threshold, even for a perfect split", () => {
    expect(opinionSplitMultiplier(tallies({ love: 2, hate: 2 }))).toBe(1);
  });

  it("de-ranks consensus content toward the floor once there's enough signal", () => {
    expect(opinionSplitMultiplier(tallies({ love: 20 }))).toBe(0.5);
  });

  it("boosts evenly split content toward the ceiling once there's enough signal", () => {
    expect(opinionSplitMultiplier(tallies({ love: 10, hate: 10 }))).toBe(1.5);
  });
});

describe("rankReels — opinion-split incentive", () => {
  const positions = structuredClone(ORIGIN);

  it("ranks a divisive reel above an equally-scored consensus reel, once past cold start", () => {
    const consensus = { id: "consensus", scores: neutralScores(), tallies: tallies({ love: 20 }) };
    const divisive = { id: "divisive", scores: neutralScores(), tallies: tallies({ love: 10, hate: 10 }) };

    // voteCount >= 50 to leave the cold-start branch, which doesn't apply the incentive.
    const ranked = rankReels([consensus, divisive], positions, 50, (c) => c.tallies);
    expect(ranked[0].id).toBe("divisive");
  });

  it("doesn't apply the incentive during cold start — a viewer's first reels stay pure affinity order", () => {
    const near: Scores = structuredClone(neutralScores());
    const far: Scores = structuredClone(neutralScores());
    for (const g of GRID_IDS) far[g] = { x: 1, y: 1, confidence: 1 };

    const consensusNear = { id: "consensus-near", scores: near, tallies: tallies({ love: 20 }) };
    const divisiveFar = { id: "divisive-far", scores: far, tallies: tallies({ love: 10, hate: 10 }) };

    // voteCount < 50: cold start alternates affinity extremes, unaffected by tallies.
    const ranked = rankReels([consensusNear, divisiveFar], positions, 0, (c) => c.tallies);
    expect(ranked[0].id).toBe("consensus-near");
  });
});
