import { describe, expect, it } from "vitest";
import { computePositions } from "../src/core/algorithm";
import { GRID_IDS } from "../src/core/grids";
import type { Scores, Vote } from "../src/core/types";
import { checkManifestIntegrity, manifestSchema, rngFor } from "../scripts/seed/lib";
import { buildTimeline, MIN_VOTES, planFollows, planVotes, postTimeFraction } from "../scripts/seed/simulation";
import example from "../scripts/seed/manifest.example.json";

const manifest = manifestSchema.parse(example);

function randomScores(i: number): Scores {
  const rng = rngFor("scores", i);
  return Object.fromEntries(
    GRID_IDS.map((g) => [g, { x: rng() * 2 - 1, y: rng() * 2 - 1, confidence: 0.3 + rng() * 0.6 }]),
  ) as Scores;
}

const candidates = Array.from({ length: 150 }, (_, i) => ({
  postKey: `post-${i}`,
  scores: randomScores(i),
  timeFraction: postTimeFraction(1, `post-${i}`),
}));

describe("seed manifest", () => {
  it("the example manifest is valid", () => {
    expect(() => checkManifestIntegrity(manifest)).not.toThrow();
  });
});

describe("planVotes", () => {
  const persona = manifest.personas[0]!;

  it("is deterministic for a given seed", () => {
    expect(planVotes(persona, candidates, 1)).toEqual(planVotes(persona, candidates, 1));
    expect(planVotes(persona, candidates, 1)).not.toEqual(planVotes(persona, candidates, 2));
  });

  it("votes enough to unlock, oldest posts first", () => {
    const plan = planVotes(persona, candidates, 1);
    expect(plan.length).toBeGreaterThanOrEqual(MIN_VOTES);
    const fractions = plan.map((v) => postTimeFraction(1, v.postKey));
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
  });

  it("produces a plausible, positively skewed split", () => {
    const counts = { 2: 0, 1: 0, [-1]: 0, [-2]: 0 } as Record<number, number>;
    for (const p of manifest.personas) for (const v of planVotes(p, candidates, 1)) counts[v.power]!++;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(counts[1]! + counts[2]!).toBeGreaterThan(total * 0.5);
    expect(counts[-2]!).toBeGreaterThan(0);
    expect(counts[-2]!).toBeLessThan(counts[-1]!);
  });

  it("loves what sits close to the persona more often than what sits far away", () => {
    const near: Scores = Object.fromEntries(
      GRID_IDS.map((g) => [g, { ...persona.truePosition[g], confidence: 0.9 }]),
    ) as Scores;
    const far: Scores = Object.fromEntries(
      GRID_IDS.map((g) => [g, { x: -persona.truePosition[g].x, y: -persona.truePosition[g].y, confidence: 0.9 }]),
    ) as Scores;
    const pool = [
      ...candidates,
      { postKey: "near", scores: near, timeFraction: 0.5 },
      { postKey: "far", scores: far, timeFraction: 0.5 },
    ];
    const everything = { ...persona, temperament: { ...persona.temperament, activity: 1 } };
    const plan = planVotes(everything, pool, 1);
    expect(plan.find((v) => v.postKey === "near")!.power).toBeGreaterThan(0);
    expect(plan.find((v) => v.postKey === "far")!.power).toBeLessThan(0);
  });
});

describe("planFollows", () => {
  it("never follows yourself or a private profile", () => {
    const privateKeys = new Set(manifest.personas.filter((p) => p.tier === "private").map((p) => p.key));
    for (const [a, b] of planFollows(manifest.personas, 1)) {
      expect(a).not.toBe(b);
      expect(privateKeys.has(b)).toBe(false);
    }
  });
});

describe("buildTimeline", () => {
  const now = Date.parse("2026-09-26T12:00:00Z");
  const posts = candidates.slice(0, 80).map((c) => ({ key: c.postKey, authorKey: "someone-else" }));
  const persona = manifest.personas[0]!;
  const order = planVotes(persona, candidates.slice(0, 80), 1).map((v) => v.postKey);
  const timeline = buildTimeline({
    seed: 1,
    now,
    spanDays: 30,
    posts,
    castOrder: { [persona.key]: order },
    comments: [],
    personaKeys: [persona.key],
  });

  it("keeps each voter's votes strictly increasing in cast order, after the post and not in the future", () => {
    const postAt = new Map(timeline.content.map((c) => [c.key, c.at]));
    const times = timeline.votes.map((v) => v.at);
    expect(timeline.votes.map((v) => v.postKey)).toEqual(order);
    for (let i = 1; i < times.length; i++) expect(times[i]!).toBeGreaterThan(times[i - 1]!);
    for (const v of timeline.votes) expect(v.at).toBeGreaterThan(postAt.get(v.postKey)!);
    expect(Math.max(...times)).toBeLessThanOrEqual(now + times.length * 1000);
  });

  it("does not change the replayed positions — only order matters to the decay replay", () => {
    const scores = new Map(candidates.map((c) => [c.postKey, c.scores]));
    const plan = new Map(planVotes(persona, candidates.slice(0, 80), 1).map((v) => [v.postKey, v.power]));
    const asCast: Vote[] = order.map((k, i) => ({ contentId: k, power: plan.get(k)!, at: i, scores: scores.get(k)! }));
    const backdated: Vote[] = timeline.votes.map((v) => ({
      contentId: v.postKey,
      power: plan.get(v.postKey)!,
      at: v.at,
      scores: scores.get(v.postKey)!,
    }));
    expect(computePositions(backdated)).toEqual(computePositions(asCast));
  });

  it("has every account join before its first activity", () => {
    const first = Math.min(...timeline.votes.map((v) => v.at));
    expect(timeline.profiles[0]!.at).toBeLessThan(first);
  });
});
