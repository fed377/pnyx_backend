import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { ORIGIN, UNLOCK_AT } from "../core/algorithm";
import type { GridId, Positions, Scores, VotePower } from "../core/types";
import type {
  CommentRow,
  ContentRow,
  ConversationRow,
  HotTakeRow,
  MessageRow,
  NotificationRow,
  PositionsRow,
  ProfileRow,
  Tallies,
  VoteRow,
} from "../domain";
import type { ContentFilter, NewContent, Repository } from "./types";

type ProfileRecord = {
  id: string;
  handle: string;
  name: string;
  pronouns: string;
  bio: string;
  city: string;
  avatar_url: string | null;
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
  avatarUrl: r.avatar_url ?? undefined,
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

type CommentRecord = {
  id: string;
  content_id: string;
  author_id: string;
  body: string;
  created_at: string;
};

type NotificationRecord = {
  id: string;
  user_id: string;
  actor_id: string | null;
  kind: string;
  body: string;
  content_id: string | null;
  pct: number | null;
  read_at: string | null;
  created_at: string;
};

const toNotification = (r: NotificationRecord): NotificationRow => ({
  id: r.id,
  userId: r.user_id,
  actorId: r.actor_id ?? undefined,
  kind: r.kind,
  body: r.body,
  contentId: r.content_id ?? undefined,
  pct: r.pct ?? undefined,
  readAt: r.read_at ?? undefined,
  createdAt: r.created_at,
});

const toComment = (r: CommentRecord, up: number, down: number, myVote: 1 | -1 | null): CommentRow => ({
  id: r.id,
  contentId: r.content_id,
  authorId: r.author_id,
  body: r.body,
  createdAt: r.created_at,
  up,
  down,
  myVote,
});

type HotTakeRecord = {
  id: string;
  author_id: string;
  category: GridId;
  body: string;
  up_count: number;
  down_count: number;
  comment_count: number;
  created_at: string;
  expires_at: string;
};

const toHotTake = (r: HotTakeRecord): HotTakeRow => ({
  id: r.id,
  authorId: r.author_id,
  category: r.category,
  body: r.body,
  up: r.up_count,
  down: r.down_count,
  comments: r.comment_count,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
});

type ConversationRecord = { id: string; user_a: string; user_b: string; created_at: string };
type MessageRecord = {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string | null;
  content_id: string | null;
  vote_snapshot: VotePower | null;
  created_at: string;
};

const toConversation = (r: ConversationRecord): ConversationRow => ({
  id: r.id,
  userA: r.user_a,
  userB: r.user_b,
  createdAt: r.created_at,
});

const toMessage = (r: MessageRecord): MessageRow => ({
  id: r.id,
  conversationId: r.conversation_id,
  senderId: r.sender_id,
  body: r.body ?? undefined,
  contentId: r.content_id ?? undefined,
  voteSnapshot: r.vote_snapshot ?? undefined,
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
    if (patch.avatarUrl !== undefined) record.avatar_url = patch.avatarUrl;
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

  async listComments(contentId: string, viewerId: string) {
    const rows = unwrap(
      await this.db.from("comments").select("*").eq("content_id", contentId).order("created_at", { ascending: true }),
      "listComments",
    ) as CommentRecord[];
    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.id);
    const votesData = unwrap(
      await this.db.from("comment_votes").select("comment_id,user_id,power").in("comment_id", ids),
      "listComments (votes)",
    ) as { comment_id: string; user_id: string; power: 1 | -1 }[];

    const tallies = new Map<string, { up: number; down: number; myVote: 1 | -1 | null }>();
    for (const id of ids) tallies.set(id, { up: 0, down: 0, myVote: null });
    for (const v of votesData) {
      const t = tallies.get(v.comment_id)!;
      if (v.power === 1) t.up++;
      else t.down++;
      if (v.user_id === viewerId) t.myVote = v.power;
    }

    return rows.map((r) => {
      const t = tallies.get(r.id)!;
      return toComment(r, t.up, t.down, t.myVote);
    });
  }

  async getComment(id: string) {
    const { data, error } = await this.db.from("comments").select("id,content_id,author_id").eq("id", id).maybeSingle();
    if (error) throw new Error(`getComment: ${error.message}`);
    return data ? { id: data.id as string, contentId: data.content_id as string, authorId: data.author_id as string } : null;
  }

  async insertComment(input: { contentId: string; authorId: string; body: string }) {
    const data = unwrap(
      await this.db
        .from("comments")
        .insert({ content_id: input.contentId, author_id: input.authorId, body: input.body })
        .select("*")
        .single(),
      "insertComment",
    ) as CommentRecord;
    return toComment(data, 0, 0, null);
  }

  async voteComment(commentId: string, userId: string, power: 1 | -1) {
    const { data: existing, error: readErr } = await this.db
      .from("comment_votes")
      .select("power")
      .eq("comment_id", commentId)
      .eq("user_id", userId)
      .maybeSingle();
    if (readErr) throw new Error(`voteComment (read): ${readErr.message}`);

    const toggleOff = existing?.power === power;
    if (toggleOff) {
      const { error } = await this.db
        .from("comment_votes")
        .delete()
        .eq("comment_id", commentId)
        .eq("user_id", userId);
      if (error) throw new Error(`voteComment (delete): ${error.message}`);
    } else {
      const { error } = await this.db
        .from("comment_votes")
        .upsert({ comment_id: commentId, user_id: userId, power }, { onConflict: "comment_id,user_id" });
      if (error) throw new Error(`voteComment (upsert): ${error.message}`);
    }

    const { count: up, error: upErr } = await this.db
      .from("comment_votes")
      .select("*", { count: "exact", head: true })
      .eq("comment_id", commentId)
      .eq("power", 1);
    if (upErr) throw new Error(`voteComment (up count): ${upErr.message}`);
    const { count: down, error: downErr } = await this.db
      .from("comment_votes")
      .select("*", { count: "exact", head: true })
      .eq("comment_id", commentId)
      .eq("power", -1);
    if (downErr) throw new Error(`voteComment (down count): ${downErr.message}`);

    return { up: up ?? 0, down: down ?? 0, myVote: toggleOff ? null : power };
  }

  async listNotifications(userId: string, limit: number) {
    const data = unwrap(
      await this.db
        .from("notifications")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(limit),
      "listNotifications",
    ) as NotificationRecord[];
    return data.map(toNotification);
  }

  async insertNotification(input: Omit<NotificationRow, "id" | "createdAt" | "readAt">) {
    const data = unwrap(
      await this.db
        .from("notifications")
        .insert({
          user_id: input.userId,
          actor_id: input.actorId ?? null,
          kind: input.kind,
          body: input.body,
          content_id: input.contentId ?? null,
          pct: input.pct ?? null,
        })
        .select("*")
        .single(),
      "insertNotification",
    ) as NotificationRecord;
    return toNotification(data);
  }

  async getAlignmentCache(userA: string, userB: string) {
    const [a, b] = userA < userB ? [userA, userB] : [userB, userA];
    const { data, error } = await this.db
      .from("alignments")
      .select("total_pct")
      .eq("user_a", a)
      .eq("user_b", b)
      .maybeSingle();
    if (error) throw new Error(`getAlignmentCache: ${error.message}`);
    return data ? (data.total_pct as number) : null;
  }

  async setAlignmentCache(userA: string, userB: string, perGrid: Record<GridId, number>, totalPct: number) {
    const [a, b] = userA < userB ? [userA, userB] : [userB, userA];
    const { error } = await this.db.from("alignments").upsert(
      { user_a: a, user_b: b, per_grid: perGrid, total_pct: totalPct, computed_at: new Date().toISOString() },
      { onConflict: "user_a,user_b" },
    );
    if (error) throw new Error(`setAlignmentCache: ${error.message}`);
  }

  async listConversations(userId: string) {
    const data = unwrap(
      await this.db.from("conversations").select("*").or(`user_a.eq.${userId},user_b.eq.${userId}`),
      "listConversations",
    ) as ConversationRecord[];
    return data.map(toConversation);
  }

  async getConversation(id: string) {
    const { data, error } = await this.db.from("conversations").select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(`getConversation: ${error.message}`);
    return data ? toConversation(data as ConversationRecord) : null;
  }

  async getOrCreateConversation(userA: string, userB: string) {
    const [a, b] = userA < userB ? [userA, userB] : [userB, userA];
    const { data: existing, error: readErr } = await this.db
      .from("conversations")
      .select("*")
      .eq("user_a", a)
      .eq("user_b", b)
      .maybeSingle();
    if (readErr) throw new Error(`getOrCreateConversation (read): ${readErr.message}`);
    if (existing) return toConversation(existing as ConversationRecord);

    const data = unwrap(
      await this.db.from("conversations").insert({ user_a: a, user_b: b }).select("*").single(),
      "getOrCreateConversation (insert)",
    );
    return toConversation(data as ConversationRecord);
  }

  async listMessages(conversationId: string) {
    const data = unwrap(
      await this.db
        .from("messages")
        .select("*")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true }),
      "listMessages",
    ) as MessageRecord[];
    return data.map(toMessage);
  }

  async listLastMessages(conversationIds: string[]) {
    if (conversationIds.length === 0) return {};
    const data = unwrap(
      await this.db
        .from("messages")
        .select("*")
        .in("conversation_id", conversationIds)
        .order("created_at", { ascending: false }),
      "listLastMessages",
    ) as MessageRecord[];
    const out: Record<string, MessageRow> = {};
    for (const r of data) {
      // Already ordered newest-first, so the first one seen per conversation wins.
      if (!out[r.conversation_id]) out[r.conversation_id] = toMessage(r);
    }
    return out;
  }

  async insertMessage(input: Omit<MessageRow, "id" | "createdAt">) {
    const data = unwrap(
      await this.db
        .from("messages")
        .insert({
          conversation_id: input.conversationId,
          sender_id: input.senderId,
          body: input.body ?? null,
          content_id: input.contentId ?? null,
          vote_snapshot: input.voteSnapshot ?? null,
        })
        .select("*")
        .single(),
      "insertMessage",
    ) as MessageRecord;
    return toMessage(data);
  }

  async listActiveHotTakes(limit: number) {
    const data = unwrap(
      await this.db
        .from("hot_takes")
        .select("*")
        .gt("expires_at", new Date().toISOString())
        .order("created_at", { ascending: false })
        .limit(limit),
      "listActiveHotTakes",
    ) as HotTakeRecord[];
    return data.map(toHotTake);
  }

  async insertHotTake(input: { authorId: string; category: GridId; body: string }) {
    const data = unwrap(
      await this.db
        .from("hot_takes")
        .insert({ author_id: input.authorId, category: input.category, body: input.body })
        .select("*")
        .single(),
      "insertHotTake",
    ) as HotTakeRecord;
    return toHotTake(data);
  }
}
