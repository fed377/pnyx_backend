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
import { ageOn, ApiError, bucketOf, MIN_AGE } from "./domain";
import { NullEmailSender, type EmailSender } from "./email";
import type { ContentRow, ProfileRow } from "./domain";
import { mimeKind, pathBelongsTo, type MediaStore } from "./media";
import { NullPushSender, type PushSender } from "./push";
import type { ReelView, Repository } from "./repo/types";
import type { ContentScorer, ScorableContent } from "./scoring/scorer";
import { waitlistConfirmation } from "./waitlistEmail";

/** Spec §6.5: privacy tier can change at most once per this period. */
const TIER_CHANGE_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

export type IdentitySummary = {
  code: string | null;
  conviction: number;
  grids: Record<GridId, { name: string; orientation: string; meaning: string; hex?: string; animal?: string }>;
};

export type PublicProfile = Omit<ProfileRow, "notifPrefs" | "birthday"> & {
  positions: Positions | null;
  voteCount: number;
  unlocked: boolean;
  identity: IdentitySummary | null;
  alignment?: { total: number; perGrid: Record<GridId, number> };
  /** How *this account* wants to be notified — present only on your own `/me`,
   * never on someone else's viewed or ranked profile. */
  notifPrefs?: ProfileRow["notifPrefs"];
  /** Present only on your own `/me` — nobody else's business. */
  birthday?: ProfileRow["birthday"];
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

export type ServiceOptions = {
  /** Answer a vote before its follow-up work finishes, and batch vote
   * notifications. Off by default so tests can assert on the results directly. */
  deferWork?: boolean;
  voteNotifyWindowMs?: number;
  /** User ids allowed to change privacy tier without the 30-day cooldown. */
  tierCooldownExempt?: readonly string[];
};

const VOTE_NOTIFY_WINDOW_MS = 60_000;

/** How many reels each source offers the ranker. */
const REEL_NEAR = 300;
const REEL_RECENT = 100;
const REEL_EXPLORE = 100;

/** Share of a page that can revisit reels already voted on. */
const VOTED_REEL_SHARE = 1 / 15;

/** Enough nearby people that the exact alignment ranking has room to reorder them. */
const MIN_PEOPLE_CANDIDATES = 200;
const MAX_FOLLOWS_FOR_HOME = 500;

const toVector = (p: Positions) => GRID_IDS.flatMap((g) => [p[g].x, p[g].y]);

export class PnyxService {
  constructor(
    private readonly repo: Repository,
    private readonly scorer: ContentScorer,
    private readonly media: MediaStore,
    private readonly pushSender: PushSender = new NullPushSender(),
    private readonly emailSender: EmailSender = new NullEmailSender(),
    private readonly options: ServiceOptions = {},
  ) {}

  /** Author + post → the votes waiting to go out as one notification. */
  private readonly pendingVoteNotes = new Map<string, { actorId: string; power: VotePower; voters: Set<string> }>();

  /** Work a request shouldn't wait for. Failures are logged, never surfaced. */
  private async background(task: () => Promise<unknown>) {
    const run = task().catch((err: unknown) => {
      console.error("background task failed:", err instanceof Error ? err.message : err);
    });
    if (!this.options.deferWork) await run;
  }

  /** Votes on one post within the window become a single notification and push. */
  private async queueVoteNotification(authorId: string, actorId: string, contentId: string, power: VotePower) {
    if (authorId === actorId) return;
    if (!this.options.deferWork) {
      await this.notify(authorId, { actorId, kind: "vote", body: `${voteVerb(power)} your take.`, contentId });
      return;
    }
    const key = `${authorId}:${contentId}`;
    const pending = this.pendingVoteNotes.get(key);
    if (pending) {
      pending.actorId = actorId;
      pending.power = power;
      pending.voters.add(actorId);
      return;
    }
    this.pendingVoteNotes.set(key, { actorId, power, voters: new Set([actorId]) });
    const timer = setTimeout(() => {
      const note = this.pendingVoteNotes.get(key);
      this.pendingVoteNotes.delete(key);
      if (!note) return;
      const others = note.voters.size - 1;
      const body =
        others === 0
          ? `${voteVerb(note.power)} your take.`
          : `and ${others} ${others === 1 ? "other" : "others"} reacted to your take.`;
      void this.background(() => this.notify(authorId, { actorId: note.actorId, kind: "vote", body, contentId }));
    }, this.options.voteNotifyWindowMs ?? VOTE_NOTIFY_WINDOW_MS);
    timer.unref?.();
  }

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

    // Nothing here changes the vote's result, so it doesn't hold up the response.
    await this.background(() =>
      Promise.all([
        this.queueVoteNotification(content.authorId, userId, contentId, power).catch(() => {}),
        this.checkAlignmentCrossings(userId, positions).catch(() => {}),
      ]),
    );

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
    const scored = rows.map((row) => ({
      otherId: row.userId,
      perGrid: perGridAlignment(positions, row.positions),
      totalPct: totalAlignment(positions, row.positions),
    }));
    const previous = await this.repo.getAlignmentCaches(
      userId,
      scored.map((r) => r.otherId),
    );
    await this.repo.setAlignmentCaches(userId, scored);

    for (const { otherId, totalPct } of scored) {
      const before = previous[otherId];
      const justCrossed =
        (before === undefined || before < ALIGNMENT_NOTIFY_THRESHOLD) && totalPct >= ALIGNMENT_NOTIFY_THRESHOLD;
      if (!justCrossed) continue;
      const pct = Math.round(totalPct);
      const body = `are now ${pct}% aligned.`;
      await Promise.all([
        this.notify(userId, { actorId: otherId, kind: "alignment", body, pct }),
        this.notify(otherId, { actorId: userId, kind: "alignment", body, pct }),
      ]);
    }
  }

  /* ── Profiles and alignment ─────────────────────────────────────────────── */

  private tierCooldownExempt(userId: string): boolean {
    return this.options.tierCooldownExempt?.includes(userId) ?? false;
  }

  async me(userId: string): Promise<PublicProfile & { tierCooldownExempt: boolean }> {
    const profile = await this.repo.getProfile(userId);
    if (!profile) throw new ApiError(404, "no such profile");
    const row = await this.repo.getPositions(userId);
    return {
      ...profile,
      tierCooldownExempt: this.tierCooldownExempt(userId),
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
    // notifPrefs is how *this account* wants to be notified, and birthday is
    // nobody else's business either — neither belongs on anyone else's profile.
    const { notifPrefs: _notifPrefs, birthday: _birthday, ...publicProfile } = profile;
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
   * The database narrows it to nearby people first; exact alignment only runs
   * on those.
   *
   * `query` (People's search box) filters by name/handle over the full user
   * base first, *then* ranks and caps to `limit` — without it, search
   * could only ever find someone already inside the top-`limit` alignment
   * window it was scoped to.
   */
  async mostAligned(userId: string, limit: number, query?: string) {
    const [viewer, following, followers, hidden] = await Promise.all([
      this.repo.getPositions(userId),
      this.repo.listFollowing(userId),
      this.repo.listFollowers(userId),
      this.blockedEitherWay(userId),
    ]);
    const q = query?.trim();
    const candidates = (q ? await this.peopleMatching(q, userId) : await this.peopleNear(userId, viewer.positions, following, hidden, limit)).filter(
      (p) => !hidden.has(p.id),
    );
    const positions = await this.repo.listPositions(candidates.map((p) => p.id));
    const byId = new Map(positions.map((p) => [p.userId, p]));
    const iFollow = new Set(following);
    const followsMe = new Set(followers);

    return candidates
      .map((profile) => {
        const row = byId.get(profile.id)!;
        // notifPrefs and birthday are nobody else's business — see viewProfile's own comment.
        const { notifPrefs: _notifPrefs, birthday: _birthday, ...publicProfile } = profile;
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

  private peopleMatching(term: string, userId: string) {
    return this.repo.searchProfiles(term, userId, MIN_PEOPLE_CANDIDATES);
  }

  /** Nearby people plus everyone you follow; newest accounts top it up, since
   * people who haven't voted yet have no position to be near. */
  private async peopleNear(
    userId: string,
    positions: Positions,
    following: string[],
    hidden: Set<string>,
    limit: number,
  ) {
    const count = Math.max(limit * 4, MIN_PEOPLE_CANDIDATES);
    const near = await this.repo.nearestPeople(userId, toVector(positions), [...hidden], count);
    const profiles = await this.repo.getProfiles([...new Set([...near, ...following])]);
    if (profiles.length >= limit) return profiles;
    const known = new Set(profiles.map((p) => p.id));
    const recent = await this.repo.recentProfiles(userId, limit * 2);
    return [...profiles, ...recent.filter((p) => !known.has(p.id))];
  }

  async updateProfile(userId: string, patch: Partial<ProfileRow>): Promise<PublicProfile> {
    const current = await this.repo.getProfile(userId);
    if (!current) throw new ApiError(404, "no such profile");
    // Must point at the caller's own uploaded media, never an arbitrary
    // external URL — otherwise a profile becomes a tracking pixel that
    // fires against every viewer who renders the avatar.
    if (patch.avatarUrl !== undefined) {
      const ownPrefix = this.media.publicUrl(`u/${userId}/`);
      if (!patch.avatarUrl.startsWith(ownPrefix)) {
        throw new ApiError(400, "avatarUrl must point at your own uploaded media");
      }
    }
    // Birthday (and the age it implies) is now collected and enforced at
    // /auth/signup, so this never fires for an account created going
    // forward — kept as a server-side backstop for any client that still
    // completes onboarding via PATCH instead, so age enforcement never
    // depends on which client (or none) got there.
    if (patch.onboarded === true && !current.onboarded) {
      const birthday = patch.birthday ?? current.birthday;
      if (!birthday) throw new ApiError(400, "a birthday is required to complete onboarding");
      if (ageOn(birthday) < MIN_AGE) {
        throw new ApiError(403, `you must be at least ${MIN_AGE} to use PNYX`);
      }
    }
    if (patch.privacyTier !== undefined) {
      if (patch.privacyTier === current.privacyTier) {
        // Not an actual change — strip it so the repo never bumps
        // tierChangedAt (and thus the cooldown) for a same-value PATCH.
        delete patch.privacyTier;
      } else if (current.tierChangedAt !== null && !this.tierCooldownExempt(userId)) {
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

  /* ── Trust & safety ───────────────────────────────────────────────────────── */

  /** Union of who `userId` has blocked and who has blocked `userId` — hiding
   * is always mutual, regardless of which side initiated it. */
  private async blockedEitherWay(userId: string): Promise<Set<string>> {
    const [blocked, blockedBy] = await Promise.all([
      this.repo.listBlocked(userId),
      this.repo.listBlockedBy(userId),
    ]);
    return new Set([...blocked, ...blockedBy]);
  }

  async setBlock(blockerId: string, blockedId: string, blocked: boolean) {
    if (blockerId === blockedId) throw new ApiError(400, "you cannot block yourself");
    const target = await this.repo.getProfile(blockedId);
    if (!target) throw new ApiError(404, "no such profile");
    await this.repo.setBlock(blockerId, blockedId, blocked);
    if (blocked) {
      // A block implies you don't want to follow or be followed by them
      // either — both directions, both no-ops if not currently following.
      await Promise.all([
        this.repo.setFollow(blockerId, blockedId, false),
        this.repo.setFollow(blockedId, blockerId, false),
      ]);
    }
  }

  /** No admin surface exists yet (see MISSING_FEATURES.md) — this just logs
   * the report for an operator to review directly against the store, same as
   * moderation strikes before they had one. */
  async reportContent(reporterId: string, contentId: string, reason: string) {
    const content = await this.repo.getContent(contentId);
    if (!content) throw new ApiError(404, "no such content");
    await this.repo.insertContentReport({ reporterId, contentId, reason });
  }

  /* ── Waitlist ───────────────────────────────────────────────────────────── */

  /** Pre-launch signup from the pnyx-waitlist site. Idempotent — and the
   * caller never learns whether the address was already listed.
   *
   * The confirmation email goes out only on the first signup (so re-submitting
   * can't be used to spam an address), and isn't awaited: the response
   * shouldn't wait on Resend, and a failed send mustn't fail the signup. */
  async joinWaitlist(email: string, source?: string) {
    const normalized = email.trim().toLowerCase();
    const { added } = await this.repo.addToWaitlist(normalized, source ?? null);
    if (added) {
      this.emailSender.send(waitlistConfirmation(normalized)).catch((err: unknown) => {
        console.error(`waitlist confirmation to ${normalized} failed:`, err instanceof Error ? err.message : err);
      });
    }
  }

  /* ── Feeds ──────────────────────────────────────────────────────────────── */

  /**
   * Spec §6.2: reels only, ranked by the recommender. `excluded` is what the
   * client already has loaded, which is how the next page differs from this one.
   */
  async reels(userId: string, limit = 30, excluded: string[] = []) {
    const [{ positions, voteCount }, hiddenSet, votes] = await Promise.all([
      this.repo.getPositions(userId).then((r) => ({ positions: r.positions, voteCount: r.voteCount })),
      this.blockedEitherWay(userId),
      this.myVotes(userId),
    ]);
    const hidden = [...hiddenSet];
    // Your own reels are included — spec §5 forbids *voting* on them, not seeing
    // them, and Home already lists your own posts. The client disables the vote
    // controls.
    const candidates = (ignoreViews: boolean) =>
      this.repo.reelCandidates({
        viewerId: userId,
        position: toVector(positions),
        excluded,
        hidden,
        near: REEL_NEAR,
        recent: REEL_RECENT,
        explore: REEL_EXPLORE,
        ignoreViews,
      });

    const fresh = await candidates(false);
    const freshIds = new Set(fresh.map((c) => c.id));
    // A small catalogue runs out of unwatched reels; repeats beat an empty feed.
    const rewatches = fresh.length < limit ? (await candidates(true)).filter((c) => !freshIds.has(c.id)) : [];

    const left = limit - fresh.length - rewatches.length;
    const skip = new Set(excluded);
    const votedIds = votes
      .map((v) => v.contentId)
      .filter((id) => !skip.has(id))
      .sort(() => Math.random() - 0.5)
      .slice(0, Math.max(Math.ceil(limit * VOTED_REEL_SHARE), left));
    const revisits = (await this.repo.reelCandidatesById(votedIds)).filter((c) => !hiddenSet.has(c.authorId));

    const ranked = rankReels([...fresh, ...rewatches, ...revisits], positions, voteCount, (c) => c.tallies, {
      voted: new Set([...rewatches, ...revisits].map((c) => c.id)),
      random: Math.random,
      signals: (c) => ({
        authorId: c.authorId,
        createdAtMs: Date.parse(c.createdAt),
        views: c.views,
        completionSum: c.completionSum,
      }),
    }).slice(0, limit);

    const rows = new Map((await this.repo.listContentByIds(ranked.map((c) => c.id))).map((r) => [r.id, r]));
    return ranked.flatMap((c) => rows.get(c.id) ?? []);
  }

  /** Watch data from the app; used for "already seen" and for ranking by what people finish. */
  async recordReelViews(userId: string, views: ReelView[]) {
    await this.repo.recordReelViews(userId, views);
  }

  /** Spec §6.1: image and text posts, people you follow first. */
  async home(userId: string, limit = 40) {
    const [following, hidden] = await Promise.all([this.repo.listFollowing(userId), this.blockedEitherWay(userId)]);
    const base = { types: ["image", "text"] as ContentRow["type"][], moderationStatus: "approved" as const };
    // Over-fetched by the number of hidden authors, who are filtered out after.
    const fetch = limit + hidden.size;
    const [followed, recent] = await Promise.all([
      this.repo.listContent({ ...base, authorIds: [userId, ...following.slice(0, MAX_FOLLOWS_FOR_HOME)], limit: fetch }),
      this.repo.listContent({ ...base, limit: fetch }),
    ]);
    const followedIds = new Set(followed.map((r) => r.id));
    return [...followed, ...recent.filter((r) => !followedIds.has(r.id))]
      .filter((r) => !hidden.has(r.authorId))
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
    if ((await this.blockedEitherWay(userId)).has(otherUserId)) {
      throw new ApiError(403, "you can't message this person");
    }
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
    const convo = await this.requireParticipant(userId, conversationId);
    const otherUserId = convo.userA === userId ? convo.userB : convo.userA;
    if ((await this.blockedEitherWay(userId)).has(otherUserId)) {
      throw new ApiError(403, "you can't message this person");
    }
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
