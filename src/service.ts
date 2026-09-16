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
import { NullPushSender, type PushSender } from "./push";
import type { Repository } from "./repo/types";
import type { ContentScorer, ScorableContent } from "./scoring/scorer";

/** Spec §6.5: privacy tier can change at most once per this period. */
const TIER_CHANGE_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

export type IdentitySummary = {
  code: string | null;
  conviction: number;
  grids: Record<GridId, { name: string; orientation: string; meaning: string; hex?: string; animal?: string }>;
};

export type PublicProfile = Omit<ProfileRow, "notifPrefs"> & {
  positions: Positions | null;
  voteCount: number;
  unlocked: boolean;
  identity: IdentitySummary | null;
  alignment?: { total: number; perGrid: Record<GridId, number> };
  /** How *this account* wants to be notified — present only on your own `/me`,
   * never on someone else's viewed or ranked profile. */
  notifPrefs?: ProfileRow["notifPrefs"];
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

/** Spec §6.4-ish: once two people cross this, it's worth telling them. */
const ALIGNMENT_NOTIFY_THRESHOLD = 70;

const voteVerb = (power: VotePower) => (power === 2 ? "loved" : power === 1 ? "liked" : power === -1 ? "disliked" : "hated");

export class PnyxService {
  constructor(
    private readonly repo: Repository,
    private readonly scorer: ContentScorer,
    private readonly media: MediaStore,
    private readonly pushSender: PushSender = new NullPushSender(),
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

    // Re-read rather than apply `delta` in memory: the DB is the source of
    // truth for the tally (Supabase applies it via an atomic RPC, so a
    // concurrent voter's change could otherwise be clobbered by a stale add).
    const [{ positions, voteCount }, updated] = await Promise.all([
      this.recomputePositions(userId),
      this.repo.getContent(contentId),
    ]);
    const unlocked = voteCount >= UNLOCK_AT;

    // Awaited so the caller can rely on it having happened (and tests can
    // assert on it deterministically), but caught so a notification problem
    // never turns into a failed vote.
    await Promise.all([
      this.notify(content.authorId, { actorId: userId, kind: "vote", body: `${voteVerb(power)} your take.`, contentId }).catch(() => {}),
      this.checkAlignmentCrossings(userId, positions).catch(() => {}),
    ]);

    return {
      positions,
      voteCount,
      unlocked,
      unlockIn: Math.max(0, UNLOCK_AT - voteCount),
      replaced: previousPower,
      identity: summarise(positions, unlocked),
      // The caller just voted on this content — hand back its fresh global
      // split so the client can show an accurate count without refetching.
      tallies: updated?.tallies ?? content.tallies,
    };
  }

  /* ── Notifications ──────────────────────────────────────────────────────── */

  private async notify(userId: string, input: { actorId?: string; kind: string; body: string; contentId?: string; pct?: number }) {
    // Never notify someone about their own action.
    if (input.actorId === userId) return;
    await this.repo.insertNotification({ userId, ...input });
    // Awaited (like the in-app write above) so this is deterministic for
    // callers and tests, but caught — a push failure must never surface as
    // a failure of whatever action triggered the notification.
    await this.sendPush(userId, input).catch(() => {});
  }

  /** "follow" has no Settings toggle (there never was one), so it always
   * sends; every other kind is gated by the recipient's own notifPrefs. */
  private async sendPush(userId: string, input: { kind: string; body: string }) {
    const prefKey = (
      { vote: "votes", reply: "replies", alignment: "alignments" } as Record<string, keyof ProfileRow["notifPrefs"]>
    )[input.kind];
    const profile = await this.repo.getProfile(userId);
    if (!profile || (prefKey && !profile.notifPrefs[prefKey])) return;

    const tokens = await this.repo.listPushTokens([userId]);
    if (tokens.length === 0) return;
    await this.pushSender.send(
      tokens.map((t) => t.token),
      { title: "PNYX", body: input.body },
    );
  }

  /** A device registering (or re-registering, on relaunch/token refresh) for
   * OS push notifications. */
  async registerPushToken(userId: string, token: string) {
    await this.repo.savePushToken(userId, token);
  }

  async listNotifications(userId: string, limit = 50) {
    return this.repo.listNotifications(userId, limit);
  }

  /**
   * After a vote moves the voter's position, alignment with everyone they
   * follow or are followed by may have shifted too — worth telling both
   * sides the first time a pair crosses the threshold. Bounded to that
   * neighbor set (not the whole user base) for the same reason `mostAligned`
   * is: fine at pilot scale, not something to run against every user on
   * every vote. Best-effort: never let this delay or fail the vote itself.
   */
  private async checkAlignmentCrossings(userId: string, positions: Positions) {
    const [following, followers] = await Promise.all([
      this.repo.listFollowing(userId),
      this.repo.listFollowers(userId),
    ]);
    const neighbors = [...new Set([...following, ...followers])];
    if (neighbors.length === 0) return;

    const rows = await this.repo.listPositions(neighbors);
    for (const row of rows) {
      const total = totalAlignment(positions, row.positions);
      const perGrid = perGridAlignment(positions, row.positions);
      const previous = await this.repo.getAlignmentCache(userId, row.userId);
      await this.repo.setAlignmentCache(userId, row.userId, perGrid, total);

      const justCrossed = (previous === null || previous < ALIGNMENT_NOTIFY_THRESHOLD) && total >= ALIGNMENT_NOTIFY_THRESHOLD;
      if (!justCrossed) continue;
      const pct = Math.round(total);
      const body = `are now ${pct}% aligned.`;
      await Promise.all([
        this.notify(userId, { actorId: row.userId, kind: "alignment", body, pct }),
        this.notify(row.userId, { actorId: userId, kind: "alignment", body, pct }),
      ]);
    }
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
   * Spec §6.6: "shared by only 3 people worldwide" — the share of the (unlocked)
   * population that landed on the same named position as the caller, per grid.
   * O(n) over everyone, same tradeoff `mostAligned` already accepts at pilot
   * scale (see that method's own comment) rather than a real population index.
   */
  async rarity(userId: string): Promise<Record<GridId, number>> {
    const me = await this.repo.getPositions(userId);
    const others = await this.repo.listProfiles(userId);
    const rows = others.length ? await this.repo.listPositions(others.map((p) => p.id)) : [];
    const population = [me, ...rows].filter((row) => row.unlocked);
    const total = population.length || 1;

    const out = {} as Record<GridId, number>;
    for (const g of GRID_IDS) {
      const mine = nearestPoint(g, me.positions[g]).name;
      const matching = population.filter((row) => nearestPoint(g, row.positions[g]).name === mine).length;
      out[g] = Math.round((matching / total) * 100);
    }
    return out;
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
    // notifPrefs is how *this account* wants to be notified — meaningless,
    // and not this viewer's business, on anyone else's profile.
    const { notifPrefs: _notifPrefs, ...publicProfile } = profile;
    return {
      ...publicProfile,
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
   *
   * `query` (People's search box) filters by name/handle over that same full
   * user base first, *then* ranks and caps to `limit` — without it, search
   * could only ever find someone already inside the top-`limit` alignment
   * window it was scoped to.
   */
  async mostAligned(userId: string, limit: number, query?: string) {
    const [viewer, others, following, followers] = await Promise.all([
      this.repo.getPositions(userId),
      this.repo.listProfiles(userId),
      this.repo.listFollowing(userId),
      this.repo.listFollowers(userId),
    ]);
    const q = query?.trim().toLowerCase();
    const candidates = q
      ? others.filter((p) => p.name.toLowerCase().includes(q) || p.handle.toLowerCase().includes(q))
      : others;
    const positions = await this.repo.listPositions(candidates.map((p) => p.id));
    const byId = new Map(positions.map((p) => [p.userId, p]));
    const iFollow = new Set(following);
    const followsMe = new Set(followers);

    return candidates
      .map((profile) => {
        const row = byId.get(profile.id)!;
        // notifPrefs is nobody else's business — see viewProfile's own comment.
        const { notifPrefs: _notifPrefs, ...publicProfile } = profile;
        return {
          profile: publicProfile,
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
    if (patch.privacyTier !== undefined) {
      if (patch.privacyTier === current.privacyTier) {
        // Not an actual change — strip it so the repo never bumps
        // tierChangedAt (and thus the cooldown) for a same-value PATCH.
        delete patch.privacyTier;
      } else if (current.tierChangedAt !== null) {
        const changedAtMs = new Date(current.tierChangedAt).getTime();
        const nextChangeAtMs = changedAtMs + TIER_CHANGE_COOLDOWN_MS;
        if (Date.now() < nextChangeAtMs) {
          throw new ApiError(429, "you can only change your privacy tier once every 30 days", {
            nextChangeAt: new Date(nextChangeAtMs).toISOString(),
            retryAfterDays: Math.ceil((nextChangeAtMs - Date.now()) / (24 * 60 * 60 * 1000)),
          });
        }
      }
    }
    await this.repo.updateProfile(userId, patch);
    return this.me(userId);
  }

  async setFollow(followerId: string, followeeId: string, following: boolean) {
    if (followerId === followeeId) throw new ApiError(400, "you cannot follow yourself");
    const target = await this.repo.getProfile(followeeId);
    if (!target) throw new ApiError(404, "no such profile");
    await this.repo.setFollow(followerId, followeeId, following);
    if (following) {
      await this.notify(followeeId, { actorId: followerId, kind: "follow", body: "started following you." });
    }
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

  /**
   * Spec §6.2: "on vote, show ... friends' votes" — the people the viewer
   * follows who have *actually* cast a vote on this content, not a guess at
   * what they'd probably think (that guess is what the client's own
   * `friendVotes()` in `lib/feed.ts` is for, offline only, where there's no
   * real vote to look up at all).
   */
  async friendVotes(viewerId: string, contentId: string) {
    const content = await this.repo.getContent(contentId);
    if (!content) throw new ApiError(404, "no such content");
    if (content.moderationStatus !== "approved" && content.authorId !== viewerId) {
      throw new ApiError(403, "content is not available");
    }
    const following = await this.repo.listFollowing(viewerId);
    if (following.length === 0) return [];
    return this.repo.listVotesFor(contentId, following);
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

    const mediaUrl = this.media.publicUrl(input.mediaPath);
    const outcome = await this.scorer.score({ ...input, mediaUrl });

    if (outcome.verdict === "policy_violation") {
      const strikeCount = await this.repo.recordStrike(userId, outcome.reason);
      // The model's specific reason goes to the strike log for a moderator to
      // read, not back to the poster — a generic message doesn't teach anyone
      // how to word their way past the filter next time.
      throw new ApiError(422, "This post was removed for violating PNYX's content guidelines. You've been flagged for review.", {
        code: "policy_violation",
        flagged: true,
        strikeCount,
      });
    }
    if (outcome.verdict === "low_effort") {
      // Not a strike — the poster just hasn't said anything yet. The model's
      // reason IS the message here, since the whole point is to tell them why.
      throw new ApiError(422, outcome.reason, { code: "low_effort", flagged: false });
    }

    return this.repo.insertContent({
      authorId: userId,
      type: input.type,
      body: input.body,
      context: input.context,
      music: input.music,
      mediaUrl,
      scores: outcome.scores,
      scorer: this.scorer.name,
      // Spec §8 lists "content moderation" as one of AI's four jobs, not a
      // separate human-review phase — the scorer call above already is that
      // gate: policy_violation and low_effort both throw before this point,
      // so anything that reaches here has already been screened. Leaving
      // this at "pending" left every post permanently invisible and
      // unvotable (/home, /feed/reels and castVote all require "approved"),
      // since moderate() below has no route to ever move it off "pending" —
      // there's no admin role in the auth model to gate one behind.
      moderationStatus: "approved",
    });
  }

  /**
   * A manual override on top of the AI gate above — takedowns, appeals, that
   * kind of thing. Deliberately not wired to a public route yet: it needs an
   * admin/moderator role, which the auth model does not have. Unlike the
   * "pending" bug this replaces, AI-cleared content no longer depends on
   * this existing to be usable at all.
   */
  async moderate(contentId: string, status: ContentRow["moderationStatus"]) {
    const content = await this.repo.getContent(contentId);
    if (!content) throw new ApiError(404, "no such content");
    await this.repo.setModerationStatus(contentId, status);
  }

  /* ── Comments (spec §5: comments are votable too) ──────────────────────────── */

  async listComments(userId: string, contentId: string) {
    const content = await this.repo.getContent(contentId);
    if (!content) throw new ApiError(404, "no such content");
    if (content.moderationStatus !== "approved" && content.authorId !== userId) {
      throw new ApiError(403, "content is not available");
    }
    return this.repo.listComments(contentId, userId);
  }

  async addComment(userId: string, contentId: string, body: string) {
    const content = await this.repo.getContent(contentId);
    if (!content) throw new ApiError(404, "no such content");
    if (content.moderationStatus !== "approved" && content.authorId !== userId) {
      throw new ApiError(403, "content is not available for comments");
    }
    const comment = await this.repo.insertComment({ contentId, authorId: userId, body });
    await this.repo.incrementCommentCount(contentId);
    const preview = body.length > 80 ? `${body.slice(0, 77)}...` : body;
    await this.notify(content.authorId, { actorId: userId, kind: "reply", body: `replied: "${preview}"`, contentId });
    return comment;
  }

  async voteComment(userId: string, commentId: string, power: 1 | -1) {
    const comment = await this.repo.getComment(commentId);
    if (!comment) throw new ApiError(404, "no such comment");
    return this.repo.voteComment(commentId, userId, power);
  }

  /* ── Messages (spec §6.7) ────────────────────────────────────────────────── */

  /** One row per conversation, newest activity first, with a last-message preview. */
  async listConversations(userId: string) {
    const convos = await this.repo.listConversations(userId);
    const last = await this.repo.listLastMessages(convos.map((c) => c.id));
    return convos
      .map((c) => ({
        id: c.id,
        otherUserId: c.userA === userId ? c.userB : c.userA,
        createdAt: c.createdAt,
        lastMessage: last[c.id] ?? null,
      }))
      .sort((a, b) => (b.lastMessage?.createdAt ?? b.createdAt).localeCompare(a.lastMessage?.createdAt ?? a.createdAt));
  }

  /** Opens (or starts) the 1:1 thread with `otherUserId` and returns its history. */
  async openConversation(userId: string, otherUserId: string) {
    if (userId === otherUserId) throw new ApiError(400, "you cannot message yourself");
    const other = await this.repo.getProfile(otherUserId);
    if (!other) throw new ApiError(404, "no such profile");
    const convo = await this.repo.getOrCreateConversation(userId, otherUserId);
    const messages = await this.repo.listMessages(convo.id);
    return { conversationId: convo.id, otherUserId, messages };
  }

  private async requireParticipant(userId: string, conversationId: string) {
    const convo = await this.repo.getConversation(conversationId);
    if (!convo || (convo.userA !== userId && convo.userB !== userId)) {
      throw new ApiError(404, "no such conversation");
    }
    return convo;
  }

  async listMessages(userId: string, conversationId: string) {
    await this.requireParticipant(userId, conversationId);
    return this.repo.listMessages(conversationId);
  }

  async sendMessage(
    userId: string,
    conversationId: string,
    input: { body?: string; contentId?: string; votePower?: VotePower },
  ) {
    if (!input.body && !input.contentId) throw new ApiError(400, "a message needs text or a forwarded post");
    await this.requireParticipant(userId, conversationId);
    if (input.contentId && !(await this.repo.getContent(input.contentId))) {
      throw new ApiError(404, "no such content to forward");
    }
    return this.repo.insertMessage({
      conversationId,
      senderId: userId,
      body: input.body,
      contentId: input.contentId,
      voteSnapshot: input.contentId ? input.votePower : undefined,
    });
  }

  /* ── Hot takes ───────────────────────────────────────────────────────────── */

  async hotTakes(limit = 30) {
    return this.repo.listActiveHotTakes(limit);
  }

  /** Same posting gate as regular content — spec §5/§6.8: only Speakers post. */
  async postHotTake(userId: string, category: GridId, body: string) {
    const profile = await this.repo.getProfile(userId);
    if (!profile) throw new ApiError(404, "no such profile");
    if (profile.privacyTier !== "speaker") throw new ApiError(403, "only Speakers can post");
    return this.repo.insertHotTake({ authorId: userId, category, body });
  }

  /* ── GDPR ───────────────────────────────────────────────────────────────── */

  /** Spec §6.5 / §9: Right to Be Forgotten. Removes the account, its history, and
   * every file it ever uploaded — deleting only the DB rows left avatars and post
   * media sitting in Storage forever. */
  async forgetMe(userId: string) {
    await this.media.deleteAll(userId);
    await this.repo.deleteUser(userId);
  }
}
