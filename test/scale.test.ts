import { describe, expect, it, vi } from "vitest";
import { freshnessMultiplier, qualityMultiplier, rankReels } from "../src/core/feed";
import { ORIGIN } from "../src/core/algorithm";
import { GRID_IDS } from "../src/core/grids";
import { DeterministicScorer } from "../src/scoring/scorer";
import { NullMediaStore } from "../src/media";
import { ME_ID as ME } from "../src/core/data";
import { MemoryRepository } from "../src/repo/memory";
import { PnyxService } from "../src/service";
import type { Scores } from "../src/core/types";

const scores = (): Scores => {
  const out = {} as Scores;
  for (const g of GRID_IDS) out[g] = { x: 0, y: 0, confidence: 1 };
  return out;
};
const none = { love: 0, like: 0, dislike: 0, hate: 0 };

describe("ranking signals", () => {
  it("leaves a reel alone until enough people have watched it", () => {
    expect(qualityMultiplier(5, 0)).toBe(1);
    expect(qualityMultiplier(100, 90)).toBeGreaterThan(qualityMultiplier(100, 20));
  });

  it("favours newer reels", () => {
    const now = Date.now();
    expect(freshnessMultiplier(now, now)).toBeGreaterThan(freshnessMultiplier(now - 30 * 864e5, now));
  });

  it("keeps one creator from filling a stretch of the feed", () => {
    const reels = Array.from({ length: 12 }, (_, i) => ({
      id: `r${i}`,
      scores: scores(),
      author: i < 8 ? "prolific" : `a${i}`,
    }));
    const ranked = rankReels(reels, structuredClone(ORIGIN), 50, () => none, {
      signals: (c) => ({ authorId: c.author, createdAtMs: 0, views: 0, completionSum: 0 }),
    });
    expect(ranked.slice(0, 6).filter((c) => c.author === "prolific").length).toBeLessThanOrEqual(2);
    expect(ranked).toHaveLength(12);
  });
});

describe("reel paging and views", () => {
  const setup = () => {
    const repo = new MemoryRepository();
    return { repo, service: new PnyxService(repo, new DeterministicScorer(), new NullMediaStore()) };
  };

  it("doesn't repeat reels the client already has", async () => {
    const { service } = setup();
    const first = await service.reels(ME, 2);
    const second = await service.reels(ME, 2, first.map((r) => r.id));
    expect(first.length).toBeGreaterThan(0);
    expect(second.some((r) => first.some((f) => f.id === r.id))).toBe(false);
  });

  it("moves watched reels behind unwatched ones, without emptying the feed", async () => {
    const { service } = setup();
    const all = await service.reels(ME, 100);
    await service.recordReelViews(ME, [{ contentId: all[0].id, watchMs: 4000, completion: 1 }]);
    const after = await service.reels(ME, 100);
    expect(after).toHaveLength(all.length);
    expect(after.findIndex((r) => r.id === all[0].id)).toBeGreaterThan(0);
  });
});

describe("after a vote", () => {
  const setup = async (push: { send: ReturnType<typeof vi.fn> }, windowMs: number) => {
    const repo = new MemoryRepository();
    const service = new PnyxService(repo, new DeterministicScorer(), new NullMediaStore(), push as never, undefined, {
      deferWork: true,
      voteNotifyWindowMs: windowMs,
    });
    return { repo, service };
  };

  it("answers without waiting for notifications", async () => {
    const { repo, service } = await setup({ send: vi.fn(() => new Promise(() => {})) }, 0);
    const result = await service.castVote(ME, "c01", 1);
    expect(result.voteCount).toBe(1);
    expect((await repo.recentVotes(ME, 1))[0].contentId).toBe("c01");
  });

  it("rolls several votes on one post into one notification", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const { repo, service } = await setup({ send: vi.fn(async () => {}) }, 1000);
      const author = (await repo.getContent("c01"))!.authorId;
      const voters = (await repo.listProfiles(author)).slice(0, 3).map((p) => p.id);
      for (const v of voters) await service.castVote(v, "c01", 1);
      expect((await repo.listNotifications(author, 50)).filter((n) => n.kind === "vote")).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(async () => {
        const notes = (await repo.listNotifications(author, 50)).filter((n) => n.kind === "vote");
        expect(notes).toHaveLength(1);
        expect(notes[0].body).toBe("and 2 others reacted to your take.");
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
