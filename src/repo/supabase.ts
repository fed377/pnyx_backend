import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { ORIGIN, UNLOCK_AT } from "../core/algorithm";
import type { GridId, Positions, Scores, VotePower } from "../core/types";
import type { ContentRow, PositionsRow, ProfileRow, Tallies, VoteRow } from "../domain";
import type { ContentFilter, NewContent, Repository } from "./types";

type ProfileRecord = {
  id: string;
  handle: string;
  name: string;
  pronouns: string;
  bio: string;
  city: string;
  privacy_tier: ProfileRow["privacyTier"];
  grid_public: Record<GridId, boolean>;
  premium: boolean;
  created_at: string;
};

type PositionRecord = {
  user_id: string;
  values_x: number; values_y: number;
  mind_x: number; mind_y: number;
  soul_x: number; soul_y: number;
  culture_x: number; culture_y: number;
  focus_x: number; focus_y: number;
  vote_count: number;
};

type ContentRecord = {
  id: string;
  author_id: string;
  type: ContentRow["type"];
  body: string;
  context: string | null;
  music: string | null;
  media_url: string | null;
  scores: Scores;
  scorer: string;
  moderation_status: ContentRow["moderationStatus"];
  love_count: number;
  like_count: number;
  dislike_count: number;
  hate_count: number;
  created_at: string;
};

type VoteRecord = {
  id: string;
  user_id: string;
  content_id: string;
  power: VotePower;
  scores_snapshot: Scores;
  created_at: string;
};

const toProfile = (r: ProfileRecord): ProfileRow => ({
  id: r.id,
  handle: r.handle,
  name: r.name,
  pronouns: r.pronouns,
  bio: r.bio,
  city: r.city,
  privacyTier: r.privacy_tier,
  gridPublic: r.grid_public,
  premium: r.premium,
  createdAt: r.created_at,
});

const toPositions = (r: PositionRecord): PositionsRow => ({
  userId: r.user_id,
  positions: {
    values: { x: r.values_x, y: r.values_y },
    mind: { x: r.mind_x, y: r.mind_y },
    soul: { x: r.soul_x, y: r.soul_y },
    culture: { x: r.culture_x, y: r.culture_y },
    focus: { x: r.focus_x, y: r.focus_y },
  },
  voteCount: r.vote_count,
  unlocked: r.vote_count >= UNLOCK_AT,
});

const toContent = (r: ContentRecord): ContentRow => ({
  id: r.id,
  authorId: r.author_id,
  type: r.type,
  body: r.body,
  context: r.context ?? undefined,
  music: r.music ?? undefined,
  mediaUrl: r.media_url ?? undefined,
  scores: r.scores,
  scorer: r.scorer,
  moderationStatus: r.moderation_status,
  tallies: {
    love: r.love_count,
    like: r.like_count,
    dislike: r.dislike_count,
    hate: r.hate_count,
  },
  createdAt: r.created_at,
});

const toVote = (r: VoteRecord): VoteRow => ({
  id: r.id,
  userId: r.user_id,
  contentId: r.content_id,
  power: r.power,
  scoresSnapshot: r.scores_snapshot,
  createdAt: r.created_at,
});

function unwrap(res: { data: unknown; error: { message: string } | null }, what: string): unknown {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  if (res.data === null || res.data === undefined) throw new Error(`${what}: no data returned`);
  return res.data;
}

/**
 * Uses the service-role key, so it bypasses RLS by design: this process is the
 * trusted writer of grid_positions. The RLS policies in the migration exist to
 * constrain anything that talks to Supabase directly with a user token.
 */
export class SupabaseRepository implements Repository {
  private readonly db: SupabaseClient;

  constructor(url: string, serviceKey: string) {
    this.db = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  async getProfile(id: string) {
    const { data, error } = await this.db.from("profiles").select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(`getProfile: ${error.message}`);
    return data ? toProfile(data as ProfileRecord) : null;
  }

  async listProfiles(exceptId?: string) {
    let q = this.db.from("profiles").select("*");
    if (exceptId) q = q.neq("id", exceptId);
    const data = unwrap(await q, "listProfiles");
    return (data as ProfileRecord[]).map(toProfile);
  }

  async updateProfile(id: string, patch: Partial<ProfileRow>) {
    const record: Record<string, unknown> = {};
    if (patch.handle !== undefined) record.handle = patch.handle;
    if (patch.name !== undefined) record.name = patch.name;
    if (patch.pronouns !== undefined) record.pronouns = patch.pronouns;
    if (patch.bio !== undefined) record.bio = patch.bio;
    if (patch.city !== undefined) record.city = patch.city;
    if (patch.privacyTier !== undefined) {
      record.privacy_tier = patch.privacyTier;
      record.tier_changed_at = new Date().toISOString();
    }
    if (patch.gridPublic !== undefined) record.grid_public = patch.gridPublic;

    const data = unwrap(
      await this.db.from("profiles").update(record).eq("id", id).select("*").single(),
      "updateProfile",
    );
    return toProfile(data as ProfileRecord);
  }

  async getPositions(userId: string): Promise<PositionsRow> {
    const { data, error } = await this.db
      .from("grid_positions")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw new Error(`getPositions: ${error.message}`);
    if (!data) {
      return { userId, positions: structuredClone(ORIGIN), voteCount: 0, unlocked: false };
    }
    return toPositions(data as PositionRecord);
  }

  async savePositions(userId: string, positions: Positions, voteCount: number) {
    const { error } = await this.db.from("grid_positions").upsert(
      {
        user_id: userId,
        values_x: positions.values.x, values_y: positions.values.y,
        mind_x: positions.mind.x, mind_y: positions.mind.y,
        soul_x: positions.soul.x, soul_y: positions.soul.y,
        culture_x: positions.culture.x, culture_y: positions.culture.y,
        focus_x: positions.focus.x, focus_y: positions.focus.y,
        vote_count: voteCount,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    if (error) throw new Error(`savePositions: ${error.message}`);
  }

  async listPositions(userIds: string[]) {
    if (userIds.length === 0) return [];
    const data = unwrap(
      await this.db.from("grid_positions").select("*").in("user_id", userIds),
      "listPositions",
    );
    const found = (data as PositionRecord[]).map(toPositions);
    const seen = new Set(found.map((p) => p.userId));
    // People who have never voted have no row yet; they sit at the origin.
    for (const id of userIds) {
      if (!seen.has(id)) {
        found.push({ userId: id, positions: structuredClone(ORIGIN), voteCount: 0, unlocked: false });
      }
    }
    return found;
  }

  async getContent(id: string) {
    const { data, error } = await this.db.from("content").select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(`getContent: ${error.message}`);
    return data ? toContent(data as ContentRecord) : null;
  }

  async listContent(filter: ContentFilter) {
    let q = this.db.from("content").select("*").order("created_at", { ascending: false });
    if (filter.type) q = q.eq("type", filter.type);
    if (filter.types) q = q.in("type", filter.types);
    if (filter.authorId) q = q.eq("author_id", filter.authorId);
    if (filter.moderationStatus) q = q.eq("moderation_status", filter.moderationStatus);
    if (filter.limit) q = q.limit(filter.limit);
    const data = unwrap(await q, "listContent");
    return (data as ContentRecord[]).map(toContent);
  }

  async insertContent(row: NewContent) {
    const data = unwrap(
      await this.db
        .from("content")
        .insert({
          author_id: row.authorId,
          type: row.type,
          body: row.body,
          context: row.context ?? null,
          music: row.music ?? null,
          media_url: row.mediaUrl ?? null,
          scores: row.scores,
          scorer: row.scorer,
          moderation_status: row.moderationStatus,
        })
        .select("*")
        .single(),
      "insertContent",
    );
    return toContent(data as ContentRecord);
  }

  async adjustTallies(contentId: string, delta: Partial<Record<keyof Tallies, number>>) {
    const { error } = await this.db.rpc("adjust_tallies", {
      target: contentId,
      d_love: delta.love ?? 0,
      d_like: delta.like ?? 0,
      d_dislike: delta.dislike ?? 0,
      d_hate: delta.hate ?? 0,
    });
    if (error) throw new Error(`adjustTallies: ${error.message}`);
  }

  async setModerationStatus(contentId: string, status: ContentRow["moderationStatus"]) {
    const { error } = await this.db
      .from("content")
      .update({ moderation_status: status })
      .eq("id", contentId);
    if (error) throw new Error(`setModerationStatus: ${error.message}`);
  }

  async upsertVote(vote: Omit<VoteRow, "id" | "createdAt">) {
    const { data: existing, error: readErr } = await this.db
      .from("votes")
      .select("power")
      .eq("user_id", vote.userId)
      .eq("content_id", vote.contentId)
      .maybeSingle();
    if (readErr) throw new Error(`upsertVote (read): ${readErr.message}`);

    const { error } = await this.db.from("votes").upsert(
      {
        user_id: vote.userId,
        content_id: vote.contentId,
        power: vote.power,
        scores_snapshot: vote.scoresSnapshot,
        // Re-voting refreshes recency, which is what the decay window measures.
        created_at: new Date().toISOString(),
      },
      { onConflict: "user_id,content_id" },
    );
    if (error) throw new Error(`upsertVote: ${error.message}`);

    return { previousPower: (existing?.power as VotePower | undefined) ?? null };
  }

  async recentVotes(userId: string, limit: number) {
    const data = unwrap(
      await this.db
        .from("votes")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(limit),
      "recentVotes",
    );
    return (data as VoteRecord[]).map(toVote);
  }

  async countVotes(userId: string) {
    const { count, error } = await this.db
      .from("votes")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId);
    if (error) throw new Error(`countVotes: ${error.message}`);
    return count ?? 0;
  }

  async listFollowing(userId: string) {
    const data = unwrap(
      await this.db.from("follows").select("followee_id").eq("follower_id", userId),
      "listFollowing",
    );
    return (data as { followee_id: string }[]).map((r) => r.followee_id);
  }

  async listFollowers(userId: string) {
    const data = unwrap(
      await this.db.from("follows").select("follower_id").eq("followee_id", userId),
      "listFollowers",
    );
    return (data as { follower_id: string }[]).map((r) => r.follower_id);
  }

  async setFollow(followerId: string, followeeId: string, following: boolean) {
    if (following) {
      const { error } = await this.db
        .from("follows")
        .upsert({ follower_id: followerId, followee_id: followeeId }, { onConflict: "follower_id,followee_id" });
      if (error) throw new Error(`setFollow: ${error.message}`);
    } else {
      const { error } = await this.db
        .from("follows")
        .delete()
        .eq("follower_id", followerId)
        .eq("followee_id", followeeId);
      if (error) throw new Error(`unfollow: ${error.message}`);
    }
  }

  /** Deleting the auth user cascades through every table (see the migration). */
  async deleteUser(userId: string) {
    const { error } = await this.db.rpc("forget_me", { target: userId });
    if (error) throw new Error(`deleteUser: ${error.message}`);
  }

  async recordStrike(userId: string, reason: string) {
    const { data, error } = await this.db.rpc("record_strike", { target: userId, why: reason });
    if (error) throw new Error(`recordStrike: ${error.message}`);
    return data as number;
  }
}
