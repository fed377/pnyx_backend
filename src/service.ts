import {
  computePositions,
  conviction,
  identityCode,
  MAX_WINDOW,
  perGridAlignment,
  totalAlignment,
  UNLOCK_AT,
} from "./core/algorithm";
import { affinity, rankReels } from "./core/feed";
import { GRID_IDS, nearestPoint, orientationOf } from "./core/grids";
import type { GridId, Positions, Vote, VotePower } from "./core/types";
import { ApiError, bucketOf } from "./domain";
import type { ContentRow, ProfileRow } from "./domain";
import { mimeKind, pathBelongsTo, type MediaStore } from "./media";
import type { Repository } from "./repo/types";
import type { ContentScorer, ScorableContent } from "./scoring/scorer";

export type IdentitySummary = {
  code: string | null;
  conviction: number;
  grids: Record<GridId, { name: string; orientation: string; meaning: string; hex?: string; animal?: string }>;
};

export type PublicProfile = ProfileRow & {
  positions: Positions | null;
  voteCount: number;
  unlocked: boolean;
  identity: IdentitySummary | null;
  alignment?: { total: number; perGrid: Record<GridId, number> };
};

function summarise(positions: Positions, unlocked: boolean): IdentitySummary | null {
  if (!unlocked) return null;
  const grids = {} as IdentitySummary["grids"];
  for (const g of GRID_IDS) {
    const near = nearestPoint(g, positions[g]);
    grids[g] = {
      name: near.name,
      orientation: orientationOf(g, positions[g]),
      meaning: near.meaning,
      hex: near.hex,
      animal: near.animal,
    };
  }
  return { code: identityCode(positions), conviction: conviction(positions), grids };
}

export class PnyxService {
  constructor(
    private readonly repo: Repository,
    private readonly scorer: ContentScorer,
    private readonly media: MediaStore,
  ) {}

  /* ── Positions ──────────────────────────────────────────────────────────── */

  /**
   * Replays the decay window from the origin. Positions are always derived here
   * and never accepted from a client — that is the integrity property the whole
   * product rests on.
   */
  private async recomputePositions(userId: string): Promise<{ positions: Positions; voteCount: number }> {
    const recent = await this.repo.recentVotes(userId, MAX_WINDOW);
    const chronological: Vote[] = recent
      .slice()
      .reverse()
      .map((v) => ({
        contentId: v.contentId,
        power: v.power,
        at: Date.parse(v.createdAt),
        scores: v.scoresSnapshot,
      }));
    const positions = computePositions(chronological);
    const voteCount = await this.repo.countVotes(userId);
    await this.repo.savePositions(userId, positions, voteCount);
    return { positions, voteCount };
  }

  async castVote(userId: string, contentId: string, power: VotePower) {
    const content = await this.repo.getContent(contentId);
    if (!content) throw new ApiError(404, "no such content");
    // Spec §5: you cannot vote on your own posts.
    if (content.authorId === userId) throw new ApiError(403, "you can't vote on your own post");
    if (content.moderationStatus !== "approved") throw new ApiError(403, "content is not available for voting");

    const { previousPower } = await this.repo.upsertVote({
      userId,
      contentId,
      power,
      // Snapshot so the window can be replayed even if the item is re-scored later.
      scoresSnapshot: content.scores,
    });

    const delta: Partial<Record<"love" | "like" | "dislike" | "hate", number>> = {};
    if (previousPower !== null) delta[bucketOf(previousPower)] = (delta[bucketOf(previousPower)] ?? 0) - 1;
    delta[bucketOf(power)] = (delta[bucketOf(power)] ?? 0) + 1;
    await this.repo.adjustTallies(contentId, delta);

    const { positions, voteCount } = await this.recomputePositions(userId);
    const unlocked = voteCount >= UNLOCK_AT;

    return {
      positions,
      voteCount,
      unlocked,
      unlockIn: Math.max(0, UNLOCK_AT - voteCount),
      replaced: previousPower,
      identity: summarise(positions, unlocked),
    };
  }

  /* ── Profiles and alignment ─────────────────────────────────────────────── */

  async me(userId: string): Promise<PublicProfile> {
    const profile = await this.repo.getProfile(userId);
    if (!profile) throw new ApiError(404, "no such profile");
    const row = await this.repo.getPositions(userId);
    return {
      ...profile,
      positions: row.positions,
      voteCount: row.voteCount,
      unlocked: row.unlocked,
      identity: summarise(row.positions, row.unlocked),
    };
  }

  /**
   * The caller's own votes, oldest first, with the score snapshots. Lets the
   * client show what it already reacted to and redraw its own trajectory
   * (Statistics) without the server having to store position history.
   */
  async myVotes(userId: string): Promise<Vote[]> {
    const votes = await this.repo.recentVotes(userId, MAX_WINDOW);
    return votes
      .slice()
      .reverse()
      .map((v) => ({
        contentId: v.contentId,
        power: v.power,
        at: Date.parse(v.createdAt),
        scores: v.scoresSnapshot,
      }));
  }

  /** What `viewer` is allowed to see of `targetId`, plus their alignment. */
  async viewProfile(viewerId: string, targetId: string): Promise<PublicProfile> {
    const profile = await this.repo.getProfile(targetId);
    if (!profile) throw new ApiError(404, "no such profile");
    const [target, viewer] = await Promise.all([
      this.repo.getPositions(targetId),
      this.repo.getPositions(viewerId),
    ]);

    const perGrid = perGridAlignment(viewer.positions, target.positions);
    // Grids the target keeps private are withheld from the per-grid breakdown,
    // but still count toward the total — the total is what the product promises.
    const visible = {} as Record<GridId, number>;
    for (const g of GRID_IDS) if (profile.gridPublic[g]) visible[g] = perGrid[g];

    const hidden = profile.privacyTier === "private";
    return {
      ...profile,
      positions: hidden ? null : target.positions,
      voteCount: target.voteCount,
      unlocked: target.unlocked,
      identity: hidden ? null : summarise(target.positions, target.unlocked),
      alignment: {
        total: totalAlignment(viewer.positions, target.positions),
        perGrid: visible,
      },
    };
  }

  /**
   * Spec §6.3: the ten most-aligned people in the world, more behind premium.
   * Linear over the user base — fine for a bounded pilot, needs a spatial index
   * or precomputed cache before it is asked of a real population.
   */
  async mostAligned(userId: string, limit: number) {
    const [viewer, others, following, followers] = await Promise.all([
      this.repo.getPositions(userId),
      this.repo.listProfiles(userId),
      this.repo.listFollowing(userId),
      this.repo.listFollowers(userId),
    ]);
    const positions = await this.repo.listPositions(others.map((p) => p.id));
    const byId = new Map(positions.map((p) => [p.userId, p]));
    const iFollow = new Set(following);
    const followsMe = new Set(followers);

    return others
      .map((profile) => {
        const row = byId.get(profile.id)!;
        return {
          profile,
          total: totalAlignment(viewer.positions, row.positions),
          voteCount: row.voteCount,
          unlocked: row.unlocked,
          following: iFollow.has(profile.id),
          follower: followsMe.has(profile.id),
          // Private people are still ranked, but their coordinates are withheld.
          positions: profile.privacyTier === "private" ? null : row.positions,
        };
      })
      .sort((a, b) => b.total - a.total)
      .slice(0, limit);
  }

  async updateProfile(userId: string, patch: Partial<ProfileRow>): Promise<PublicProfile> {
    const current = await this.repo.getProfile(userId);
    if (!current) throw new ApiError(404, "no such profile");
    // Spec §6.5 rate-limits tier changes to one per period, but leaves the period
    // TBD, so nothing is enforced here yet. profiles.tier_changed_at exists to
    // hold the rule once the product picks a number.
    await this.repo.updateProfile(userId, patch);
    return this.me(userId);
  }

  async setFollow(followerId: string, followeeId: string, following: boolean) {
    if (followerId === followeeId) throw new ApiError(400, "you cannot follow yourself");
    const target = await this.repo.getProfile(followeeId);
    if (!target) throw new ApiError(404, "no such profile");
    await this.repo.setFollow(followerId, followeeId, following);
  }

  /* ── Feeds ──────────────────────────────────────────────────────────────── */

  /** Spec §6.2: reels only, ranked by the recommender. */
  async reels(userId: string, limit = 30) {
    const [{ positions, voteCount }, rows] = await Promise.all([
      this.repo.getPositions(userId).then((r) => ({ positions: r.positions, voteCount: r.voteCount })),
      this.repo.listContent({ type: "video", moderationStatus: "approved" }),
    ]);
    // Your own reels are included — spec §5 forbids *voting* on them, not seeing
    // them, and Home already lists your own posts. The client disables the vote
    // controls. Filter by `r.authorId !== userId` here if that changes.
    return rankReels(rows, positions, voteCount).slice(0, limit);
  }

  /** Spec §6.1: image and text posts, people you follow first. */
  async home(userId: string, limit = 40) {
    const [rows, following] = await Promise.all([
      this.repo.listContent({ types: ["image", "text"], moderationStatus: "approved" }),
      this.repo.listFollowing(userId),
    ]);
    const follows = new Set(following);
    return rows
      .slice()
      .sort((a, b) => {
        const rank = (r: ContentRow) => (r.authorId === userId || follows.has(r.authorId) ? 0 : 1);
        const d = rank(a) - rank(b);
        return d !== 0 ? d : b.createdAt.localeCompare(a.createdAt);
      })
      .slice(0, limit);
  }

  /** How close a single item sits to a user — used by the client for debugging. */
  async affinityFor(userId: string, contentId: string) {
    const [row, content] = await Promise.all([
      this.repo.getPositions(userId),
      this.repo.getContent(contentId),
    ]);
    if (!content) throw new ApiError(404, "no such content");
    return affinity(row.positions, content.scores);
  }

  /* ── Contribute ─────────────────────────────────────────────────────────── */

  /** A one-shot upload URL. Speaker-gated like posting itself. */
  async createUploadTicket(userId: string, contentType: string) {
    const profile = await this.repo.getProfile(userId);
    if (!profile) throw new ApiError(404, "no such profile");
    if (profile.privacyTier !== "speaker") throw new ApiError(403, "only Speakers can post");
    // Validate here, not in the store, so the rule holds whichever store is wired in.
    mimeKind(contentType);
    return this.media.createUploadTicket(userId, contentType);
  }

  /**
   * Every post carries media now — spec §5 lists video, image and text, but the
   * product decided text-only posts are not something you can create.
   */
  async createContent(
    userId: string,
    input: ScorableContent & { mediaPath: string; mediaType: string; context?: string; music?: string },
  ) {
    const profile = await this.repo.getProfile(userId);
    if (!profile) throw new ApiError(404, "no such profile");
    // Spec §5 / §6.8: only Speakers may post.
    if (profile.privacyTier !== "speaker") {
      throw new ApiError(403, "only Speakers can post");
    }

    const kind = mimeKind(input.mediaType);
    if (kind !== input.type) {
      throw new ApiError(400, `a ${input.mediaType} upload cannot be posted as ${input.type}`);
    }
    if (!pathBelongsTo(input.mediaPath, userId)) {
      throw new ApiError(403, "that upload does not belong to you");
    }
    if (!(await this.media.exists(input.mediaPath))) {
      throw new ApiError(400, "upload the file before creating the post");
    }

    const scores = await this.scorer.score(input);
    return this.repo.insertContent({
      authorId: userId,
      type: input.type,
      body: input.body,
      context: input.context,
      music: input.music,
      mediaUrl: this.media.publicUrl(input.mediaPath),
      scores,
      scorer: this.scorer.name,
      // Spec §8: everything user-generated goes through moderation before it is seen.
      moderationStatus: "pending",
    });
  }

  /**
   * Moderation decision. Deliberately not wired to a public route yet: it needs
   * an admin/moderator role, which the auth model does not have.
   */
  async moderate(contentId: string, status: ContentRow["moderationStatus"]) {
    const content = await this.repo.getContent(contentId);
    if (!content) throw new ApiError(404, "no such content");
    await this.repo.setModerationStatus(contentId, status);
  }

  /* ── GDPR ───────────────────────────────────────────────────────────────── */

  /** Spec §6.5 / §9: Right to Be Forgotten. Removes the account and its history. */
  async forgetMe(userId: string) {
    await this.repo.deleteUser(userId);
  }
}
