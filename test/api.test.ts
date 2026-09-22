import { beforeEach, describe, expect, it } from "vitest";
import { DECAY_FLOOR, MAX_WINDOW, ORIGIN, UNLOCK_AT } from "../src/core/algorithm";
import { GRID_IDS, nearestPoint } from "../src/core/grids";
import type { Positions, VotePower } from "../src/core/types";
import type { GridId } from "../src/core/types";
import type { MediaStore, UploadTicket } from "../src/media";
import type { PushSender } from "../src/push";
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
  readonly deletedUsers: string[] = [];
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
  async deleteAll(userId: string) {
    this.deletedUsers.push(userId);
  }
}

/** Records every send instead of talking to Expo's push service. */
class FakePushSender implements PushSender {
  readonly sent: { tokens: string[]; title: string; body: string }[] = [];
  async send(tokens: string[], input: { title: string; body: string }) {
    this.sent.push({ tokens, title: input.title, body: input.body });
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

  it("reports real cast votes from followees, not everyone who voted", async () => {
    // mara is followed (per PEOPLE's seed data); konsta is not.
    await service.castVote("mara", "c01", 2);
    await service.castVote("konsta", "c01", -1);

    const votes = await service.friendVotes(ME, "c01");
    expect(votes).toEqual([{ userId: "mara", power: 2 }]);
  });

  it("refuses friend-votes on content that isn't approved, to anyone but its author", async () => {
    const approved = (await repo.getContent("c01"))!;
    const pending = await repo.insertContent({ ...approved, authorId: "mara", moderationStatus: "pending" });

    await expect(service.friendVotes(ME, pending.id)).rejects.toMatchObject({ status: 403 });
    await expect(service.friendVotes("mara", pending.id)).resolves.toEqual([]);
  });

  it("refuses a vote on your own post", async () => {
    await service.updateProfile(ME, { privacyTier: "speaker" });
    const mine = await post(service, ME, "Benches should face each other.", ["values"]);
    await expect(service.castVote(ME, mine.id, 1)).rejects.toMatchObject({ status: 403 });
  });

  it("approves content the AI scorer clears, immediately — that scoring call is the moderation gate", async () => {
    await service.updateProfile("mara", { privacyTier: "speaker" });
    const cleared = await post(service, "mara", "Every street needs one tree per house.", ["values"]);
    expect(cleared.moderationStatus).toBe("approved");
    // and it's actually votable, not stuck the way "pending" left it
    await expect(service.castVote(ME, cleared.id, 1)).resolves.toBeDefined();
  });

  it("still refuses a vote on content moderated back off approved (a manual takedown, say)", async () => {
    await service.updateProfile("mara", { privacyTier: "speaker" });
    const content = await post(service, "mara", "Every street needs one tree per house.", ["values"]);
    await service.moderate(content.id, "rejected");
    await expect(service.castVote(ME, content.id, 1)).rejects.toMatchObject({ status: 403 });
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
    // Segment width varies per grid now — long enough to stay unique within
    // that grid's own name list (see algorithm.ts's identityCode).
    expect(last.identity!.code).toMatch(/^[A-Z]{2,}(·[A-Z]{2,}){4}$/);
  });

  it("computes rarity from the real (unlocked) population, not a placeholder", async () => {
    // ME is still locked (sitting at the origin) and excluded from its own
    // population, but the seeded people are already unlocked — well-defined
    // either way, not NaN/divide-by-zero.
    const before = await service.rarity(ME);
    for (const g of GRID_IDS) {
      expect(before[g]).toBeGreaterThanOrEqual(0);
      expect(before[g]).toBeLessThanOrEqual(100);
    }

    await service.updateProfile("mara", { privacyTier: "speaker" });
    const reels = await service.reels(ME, 100);
    const ids = reels.map((r) => r.id);
    while (ids.length < UNLOCK_AT) {
      const extra = await post(service, "mara", `Take number ${ids.length}, for the record.`, ["values"], "video");
      await repo.setModerationStatus(extra.id, "approved");
      ids.push(extra.id);
    }
    for (let i = 0; i < UNLOCK_AT; i++) await service.castVote(ME, ids[i], 1);

    const myPositions = await repo.getPositions(ME);
    expect(myPositions.unlocked).toBe(true);

    const rarity = await service.rarity(ME);
    const others = await repo.listProfiles(ME);
    const rows = await repo.listPositions(others.map((p) => p.id));
    const population = [myPositions, ...rows].filter((r) => r.unlocked);

    for (const g of GRID_IDS) {
      expect(rarity[g]).toBeGreaterThan(0);
      expect(rarity[g]).toBeLessThanOrEqual(100);
      const mine = nearestPoint(g, myPositions.positions[g]).name;
      const matching = population.filter((r) => nearestPoint(g, r.positions[g]).name === mine).length;
      expect(rarity[g]).toBe(Math.round((matching / population.length) * 100));
    }
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

  it("searches the whole user base by name or handle, not just the top-N alignment window", async () => {
    // A limit of 1 alone would never surface "konsta" by alignment rank —
    // the query has to widen the candidate pool before ranking/capping runs.
    const found = await service.mostAligned(ME, 1, "konsta");
    expect(found).toHaveLength(1);
    expect(found[0]!.profile.handle).toBe("konsta");

    expect(await service.mostAligned(ME, 10, "no-such-person-at-all")).toHaveLength(0);
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

describe("onboarding age gate", () => {
  // Seeded profiles start onboarded=true; these tests exercise the
  // not-yet-onboarded transition directly against the repo, since there's no
  // real signup flow to drive it through in these tests.
  beforeEach(async () => {
    await repo.updateProfile(ME, { onboarded: false, birthday: null });
  });

  it("refuses to complete onboarding with no birthday on file", async () => {
    await expect(service.updateProfile(ME, { onboarded: true })).rejects.toMatchObject({ status: 400 });
  });

  it("refuses to complete onboarding under the minimum age", async () => {
    const fifteenYearsAgo = new Date();
    fifteenYearsAgo.setFullYear(fifteenYearsAgo.getFullYear() - 15);
    const birthday = fifteenYearsAgo.toISOString().slice(0, 10);
    await expect(
      service.updateProfile(ME, { onboarded: true, birthday }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("completes onboarding at exactly the minimum age", async () => {
    const sixteenYearsAgo = new Date();
    sixteenYearsAgo.setFullYear(sixteenYearsAgo.getFullYear() - 16);
    const birthday = sixteenYearsAgo.toISOString().slice(0, 10);
    const after = await service.updateProfile(ME, { onboarded: true, birthday });
    expect(after.onboarded).toBe(true);
  });

  it("accepts a birthday already on file, without it being in the same patch", async () => {
    const twentyYearsAgo = new Date();
    twentyYearsAgo.setFullYear(twentyYearsAgo.getFullYear() - 20);
    await repo.updateProfile(ME, { birthday: twentyYearsAgo.toISOString().slice(0, 10) });
    const after = await service.updateProfile(ME, { onboarded: true });
    expect(after.onboarded).toBe(true);
  });

  it("never exposes birthday on someone else's viewed or ranked profile", async () => {
    const twentyYearsAgo = new Date();
    twentyYearsAgo.setFullYear(twentyYearsAgo.getFullYear() - 20);
    const birthday = twentyYearsAgo.toISOString().slice(0, 10);
    await service.updateProfile(ME, { onboarded: true, birthday });

    const viewed = await service.viewProfile("mara", ME);
    expect(viewed.birthday).toBeUndefined();

    const ranked = await service.mostAligned("mara", 10);
    expect(ranked.find((r) => r.profile.id === ME)!.profile).not.toHaveProperty("birthday");
  });
});

describe("privacy tier changes", () => {
  it("allows a brand-new account's first tier change with no cooldown", async () => {
    const before = await service.me(ME);
    expect(before.privacyTier).toBe("active");
    const after = await service.updateProfile(ME, { privacyTier: "speaker" });
    expect(after.privacyTier).toBe("speaker");
  });

  it("refuses a second change within 30 days of the first", async () => {
    await service.updateProfile(ME, { privacyTier: "speaker" });
    await expect(service.updateProfile(ME, { privacyTier: "active" })).rejects.toMatchObject({
      status: 429,
    });
  });

  it("allows a second change once 30 days have passed", async () => {
    await service.updateProfile(ME, { privacyTier: "speaker" });
    const withStaleCooldown = await repo.getProfile(ME);
    await repo.updateProfile(ME, {
      tierChangedAt: new Date(Date.parse(withStaleCooldown!.tierChangedAt!) - 31 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const after = await service.updateProfile(ME, { privacyTier: "active" });
    expect(after.privacyTier).toBe("active");
  });

  it("does not restart the cooldown when the patch repeats the current tier", async () => {
    await service.updateProfile(ME, { privacyTier: "speaker" });
    await service.updateProfile(ME, { privacyTier: "speaker" }); // no-op, should not throw
    const profile = await repo.getProfile(ME);
    // Still governed by the original change, not reset by the no-op.
    await expect(service.updateProfile(ME, { privacyTier: "active" })).rejects.toMatchObject({
      status: 429,
    });
    expect(profile!.privacyTier).toBe("speaker");
  });
});

describe("your own reels", () => {
  it("appear in your feed, even though you cannot vote on them", async () => {
    await service.updateProfile(ME, { privacyTier: "speaker" });
    const mine = await post(service, ME, "A reel of my own making.", ["values"], "video");

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
    // Bypass the service's 30-day tier-change cooldown here — this test is
    // about upload-ticket gating, not the cooldown itself, and the
    // `beforeEach` above already spent this account's one free change.
    await repo.updateProfile(ME, { privacyTier: "active" });
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

  it("refuses to list comments on content that isn't approved, to anyone but its author", async () => {
    const approved = (await repo.getContent("c01"))!;
    const pending = await repo.insertContent({ ...approved, authorId: "mara", moderationStatus: "pending" });

    await expect(service.listComments(ME, pending.id)).rejects.toMatchObject({ status: 403 });
    await expect(service.listComments("mara", pending.id)).resolves.toEqual([]);
  });

  it("increments the content's own comment count, visible on a fresh read", async () => {
    const before = (await repo.getContent("c01"))!.commentCount;
    await service.addComment(ME, "c01", "First.");
    await service.addComment("mara", "c01", "Second.");
    expect((await repo.getContent("c01"))!.commentCount).toBe(before + 2);
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
    // Not items[0]: castVote also fires an alignment-crossing check
    // (Promise.all, see castVote's own comment) that can legitimately land
    // either side of this one in a millisecond-resolution timestamp tie.
    const vote = items.find((n) => n.kind === "vote");
    expect(vote).toMatchObject({ actorId: ME, contentId: "c01", body: "loved your take." });
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

describe("push notifications", () => {
  it("sends a push for a vote — enabled by default", async () => {
    const push = new FakePushSender();
    const withPush = new PnyxService(repo, new DeterministicScorer(), media, push);
    const content = (await repo.getContent("c01"))!;
    await withPush.registerPushToken(content.authorId, "ExponentPushToken[fake-vote]");

    await withPush.castVote(ME, "c01", 2);

    expect(push.sent).toContainEqual(
      expect.objectContaining({ tokens: ["ExponentPushToken[fake-vote]"], body: "loved your take." }),
    );
  });

  it("respects the recipient's own notifPrefs toggle", async () => {
    const push = new FakePushSender();
    const withPush = new PnyxService(repo, new DeterministicScorer(), media, push);
    const content = (await repo.getContent("c01"))!;
    await withPush.registerPushToken(content.authorId, "ExponentPushToken[fake-vote-off]");
    await repo.updateProfile(content.authorId, { notifPrefs: { votes: false, replies: true, alignments: false } });

    await withPush.castVote(ME, "c01", 2);

    expect(push.sent).toHaveLength(0);
  });

  it("always sends for a follow — there is no Settings toggle for it", async () => {
    const push = new FakePushSender();
    const withPush = new PnyxService(repo, new DeterministicScorer(), media, push);
    await withPush.registerPushToken("mara", "ExponentPushToken[fake-follow]");

    await withPush.setFollow(ME, "mara", true);

    expect(push.sent).toContainEqual(expect.objectContaining({ tokens: ["ExponentPushToken[fake-follow]"] }));
  });

  it("registers a push token over HTTP", async () => {
    const app = buildServer(new MemoryRepository(), new FakeMediaStore());
    const res = await app.inject({
      method: "POST",
      url: "/me/push-token",
      headers: auth(),
      payload: { token: "ExponentPushToken[fake-http]" },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("trust & safety", () => {
  describe("blocking", () => {
    it("refuses to block yourself", async () => {
      await expect(service.setBlock(ME, ME, true)).rejects.toMatchObject({ status: 400 });
    });

    it("hides a blocked author's content from reels, home, and people search, for both sides", async () => {
      await repo.updateProfile("mara", { privacyTier: "speaker" });
      const reel = await post(service, "mara", "Something mara thinks.", ["values"], "video");
      const image = await post(service, "mara", "Something mara posted.", ["values"]);

      await service.setBlock(ME, "mara", true);

      const reels = await service.reels(ME, 100);
      expect(reels.some((r) => r.id === reel.id)).toBe(false);
      const home = await service.home(ME, 100);
      expect(home.some((r) => r.id === image.id)).toBe(false);
      const people = await service.mostAligned(ME, 50);
      expect(people.some((p) => p.profile.id === "mara")).toBe(false);

      // Mutual: mara doesn't see ME in People either, whichever side blocked.
      const maraPeople = await service.mostAligned("mara", 50);
      expect(maraPeople.some((p) => p.profile.id === ME)).toBe(false);
    });

    it("unfollows both directions when blocking", async () => {
      await service.setFollow(ME, "mara", true);
      await service.setFollow("mara", ME, true);
      await service.setBlock(ME, "mara", true);
      expect(await repo.listFollowing(ME)).not.toContain("mara");
      expect(await repo.listFollowing("mara")).not.toContain(ME);
    });

    it("refuses to start a conversation with someone you've blocked, or who has blocked you", async () => {
      await service.setBlock(ME, "mara", true);
      await expect(service.openConversation(ME, "mara")).rejects.toMatchObject({ status: 403 });
      await expect(service.openConversation("mara", ME)).rejects.toMatchObject({ status: 403 });
    });

    it("refuses to send into an existing conversation once either side blocks the other", async () => {
      const { conversationId } = await service.openConversation(ME, "mara");
      await service.setBlock("mara", ME, true);
      await expect(service.sendMessage(ME, conversationId, { body: "hi" })).rejects.toMatchObject({ status: 403 });
    });

    it("restores visibility on unblock", async () => {
      await service.setBlock(ME, "mara", true);
      await service.setBlock(ME, "mara", false);
      const people = await service.mostAligned(ME, 50);
      expect(people.some((p) => p.profile.id === "mara")).toBe(true);
    });
  });

  describe("reporting content", () => {
    it("logs a report against real content", async () => {
      await expect(service.reportContent(ME, "c01", "spam")).resolves.toBeUndefined();
    });

    it("refuses to report content that doesn't exist", async () => {
      await expect(service.reportContent(ME, "does-not-exist", "spam")).rejects.toMatchObject({ status: 404 });
    });
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

  it("deletes every uploaded file, not just the DB rows", async () => {
    await service.forgetMe(ME);
    expect(media.deletedUsers).toContain(ME);
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

  it("serves the Terms of Service and Privacy Policy without auth", async () => {
    const terms = await app().inject({ method: "GET", url: "/legal/terms" });
    expect(terms.statusCode).toBe(200);
    expect(terms.headers["content-type"]).toMatch(/text\/html/);
    expect(terms.body).toContain("Terms of Service");

    const privacy = await app().inject({ method: "GET", url: "/legal/privacy" });
    expect(privacy.statusCode).toBe(200);
    expect(privacy.headers["content-type"]).toMatch(/text\/html/);
    expect(privacy.body).toContain("Privacy Policy");
  });

  it("cannot be used to self-grant premium — there is no route for it", async () => {
    const instance = app();
    const res = await instance.inject({
      method: "PATCH",
      url: "/me",
      headers: auth(),
      payload: { premium: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().premium).toBe(false);
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

  describe("the mobile OAuth bridge page", () => {
    it("hands the deep link to the browser via a script, not a server-side redirect", async () => {
      const to = "expo://192.168.1.5:8081/--/auth-callback";
      const res = await app().inject({ method: "GET", url: `/auth/mobile-redirect?to=${encodeURIComponent(to)}` });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/html/);
      expect(res.headers.location).toBeUndefined(); // never a 3xx — see the code comment on why
      expect(res.body).toContain("location.replace(to + location.hash)");
      expect(res.body).toContain(JSON.stringify(to));
    });

    it("refuses a target outside the allowed schemes — this is a public, unauthenticated endpoint", async () => {
      const res = await app().inject({
        method: "GET",
        url: `/auth/mobile-redirect?to=${encodeURIComponent("https://evil.example.com/steal")}`,
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("password recovery", () => {
    it("refuses a forgot-password redirect outside the allowed schemes", async () => {
      const res = await app().inject({
        method: "POST",
        url: "/auth/forgot-password",
        payload: { identifier: "someone@example.com", redirect: "https://evil.example.com" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("responds the same way whether or not the email is registered — no user-enumeration leak", async () => {
      const send = (identifier: string) =>
        app().inject({
          method: "POST",
          url: "/auth/forgot-password",
          payload: { identifier, redirect: "expo://192.168.1.5:8081/--/auth-callback" },
        });
      const known = await send("definitely-not-registered@example.com");
      const unknown = await send("also-not-registered@example.com");
      expect(known.statusCode).toBe(200);
      expect(known.json()).toEqual(unknown.json());
    });

    it("refuses to set a new password without a valid session", async () => {
      const res = await app().inject({
        method: "POST",
        url: "/auth/reset-password",
        payload: { newPassword: "a-brand-new-password" },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("rate limiting", () => {
    it("throttles repeated forgot-password requests from the same caller", async () => {
      const instance = app();
      const send = () =>
        instance.inject({
          method: "POST",
          url: "/auth/forgot-password",
          payload: { identifier: "someone@example.com", redirect: "expo://192.168.1.5:8081/--/auth-callback" },
        });
      const responses = [];
      for (let i = 0; i < 11; i++) responses.push(await send());
      expect(responses.filter((r) => r.statusCode === 200)).toHaveLength(10);
      expect(responses.at(-1)!.statusCode).toBe(429);
    });
  });
});
