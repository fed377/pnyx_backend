import { randomUUID } from "node:crypto";
import { ORIGIN } from "../core/algorithm";
import { ALL_CONTENT, ME_DEFAULTS, ME_ID, PEOPLE } from "../core/data";
import type { GridId, Positions } from "../core/types";
import type {
  CommentRow,
  ContentRow,
  ConversationRow,
  HotTakeRow,
  MessageRow,
  NotificationRow,
  PositionsRow,
  ProfileRow,
  VoteRow,
} from "../domain";
import type { ContentFilter, NewContent, Repository } from "./types";

/**
 * Runs the whole API with no database, seeded from the sample people and posts
 * the client ships with. Lets the vote pipeline, recommender and alignment maths
 * be exercised (and tested) before any Supabase project exists.
 */
export class MemoryRepository implements Repository {
  private profiles = new Map<string, ProfileRow>();
  private positions = new Map<string, PositionsRow>();
  private content = new Map<string, ContentRow>();
  private votes = new Map<string, VoteRow>(); // `${userId}:${contentId}`
  private follows = new Set<string>(); // `${follower}:${followee}`
  private blocks = new Set<string>(); // `${blocker}:${blocked}`
  private contentReports: { reporterId: string; contentId: string; reason: string }[] = [];
  private strikes = new Map<string, number>();
  private comments = new Map<string, CommentRow>();
  private commentVotes = new Map<string, 1 | -1>(); // `${commentId}:${userId}`
  private notifications = new Map<string, NotificationRow>();
  private alignmentCache = new Map<string, number>(); // `${a}:${b}`, a<b
  private conversations = new Map<string, ConversationRow>();
  private messages = new Map<string, MessageRow>();
  private hotTakes = new Map<string, HotTakeRow>();
  private pushTokens = new Map<string, string>(); // token -> userId

  constructor() {
    this.seed();
  }

  private seed() {
    this.profiles.set(ME_ID, {
      id: ME_ID,
      handle: ME_DEFAULTS.handle,
      name: ME_DEFAULTS.name,
      pronouns: ME_DEFAULTS.pronouns,
      bio: ME_DEFAULTS.bio,
      city: ME_DEFAULTS.city,
      privacyTier: "active",
      tierChangedAt: null,
      gridPublic: { values: true, mind: true, soul: true, culture: false, focus: true },
      premium: false,
      onboarded: true,
      birthday: null,
      notifPrefs: { votes: true, replies: true, alignments: false },
      createdAt: new Date().toISOString(),
    });
    this.positions.set(ME_ID, {
      userId: ME_ID,
      positions: structuredClone(ORIGIN),
      voteCount: 0,
      unlocked: false,
    });

    for (const p of PEOPLE) {
      this.profiles.set(p.id, {
        id: p.id,
        handle: p.handle,
        name: p.name,
        pronouns: p.pronouns,
        bio: p.bio,
        city: p.city,
        privacyTier: p.tier,
        tierChangedAt: null,
        gridPublic: { values: true, mind: true, soul: true, culture: true, focus: true },
        premium: false,
        onboarded: true,
        birthday: null,
        notifPrefs: { votes: true, replies: true, alignments: false },
        createdAt: new Date().toISOString(),
      });
      // Seeded people arrive with history already behind them.
      this.positions.set(p.id, {
        userId: p.id,
        positions: structuredClone(p.positions),
        voteCount: p.voteCount,
        unlocked: p.voteCount >= 50,
      });
      if (p.following) this.follows.add(`${ME_ID}:${p.id}`);
      if (p.follower) this.follows.add(`${p.id}:${ME_ID}`);
    }

    for (const c of ALL_CONTENT) {
      this.content.set(c.id, {
        id: c.id,
        authorId: c.authorId,
        type: c.type,
        body: c.text,
        context: c.context,
        music: c.music,
        scores: structuredClone(c.scores),
        scorer: "seed",
        moderationStatus: "approved",
        tallies: { ...c.globalSplit },
        commentCount: c.commentCount,
        createdAt: new Date(c.createdAt).toISOString(),
      });
    }
  }

  async getProfile(id: string) {
    return this.profiles.get(id) ?? null;
  }

  async listProfiles(exceptId?: string) {
    return [...this.profiles.values()].filter((p) => p.id !== exceptId);
  }

  async updateProfile(id: string, patch: Partial<ProfileRow>) {
    const current = this.profiles.get(id);
    if (!current) throw new Error(`no such profile: ${id}`);
    const next = { ...current, ...patch, id: current.id };
    if (patch.privacyTier !== undefined && patch.privacyTier !== current.privacyTier) {
      next.tierChangedAt = new Date().toISOString();
    }
    this.profiles.set(id, next);
    return next;
  }

  async getPositions(userId: string): Promise<PositionsRow> {
    return (
      this.positions.get(userId) ?? {
        userId,
        positions: structuredClone(ORIGIN),
        voteCount: 0,
        unlocked: false,
      }
    );
  }

  async savePositions(userId: string, positions: Positions, voteCount: number) {
    this.positions.set(userId, {
      userId,
      positions: structuredClone(positions),
      voteCount,
      unlocked: voteCount >= 50,
    });
  }

  async listPositions(userIds: string[]) {
    return Promise.all(userIds.map((id) => this.getPositions(id)));
  }

  async getContent(id: string) {
    return this.content.get(id) ?? null;
  }

  async listContent(filter: ContentFilter) {
    let rows = [...this.content.values()];
    if (filter.type) rows = rows.filter((r) => r.type === filter.type);
    if (filter.types) rows = rows.filter((r) => filter.types!.includes(r.type));
    if (filter.authorId) rows = rows.filter((r) => r.authorId === filter.authorId);
    if (filter.moderationStatus) rows = rows.filter((r) => r.moderationStatus === filter.moderationStatus);
    rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return filter.limit ? rows.slice(0, filter.limit) : rows;
  }

  async insertContent(row: NewContent) {
    const created: ContentRow = {
      ...row,
      id: randomUUID(),
      tallies: { love: 0, like: 0, dislike: 0, hate: 0 },
      commentCount: 0,
      createdAt: new Date().toISOString(),
    };
    this.content.set(created.id, created);
    return created;
  }

  async adjustTallies(contentId: string, delta: Partial<Record<"love" | "like" | "dislike" | "hate", number>>) {
    const row = this.content.get(contentId);
    if (!row) return;
    for (const [k, v] of Object.entries(delta)) {
      const key = k as keyof ContentRow["tallies"];
      row.tallies[key] = Math.max(0, row.tallies[key] + (v ?? 0));
    }
  }

  async setModerationStatus(contentId: string, status: ContentRow["moderationStatus"]) {
    const row = this.content.get(contentId);
    if (row) row.moderationStatus = status;
  }

  async incrementCommentCount(contentId: string) {
    const row = this.content.get(contentId);
    if (row) row.commentCount += 1;
  }

  async upsertVote(vote: Omit<VoteRow, "id" | "createdAt">) {
    const key = `${vote.userId}:${vote.contentId}`;
    const existing = this.votes.get(key);
    this.votes.set(key, {
      ...vote,
      id: existing?.id ?? randomUUID(),
      // Re-voting refreshes recency, which is what the decay window measures.
      createdAt: new Date().toISOString(),
    });
    return { previousPower: existing?.power ?? null };
  }

  async recentVotes(userId: string, limit: number) {
    return [...this.votes.values()]
      .filter((v) => v.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async countVotes(userId: string) {
    let n = 0;
    for (const v of this.votes.values()) if (v.userId === userId) n++;
    return n;
  }

  async listVotesFor(contentId: string, userIds: string[]) {
    const wanted = new Set(userIds);
    return [...this.votes.values()]
      .filter((v) => v.contentId === contentId && wanted.has(v.userId))
      .map((v) => ({ userId: v.userId, power: v.power }));
  }

  async listFollowing(userId: string) {
    return [...this.follows]
      .filter((k) => k.startsWith(`${userId}:`))
      .map((k) => k.split(":")[1]);
  }

  async listFollowers(userId: string) {
    return [...this.follows]
      .filter((k) => k.endsWith(`:${userId}`))
      .map((k) => k.split(":")[0]);
  }

  async setFollow(followerId: string, followeeId: string, following: boolean) {
    const key = `${followerId}:${followeeId}`;
    if (following) this.follows.add(key);
    else this.follows.delete(key);
  }

  async listBlocked(userId: string) {
    return [...this.blocks].filter((k) => k.startsWith(`${userId}:`)).map((k) => k.split(":")[1]);
  }

  async listBlockedBy(userId: string) {
    return [...this.blocks].filter((k) => k.endsWith(`:${userId}`)).map((k) => k.split(":")[0]);
  }

  async setBlock(blockerId: string, blockedId: string, blocked: boolean) {
    const key = `${blockerId}:${blockedId}`;
    if (blocked) this.blocks.add(key);
    else this.blocks.delete(key);
  }

  async insertContentReport(input: { reporterId: string; contentId: string; reason: string }) {
    this.contentReports.push(input);
  }

  async deleteUser(userId: string) {
    this.profiles.delete(userId);
    this.positions.delete(userId);
    for (const [k, v] of this.votes) if (v.userId === userId) this.votes.delete(k);
    for (const [k, v] of this.content) if (v.authorId === userId) this.content.delete(k);
    for (const k of this.follows) {
      if (k.startsWith(`${userId}:`) || k.endsWith(`:${userId}`)) this.follows.delete(k);
    }
    for (const k of this.blocks) {
      if (k.startsWith(`${userId}:`) || k.endsWith(`:${userId}`)) this.blocks.delete(k);
    }
    this.strikes.delete(userId);
    for (const [k, v] of this.comments) if (v.authorId === userId) this.comments.delete(k);
    for (const k of this.commentVotes.keys()) if (k.endsWith(`:${userId}`)) this.commentVotes.delete(k);
    for (const [k, v] of this.notifications) {
      if (v.userId === userId || v.actorId === userId) this.notifications.delete(k);
    }
    for (const k of this.alignmentCache.keys()) if (k.includes(userId)) this.alignmentCache.delete(k);
    for (const [k, v] of this.conversations) if (v.userA === userId || v.userB === userId) this.conversations.delete(k);
    for (const [k, v] of this.messages) if (v.senderId === userId) this.messages.delete(k);
    for (const [k, v] of this.hotTakes) if (v.authorId === userId) this.hotTakes.delete(k);
    for (const [k, v] of this.pushTokens) if (v === userId) this.pushTokens.delete(k);
  }

  async recordStrike(userId: string, _reason: string) {
    const next = (this.strikes.get(userId) ?? 0) + 1;
    this.strikes.set(userId, next);
    return next;
  }

  private tallyComment(commentId: string, viewerId: string) {
    let up = 0;
    let down = 0;
    let myVote: 1 | -1 | null = null;
    for (const [key, power] of this.commentVotes) {
      const [cid, uid] = key.split(":");
      if (cid !== commentId) continue;
      if (power === 1) up++;
      else down++;
      if (uid === viewerId) myVote = power;
    }
    return { up, down, myVote };
  }

  async listComments(contentId: string, viewerId: string) {
    return [...this.comments.values()]
      .filter((c) => c.contentId === contentId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((c) => ({ ...c, ...this.tallyComment(c.id, viewerId) }));
  }

  async getComment(id: string) {
    const row = this.comments.get(id);
    return row ? { id: row.id, contentId: row.contentId, authorId: row.authorId } : null;
  }

  async insertComment(input: { contentId: string; authorId: string; body: string }) {
    const row: CommentRow = {
      id: randomUUID(),
      contentId: input.contentId,
      authorId: input.authorId,
      body: input.body,
      createdAt: new Date().toISOString(),
      up: 0,
      down: 0,
      myVote: null,
    };
    this.comments.set(row.id, row);
    return row;
  }

  async voteComment(commentId: string, userId: string, power: 1 | -1) {
    const key = `${commentId}:${userId}`;
    const existing = this.commentVotes.get(key);
    const toggleOff = existing === power;
    if (toggleOff) this.commentVotes.delete(key);
    else this.commentVotes.set(key, power);

    const { up, down } = this.tallyComment(commentId, userId);
    return { up, down, myVote: toggleOff ? null : power };
  }

  async listNotifications(userId: string, limit: number) {
    return [...this.notifications.values()]
      .filter((n) => n.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async insertNotification(input: Omit<NotificationRow, "id" | "createdAt" | "readAt">) {
    const row: NotificationRow = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
    this.notifications.set(row.id, row);
    return row;
  }

  async getAlignmentCache(userA: string, userB: string) {
    const [a, b] = userA < userB ? [userA, userB] : [userB, userA];
    return this.alignmentCache.get(`${a}:${b}`) ?? null;
  }

  async setAlignmentCache(userA: string, userB: string, _perGrid: Record<GridId, number>, totalPct: number) {
    const [a, b] = userA < userB ? [userA, userB] : [userB, userA];
    this.alignmentCache.set(`${a}:${b}`, totalPct);
  }

  async listConversations(userId: string) {
    return [...this.conversations.values()].filter((c) => c.userA === userId || c.userB === userId);
  }

  async getConversation(id: string) {
    return this.conversations.get(id) ?? null;
  }

  async getOrCreateConversation(userA: string, userB: string) {
    const [a, b] = userA < userB ? [userA, userB] : [userB, userA];
    const existing = [...this.conversations.values()].find((c) => c.userA === a && c.userB === b);
    if (existing) return existing;
    const row: ConversationRow = { id: randomUUID(), userA: a, userB: b, createdAt: new Date().toISOString() };
    this.conversations.set(row.id, row);
    return row;
  }

  async listMessages(conversationId: string) {
    return [...this.messages.values()]
      .filter((m) => m.conversationId === conversationId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async listLastMessages(conversationIds: string[]) {
    const ids = new Set(conversationIds);
    const out: Record<string, MessageRow> = {};
    for (const m of [...this.messages.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
      if (ids.has(m.conversationId) && !out[m.conversationId]) out[m.conversationId] = m;
    }
    return out;
  }

  async insertMessage(input: Omit<MessageRow, "id" | "createdAt">) {
    const row: MessageRow = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
    this.messages.set(row.id, row);
    return row;
  }

  async listActiveHotTakes(limit: number) {
    const now = new Date().toISOString();
    return [...this.hotTakes.values()]
      .filter((t) => t.expiresAt > now)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async insertHotTake(input: { authorId: string; category: GridId; body: string }) {
    const now = Date.now();
    const row: HotTakeRow = {
      ...input,
      id: randomUUID(),
      up: 0,
      down: 0,
      comments: 0,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 14 * 3_600_000).toISOString(),
    };
    this.hotTakes.set(row.id, row);
    return row;
  }

  async savePushToken(userId: string, token: string) {
    this.pushTokens.set(token, userId);
  }

  async listPushTokens(userIds: string[]) {
    const wanted = new Set(userIds);
    return [...this.pushTokens.entries()]
      .filter(([, userId]) => wanted.has(userId))
      .map(([token, userId]) => ({ userId, token }));
  }

  async removePushToken(token: string) {
    this.pushTokens.delete(token);
  }
}

export const ME = ME_ID;
