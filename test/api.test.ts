import { beforeEach, describe, expect, it } from "vitest";
import { DECAY_FLOOR, MAX_WINDOW, ORIGIN, UNLOCK_AT } from "../src/core/algorithm";
import { GRID_IDS } from "../src/core/grids";
import type { Positions, VotePower } from "../src/core/types";
import type { GridId } from "../src/core/types";
import type { MediaStore, UploadTicket } from "../src/media";
import { MemoryRepository } from "../src/repo/memory";
import { DeterministicScorer } from "../src/scoring/scorer";
import { PnyxService } from "../src/service";
import { buildServer } from "../src/server";

const ME = "me";
const auth = (id = ME) => ({ authorization: `Bearer dev:${id}` });

/** Pretends every upload landed, and records what was asked for. */
class FakeMediaStore implements MediaStore {
  readonly tickets: string[] = [];
  async createUploadTicket(userId: string, contentType: string): Promise<UploadTicket> {
    this.tickets.push(`${userId}:${contentType}`);
    return {
      path: `u/${userId}/fake.bin`,
      uploadUrl: "https://example.test/upload",
      publicUrl: `https://cdn.test/${userId}/fake.bin`,
      kind: contentType.startsWith("video") ? "video" : "image",
    };
  }
  async exists(path: string) {
    return !path.includes("missing");
  }
  publicUrl(path: string) {
    return `https://cdn.test/${path}`;
  }
}

let repo: MemoryRepository;
let media: FakeMediaStore;
let service: PnyxService;

beforeEach(() => {
  repo = new MemoryRepository();
  media = new FakeMediaStore();
  service = new PnyxService(repo, new DeterministicScorer(), media);
});

/** Posting now always carries media; this keeps the call sites readable. */
const post = (
  svc: PnyxService,
  userId: string,
  body: string,
  categories: GridId[],
  type: "image" | "video" = "image",
  mediaPath?: string,
) =>
  svc.createContent(userId, {
    type,
    body,
    categories,
    mediaPath: mediaPath ?? `u/${userId}/${type}.${type === "image" ? "jpg" : "mp4"}`,
    mediaType: type === "image" ? "image/jpeg" : "video/mp4",
  });

const moved = (p: Positions) =>
  GRID_IDS.some((g) => p[g].x !== ORIGIN[g].x || p[g].y !== ORIGIN[g].y);

describe("the vote pipeline", () => {
  it("moves the voter's position, derived from the vote and not supplied", async () => {
    const before = await repo.getPositions(ME);
    expect(moved(before.positions)).toBe(false);

    const result = await service.castVote(ME, "c01", 1);

    expect(result.voteCount).toBe(1);
    expect(moved(result.positions)).toBe(true);
    // and it was persisted, not just returned
    const after = await repo.getPositions(ME);
    expect(after.positions).toEqual(result.positions);
  });

  it("moves further on a love than on a like", async () => {
    const liked = await service.castVote(ME, "c01", 1);
    const likeShift = Math.abs(liked.positions.values.x);

    const fresh = new PnyxService(new MemoryRepository(), new DeterministicScorer(), new FakeMediaStore());
    const loved = await fresh.castVote(ME, "c01", 2);
    expect(Math.abs(loved.positions.values.x)).toBeGreaterThan(likeShift);
  });

  it("moves away from content on a dislike", async () => {
    const liked = await service.castVote(ME, "c01", 1);
    const fresh = new PnyxService(new MemoryRepository(), new DeterministicScorer(), new FakeMediaStore());
    const disliked = await fresh.castVote(ME, "c01", -1);
    // c01 sits at positive x on Values, so a like pulls toward it and a dislike pushes off it
    expect(liked.positions.values.x).toBeGreaterThan(0);
    expect(disliked.positions.values.x).toBeLessThan(0);
  });

  it("replaces a previous reaction rather than stacking a second one", async () => {
    await service.castVote(ME, "c01", 1);
    const second = await service.castVote(ME, "c01", -2);

    expect(second.voteCount).toBe(1);
    expect(second.replaced).toBe(1);

    const content = await repo.getContent("c01");
    // the like was taken back off the tally and the hate added
    expect(content!.tallies.like).toBe(44 - 1 + 1); // seeded 44, +1 then -1
    expect(content!.tallies.hate).toBe(7 + 1);
  });

  it("refuses a vote on your own post", async () => {
    await service.updateProfile(ME, { privacyTier: "speaker" });
    const mine = await post(service, ME, "Benches should face each other.", ["values"]);
    await expect(service.castVote(ME, mine.id, 1)).rejects.toMatchObject({ status: 403 });
  });

  it("refuses a vote on content that has not cleared moderation", async () => {
    await service.updateProfile("mara", { privacyTier: "speaker" });
    const pending = await post(service, "mara", "Every street needs one tree per house.", ["values"]);
    expect(pending.moderationStatus).toBe("pending");
    await expect(service.castVote(ME, pending.id, 1)).rejects.toMatchObject({ status: 403 });
  });

  it("refuses a vote on content that does not exist", async () => {
    await expect(service.castVote(ME, "nope", 1)).rejects.toMatchObject({ status: 404 });
  });
});

describe("the unlock rule", () => {
  it("stays locked below 50 reactions and unlocks at 50", async () => {
    const reels = await service.reels(ME, 100);
    expect(reels.length).toBeGreaterThan(0);

    // Vote on the same items repeatedly is not possible (re-voting replaces), so
    // seed enough distinct content to cross the threshold.
    await service.updateProfile("mara", { privacyTier: "speaker" });
    const ids: string[] = reels.map((r) => r.id);
    while (ids.length < UNLOCK_AT) {
      const extra = await post(
        service,
        "mara",
        `A take that needs saying, number ${ids.length}.`,
        ["values", "mind"],
        "video",
      );
      await repo.setModerationStatus(extra.id, "approved");
      ids.push(extra.id);
    }

    for (let i = 0; i < UNLOCK_AT - 1; i++) {
      const r = await service.castVote(ME, ids[i], i % 2 === 0 ? 1 : -1);
      expect(r.unlocked).toBe(false);
      expect(r.identity).toBeNull();
    }

    const last = await service.castVote(ME, ids[UNLOCK_AT - 1], 1);
    expect(last.voteCount).toBe(UNLOCK_AT);
    expect(last.unlocked).toBe(true);
    expect(last.identity).not.toBeNull();
    expect(last.identity!.code).toMatch(/^[A-Z]{2}(·[A-Z]{2}){4}$/);
  });
});

describe("alignment", () => {
  it("is 100% with yourself and symmetric between two people", async () => {
    const self = await service.viewProfile("mara", "mara");
    expect(self.alignment!.total).toBeCloseTo(100, 6);

    const ab = await service.viewProfile("mara", "tobia");
    const ba = await service.viewProfile("tobia", "mara");
    expect(ab.alignment!.total).toBeCloseTo(ba.alignment!.total, 6);
  });

  it("hides a private person's positions but still scores alignment", async () => {
    const konsta = await service.viewProfile(ME, "konsta");
    expect(konsta.privacyTier).toBe("private");
    expect(konsta.positions).toBeNull();
    expect(konsta.identity).toBeNull();
    expect(konsta.alignment!.total).toBeGreaterThan(0);
  });

  it("withholds per-grid numbers for grids kept private", async () => {
    await service.updateProfile("mara", {
      gridPublic: { values: true, mind: false, soul: true, culture: false, focus: true },
    });
    const view = await service.viewProfile(ME, "mara");
    expect(Object.keys(view.alignment!.perGrid).sort()).toEqual(["focus", "soul", "values"]);
    expect(view.alignment!.total).toBeGreaterThan(0);
  });

  it("ranks the most aligned people first", async () => {
    const top = await service.mostAligned(ME, 10);
    expect(top).toHaveLength(10);
    const totals = top.map((t) => t.total);
    expect([...totals].sort((a, b) => b - a)).toEqual(totals);
  });
});

describe("the decay window", () => {
  it("caps the active window at ~250 votes", () => {
    // 0.99^250 is the documented floor; the 251st-oldest vote falls out.
    expect(DECAY_FLOOR).toBeLessThan(0.99 ** (MAX_WINDOW - 1));
    expect(0.99 ** MAX_WINDOW).toBeLessThan(DECAY_FLOOR);
  });
});

describe("contributing", () => {
  it("refuses posts from anyone who is not a Speaker", async () => {
    await expect(
      post(service, ME, "A take from a non-speaker.", ["mind"]),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("scores a new post on the grids the author selected", async () => {
    await service.updateProfile(ME, { privacyTier: "speaker" });
    const row = await post(service, ME, "Museums should stay open until midnight.", ["values", "culture"]);
    expect(row.scorer).toBe("deterministic-stub");
    expect(row.scores.values.confidence).toBeGreaterThan(0.3);
    // grids the author did not pick get a near-central, low-confidence point
    expect(row.scores.focus.confidence).toBeLessThan(0.2);
    expect(row.scores.focus.x).toBe(0);
  });
});

describe("your own reels", () => {
  it("appear in your feed, even though you cannot vote on them", async () => {
    await service.updateProfile(ME, { privacyTier: "speaker" });
    const mine = await post(service, ME, "A reel of my own making.", ["values"], "video");
    await repo.setModerationStatus(mine.id, "approved");

    const reels = await service.reels(ME, 100);
    expect(reels.some((r) => r.id === mine.id)).toBe(true);
    // Seeing it is fine; voting on it is not (spec §5).
    await expect(service.castVote(ME, mine.id, 1)).rejects.toMatchObject({ status: 403 });
  });
});

describe("uploads", () => {
  beforeEach(async () => {
    await service.updateProfile(ME, { privacyTier: "speaker" });
  });

  it("issues an upload ticket under the caller's own prefix", async () => {
    const ticket = await service.createUploadTicket(ME, "image/jpeg");
    expect(ticket.path.startsWith(`u/${ME}/`)).toBe(true);
    expect(ticket.uploadUrl).toMatch(/^https:/);
    expect(media.tickets).toEqual([`${ME}:image/jpeg`]);
  });

  it("refuses an upload ticket to anyone who is not a Speaker", async () => {
    await service.updateProfile(ME, { privacyTier: "active" });
    await expect(service.createUploadTicket(ME, "image/jpeg")).rejects.toMatchObject({ status: 403 });
  });

  it("stores the public URL of the uploaded file on the post", async () => {
    const row = await post(service, ME, "A bench facing another bench.", ["values"]);
    expect(row.mediaUrl).toBe(`https://cdn.test/u/${ME}/image.jpg`);
    expect(row.type).toBe("image");
  });

  it("refuses a post whose file was never uploaded", async () => {
    await expect(
      post(service, ME, "This one has no file behind it.", ["values"], "image", `u/${ME}/missing.jpg`),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses to attach someone else's upload", async () => {
    await expect(
      post(service, ME, "Claiming a file I do not own.", ["values"], "image", "u/mara/image.jpg"),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("refuses a video file posted as an image", async () => {
    await expect(
      service.createContent(ME, {
        type: "image",
        body: "Mislabelled on purpose.",
        categories: ["values"],
        mediaPath: `u/${ME}/clip.mp4`,
        mediaType: "video/mp4",
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses a media type outside the allowed set", async () => {
    await expect(service.createUploadTicket(ME, "application/pdf")).rejects.toMatchObject({ status: 415 });
  });
});

describe("right to be forgotten", () => {
  it("erases the profile, its positions and its votes", async () => {
    await service.castVote(ME, "c01", 2);
    expect(await repo.countVotes(ME)).toBe(1);

    await service.forgetMe(ME);

    expect(await repo.getProfile(ME)).toBeNull();
    expect(await repo.countVotes(ME)).toBe(0);
    const positions = await repo.getPositions(ME);
    expect(moved(positions.positions)).toBe(false);
  });
});

describe("http layer", () => {
  const app = () => buildServer(new MemoryRepository(), new FakeMediaStore());

  it("serves health without auth", async () => {
    const res = await app().inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, unlockAt: UNLOCK_AT });
  });

  it("rejects unauthenticated requests", async () => {
    const res = await app().inject({ method: "GET", url: "/me" });
    expect(res.statusCode).toBe(401);
  });

  it("casts a vote over HTTP and returns the new position", async () => {
    const res = await app().inject({
      method: "POST",
      url: "/votes",
      headers: auth(),
      payload: { contentId: "c01", power: 2 satisfies VotePower },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.voteCount).toBe(1);
    expect(body.unlockIn).toBe(UNLOCK_AT - 1);
    expect(moved(body.positions)).toBe(true);
  });

  it("rejects a vote power the spec does not define", async () => {
    const res = await app().inject({
      method: "POST",
      url: "/votes",
      headers: auth(),
      payload: { contentId: "c01", power: 5 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("never exposes a route to write positions directly", async () => {
    const server = app();
    for (const url of ["/positions", "/me/positions", "/grid_positions"]) {
      const res = await server.inject({ method: "POST", url, headers: auth(), payload: {} });
      expect(res.statusCode).toBe(404);
    }
  });

  it("rejects a text-only post outright", async () => {
    const res = await app().inject({
      method: "POST",
      url: "/content",
      headers: auth(),
      payload: { type: "text", body: "A text-only take.", categories: ["mind"] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("serves reels", async () => {
    const res = await app().inject({ method: "GET", url: "/feed/reels?limit=5", headers: auth() });
    expect(res.statusCode).toBe(200);
    const { items } = res.json();
    expect(items).toHaveLength(5);
    expect(items.every((i: { type: string }) => i.type === "video")).toBe(true);
  });
});
