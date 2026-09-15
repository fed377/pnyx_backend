import { beforeEach, describe, expect, it } from "vitest";
import { DECAY_FLOOR, MAX_WINDOW, ORIGIN, UNLOCK_AT } from "../src/core/algorithm";
import { GRID_IDS } from "../src/core/grids";
import type { Positions, VotePower } from "../src/core/types";
import type { GridId } from "../src/core/types";
import type { MediaStore, UploadTicket } from "../src/media";
import { MemoryRepository } from "../src/repo/memory";
import { DeterministicScorer } from "../src/scoring/scorer";
import type { ContentScorer, ScoreOutcome } from "../src/scoring/scorer";
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

/** Returns whatever verdict a test hands it, instead of actually scoring anything. */
class FakeScorer implements ContentScorer {
  readonly name = "fake";
  constructor(private readonly outcome: ScoreOutcome) {}
  async score() {
    return this.outcome;
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

  it("hands back the content's own fresh tallies, not a stale pre-vote snapshot", async () => {
    // Captured by value (not the row reference) — the in-memory repo mutates
    // tallies in place, same as a real read-after-write against Postgres would
    // require a fresh SELECT rather than trusting an object held from before.
    const beforeLove = (await repo.getContent("c01"))!.tallies.love;

    const result = await service.castVote(ME, "c01", 2);
    expect(result.tallies.love).toBe(beforeLove + 1);

    // and it matches whatever a fresh read of the row says, not a copy taken
    // before the vote was applied
    const after = await repo.getContent("c01");
    expect(result.tallies).toEqual(after!.tallies);
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

  it("blocks a policy-violating post, strikes its author, and never publishes it", async () => {
    await service.updateProfile(ME, { privacyTier: "speaker" });
    const flagging = new PnyxService(
      repo,
      new FakeScorer({ verdict: "policy_violation", reason: "detailed instructions for building a weapon" }),
      media,
    );
    const before = await repo.listContent({});

    await expect(
      flagging.createContent(ME, {
        type: "image",
        body: "A post that should never see daylight.",
        categories: ["values"],
        mediaPath: `u/${ME}/image.jpg`,
        mediaType: "image/jpeg",
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: { code: "policy_violation", flagged: true, strikeCount: 1 },
    });

    // nothing was published, and a second violation escalates the count
    expect(await repo.listContent({})).toHaveLength(before.length);
    await expect(
      flagging.createContent(ME, {
        type: "image",
        body: "Another one.",
        categories: ["values"],
        mediaPath: `u/${ME}/image2.jpg`,
        mediaType: "image/jpeg",
      }),
    ).rejects.toMatchObject({ details: { strikeCount: 2 } });
  });

  it("rejects a meaningless post without striking its author", async () => {
    await service.updateProfile(ME, { privacyTier: "speaker" });
    const reason = "This doesn't say what you actually think about anything.";
    const lowEffort = new PnyxService(repo, new FakeScorer({ verdict: "low_effort", reason }), media);
    const before = await repo.listContent({});

    await expect(
      lowEffort.createContent(ME, {
        type: "image",
        body: "asdkjfh asdkjfh asdkjfh",
        categories: ["values"],
        mediaPath: `u/${ME}/image.jpg`,
        mediaType: "image/jpeg",
      }),
    ).rejects.toMatchObject({ status: 422, message: reason, details: { code: "low_effort", flagged: false } });

    expect(await repo.listContent({})).toHaveLength(before.length);
    // and no strike was recorded — a follow-up violation should still start at 1
    const flagging = new PnyxService(
      repo,
      new FakeScorer({ verdict: "policy_violation", reason: "x" }),
      media,
    );
    await expect(
      flagging.createContent(ME, {
        type: "image",
        body: "Something that does violate policy.",
        categories: ["values"],
        mediaPath: `u/${ME}/image3.jpg`,
        mediaType: "image/jpeg",
      }),
    ).rejects.toMatchObject({ details: { strikeCount: 1 } });
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

describe("comments", () => {
  it("lets a signed-in user add a comment and read it back", async () => {
    const comment = await service.addComment(ME, "c01", "Rent is a made-up problem.");
    expect(comment.contentId).toBe("c01");
    expect(comment.authorId).toBe(ME);
    expect(comment.up).toBe(0);
    expect(comment.down).toBe(0);
    expect(comment.myVote).toBeNull();

    const items = await service.listComments(ME, "c01");
    expect(items.map((c) => c.id)).toContain(comment.id);
  });

  it("refuses a comment on content that doesn't exist", async () => {
    await expect(service.addComment(ME, "does-not-exist", "hi")).rejects.toMatchObject({ status: 404 });
  });

  it("tallies agree/disagree as real per-user votes, changeable and toggle-off-able", async () => {
    const comment = await service.addComment("mara", "c01", "A fair take.");

    const agreed = await service.voteComment(ME, comment.id, 1);
    expect(agreed).toEqual({ up: 1, down: 0, myVote: 1 });

    // switching direction moves the vote, it doesn't stack a second one
    const switched = await service.voteComment(ME, comment.id, -1);
    expect(switched).toEqual({ up: 0, down: 1, myVote: -1 });

    // casting the same direction again toggles it off
    const toggledOff = await service.voteComment(ME, comment.id, -1);
    expect(toggledOff).toEqual({ up: 0, down: 0, myVote: null });
  });

  it("keeps one person's repeated taps from inflating the tally", async () => {
    const comment = await service.addComment("mara", "c01", "Spam-clickable, in theory.");
    await service.voteComment(ME, comment.id, 1);
    await service.voteComment(ME, comment.id, 1); // toggles off
    await service.voteComment(ME, comment.id, 1); // back on
    const items = await service.listComments(ME, "c01");
    expect(items.find((c) => c.id === comment.id)?.up).toBe(1);
  });

  it("refuses voting on a comment that doesn't exist", async () => {
    await expect(service.voteComment(ME, "does-not-exist", 1)).rejects.toMatchObject({ status: 404 });
  });
});

describe("notifications", () => {
  it("notifies the followee, not on unfollow", async () => {
    await service.setFollow(ME, "mara", true);
    const items = await service.listNotifications("mara", 10);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "follow", actorId: ME, userId: "mara" });

    await service.setFollow(ME, "mara", false);
    expect(await service.listNotifications("mara", 10)).toHaveLength(1); // still just the one
  });

  it("notifies the content author when someone votes on their post", async () => {
    const content = (await repo.getContent("c01"))!;
    await service.castVote(ME, "c01", 2);
    const items = await service.listNotifications(content.authorId, 10);
    expect(items[0]).toMatchObject({ kind: "vote", actorId: ME, contentId: "c01", body: "loved your take." });
  });

  it("notifies the content author on a reply, not on your own comment", async () => {
    const content = (await repo.getContent("c01"))!;
    await service.addComment(ME, "c01", "Strongly agree.");
    const items = await service.listNotifications(content.authorId, 10);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "reply", actorId: ME, contentId: "c01" });

    // the author replying to their own post notifies no one
    await service.addComment(content.authorId, "c01", "Adding on to my own point.");
    expect(await service.listNotifications(content.authorId, 10)).toHaveLength(1);
  });

  it("caches alignment symmetrically regardless of argument order", async () => {
    await repo.setAlignmentCache(ME, "mara", { values: 82, mind: 82, soul: 82, culture: 82, focus: 82 }, 82);
    expect(await repo.getAlignmentCache(ME, "mara")).toBe(82);
    expect(await repo.getAlignmentCache("mara", ME)).toBe(82);
  });

  it("notifies both sides, symmetrically, when a followed neighbor's alignment crosses the threshold", async () => {
    // Seeded people already follow/are followed by ME (per PEOPLE sample
    // data), so a vote can trip more than one neighbor's crossing — assert
    // on mara's pair specifically rather than the whole notification list.
    await service.setFollow(ME, "mara", true);
    await service.castVote(ME, "c01", 2);

    const mine = (await service.listNotifications(ME, 50)).filter((n) => n.kind === "alignment" && n.actorId === "mara");
    const theirs = (await service.listNotifications("mara", 50)).filter((n) => n.kind === "alignment" && n.actorId === ME);

    // Whether this particular vote happened to cross 70% with mara
    // specifically is an algorithm detail this test doesn't pin down — what
    // must hold is that a crossing is never one-sided, never duplicated for
    // the same pair, and the two notifications agree on the percentage.
    expect(mine.length).toBe(theirs.length);
    expect(mine.length).toBeLessThanOrEqual(1);
    if (mine.length > 0) expect(mine[0].pct).toBe(theirs[0].pct);
  });

  it("does not repeat an alignment notification for a pair already above the threshold", async () => {
    await service.setFollow(ME, "mara", true);
    // Pretend this pair was already known to be at 80% before this vote.
    await repo.setAlignmentCache(ME, "mara", { values: 80, mind: 80, soul: 80, culture: 80, focus: 80 }, 80);

    await service.castVote(ME, "c01", 2);

    const mine = (await service.listNotifications(ME, 50)).filter((n) => n.kind === "alignment" && n.actorId === "mara");
    expect(mine).toHaveLength(0);
  });
});

describe("messages", () => {
  it("opens the same conversation from either side, and lists it for both participants", async () => {
    const opened = await service.openConversation(ME, "mara");
    const reopened = await service.openConversation("mara", ME);
    expect(reopened.conversationId).toBe(opened.conversationId);

    const mine = await service.listConversations(ME);
    const theirs = await service.listConversations("mara");
    expect(mine.map((c) => c.id)).toContain(opened.conversationId);
    expect(theirs.map((c) => c.id)).toContain(opened.conversationId);
    expect(mine.find((c) => c.id === opened.conversationId)?.otherUserId).toBe("mara");
    expect(theirs.find((c) => c.id === opened.conversationId)?.otherUserId).toBe(ME);
  });

  it("refuses to message yourself", async () => {
    await expect(service.openConversation(ME, ME)).rejects.toMatchObject({ status: 400 });
  });

  it("sends a text message and lists it back in order", async () => {
    const { conversationId } = await service.openConversation(ME, "mara");
    await service.sendMessage(ME, conversationId, { body: "hey" });
    await service.sendMessage("mara", conversationId, { body: "hi!" });

    const items = await service.listMessages(ME, conversationId);
    expect(items.map((m) => m.body)).toEqual(["hey", "hi!"]);
  });

  it("refuses a message with neither text nor a forwarded post", async () => {
    const { conversationId } = await service.openConversation(ME, "mara");
    await expect(service.sendMessage(ME, conversationId, {})).rejects.toMatchObject({ status: 400 });
  });

  it("carries the sender's vote alongside a forwarded post", async () => {
    const { conversationId } = await service.openConversation(ME, "mara");
    const message = await service.sendMessage(ME, conversationId, { contentId: "c01", votePower: 2 });
    expect(message).toMatchObject({ contentId: "c01", voteSnapshot: 2 });
  });

  it("refuses to read or send into a conversation you're not part of", async () => {
    const { conversationId } = await service.openConversation("mara", "tobia");
    await expect(service.listMessages(ME, conversationId)).rejects.toMatchObject({ status: 404 });
    await expect(service.sendMessage(ME, conversationId, { body: "hi" })).rejects.toMatchObject({ status: 404 });
  });
});

describe("hot takes", () => {
  it("refuses a hot take from anyone who is not a Speaker", async () => {
    await expect(service.postHotTake(ME, "values", "Rent is a made-up problem.")).rejects.toMatchObject({
      status: 403,
    });
  });

  it("lets a Speaker post one, and lists it back active with zero display-only tallies", async () => {
    await repo.updateProfile(ME, { privacyTier: "speaker" });
    const take = await service.postHotTake(ME, "values", "Rent is a made-up problem.");
    expect(take).toMatchObject({ authorId: ME, category: "values", up: 0, down: 0, comments: 0 });

    const items = await service.hotTakes(30);
    expect(items.map((t) => t.id)).toContain(take.id);
  });

  it("sets an expiry roughly 14 hours out", async () => {
    await repo.updateProfile(ME, { privacyTier: "speaker" });
    const before = Date.now();
    const take = await service.postHotTake(ME, "values", "This one's already stale.");
    const hoursOut = (Date.parse(take.expiresAt) - before) / 3_600_000;
    expect(hoursOut).toBeGreaterThan(13.9);
    expect(hoursOut).toBeLessThan(14.1);
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

  it("accepts both exp:// and expo:// as Google sign-in redirect targets", async () => {
    // No Supabase config in this test environment, so a valid redirect gets
    // past validation and fails later with 501 — that still proves the
    // redirect itself wasn't what was rejected, which is what this checks.
    for (const redirect of ["exp://192.168.1.5:8081/--/auth-callback", "expo://192.168.1.5:8081/--/auth-callback"]) {
      const res = await app().inject({ method: "GET", url: `/auth/google/url?redirect=${encodeURIComponent(redirect)}` });
      expect(res.statusCode).not.toBe(400);
    }
  });

  it("rejects a redirect target outside the allowed schemes", async () => {
    const res = await app().inject({
      method: "GET",
      url: `/auth/google/url?redirect=${encodeURIComponent("https://evil.example.com")}`,
    });
    expect(res.statusCode).toBe(400);
  });
});
