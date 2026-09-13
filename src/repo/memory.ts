import { randomUUID } from "node:crypto";
import { ORIGIN } from "../core/algorithm";
import { ALL_CONTENT, ME_DEFAULTS, ME_ID, PEOPLE } from "../core/data";
import type { Positions } from "../core/types";
import type { ContentRow, PositionsRow, ProfileRow, VoteRow } from "../domain";
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
  private strikes = new Map<string, number>();

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
      gridPublic: { values: true, mind: true, soul: true, culture: false, focus: true },
      premium: false,
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
        gridPublic: { values: true, mind: true, soul: true, culture: true, focus: true },
        premium: false,
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

  async deleteUser(userId: string) {
    this.profiles.delete(userId);
    this.positions.delete(userId);
    for (const [k, v] of this.votes) if (v.userId === userId) this.votes.delete(k);
    for (const [k, v] of this.content) if (v.authorId === userId) this.content.delete(k);
    for (const k of this.follows) {
      if (k.startsWith(`${userId}:`) || k.endsWith(`:${userId}`)) this.follows.delete(k);
    }
    this.strikes.delete(userId);
  }

  async recordStrike(userId: string, _reason: string) {
    const next = (this.strikes.get(userId) ?? 0) + 1;
    this.strikes.set(userId, next);
    return next;
  }
}

export const ME = ME_ID;
