import type { GridId, Positions, VotePower } from "../core/types";
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

export type ContentFilter = {
  type?: ContentRow["type"];
  types?: ContentRow["type"][];
  authorId?: string;
  moderationStatus?: ContentRow["moderationStatus"];
  limit?: number;
};

export type NewContent = Omit<ContentRow, "id" | "createdAt" | "tallies" | "commentCount">;

export interface Repository {
  /* profiles */
  getProfile(id: string): Promise<ProfileRow | null>;
  listProfiles(exceptId?: string): Promise<ProfileRow[]>;
  updateProfile(id: string, patch: Partial<ProfileRow>): Promise<ProfileRow>;

  /* positions — server-owned */
  getPositions(userId: string): Promise<PositionsRow>;
  savePositions(userId: string, positions: Positions, voteCount: number): Promise<void>;
  listPositions(userIds: string[]): Promise<PositionsRow[]>;

  /* content */
  getContent(id: string): Promise<ContentRow | null>;
  listContent(filter: ContentFilter): Promise<ContentRow[]>;
  insertContent(row: NewContent): Promise<ContentRow>;
  adjustTallies(contentId: string, delta: Partial<Record<"love" | "like" | "dislike" | "hate", number>>): Promise<void>;
  /** Moderation decision (spec §8). Nothing is votable until it is approved. */
  setModerationStatus(contentId: string, status: ContentRow["moderationStatus"]): Promise<void>;
  incrementCommentCount(contentId: string): Promise<void>;

  /* votes */
  upsertVote(vote: Omit<VoteRow, "id" | "createdAt">): Promise<{ previousPower: VotePower | null }>;
  /** Newest first, capped at `limit`. The service reverses it for replay. */
  recentVotes(userId: string, limit: number): Promise<VoteRow[]>;
  countVotes(userId: string): Promise<number>;
  /** Real cast votes on one piece of content, restricted to `userIds` (the
   * viewer's followees — spec §6.2's "friends' votes"). */
  listVotesFor(contentId: string, userIds: string[]): Promise<{ userId: string; power: VotePower }[]>;

  /* social */
  listFollowing(userId: string): Promise<string[]>;
  listFollowers(userId: string): Promise<string[]>;
  setFollow(followerId: string, followeeId: string, following: boolean): Promise<void>;

  /* GDPR */
  deleteUser(userId: string): Promise<void>;

  /* moderation */
  /** Logs a content-moderation strike against a user and returns their new total. */
  recordStrike(userId: string, reason: string): Promise<number>;

  /* comments */
  listComments(contentId: string, viewerId: string): Promise<CommentRow[]>;
  getComment(id: string): Promise<{ id: string; contentId: string; authorId: string } | null>;
  insertComment(input: { contentId: string; authorId: string; body: string }): Promise<CommentRow>;
  /** Toggles off if `power` matches the viewer's existing vote, otherwise sets/switches it. */
  voteComment(
    commentId: string,
    userId: string,
    power: 1 | -1,
  ): Promise<{ up: number; down: number; myVote: 1 | -1 | null }>;

  /* notifications */
  listNotifications(userId: string, limit: number): Promise<NotificationRow[]>;
  insertNotification(input: Omit<NotificationRow, "id" | "createdAt" | "readAt">): Promise<NotificationRow>;

  /* alignment cache (spec §7) — also doubles as "was this pair already above
   * the threshold" state for the alignment-crossing notification. */
  getAlignmentCache(userA: string, userB: string): Promise<number | null>;
  setAlignmentCache(
    userA: string,
    userB: string,
    perGrid: Record<GridId, number>,
    totalPct: number,
  ): Promise<void>;

  /* messages (spec §6.7) */
  listConversations(userId: string): Promise<ConversationRow[]>;
  getConversation(id: string): Promise<ConversationRow | null>;
  /** Normalizes (userA, userB) order itself — the table requires user_a < user_b. */
  getOrCreateConversation(userA: string, userB: string): Promise<ConversationRow>;
  listMessages(conversationId: string): Promise<MessageRow[]>;
  /** The newest message per conversation, for a conversation-list preview. */
  listLastMessages(conversationIds: string[]): Promise<Record<string, MessageRow>>;
  insertMessage(input: Omit<MessageRow, "id" | "createdAt">): Promise<MessageRow>;

  /* hot takes */
  /** Not-yet-expired takes, newest first. */
  listActiveHotTakes(limit: number): Promise<HotTakeRow[]>;
  insertHotTake(input: { authorId: string; category: GridId; body: string }): Promise<HotTakeRow>;

  /* push notifications */
  /** Idempotent — the same device token re-registering (app relaunch, token
   * refresh) just re-points it at the current user rather than duplicating. */
  savePushToken(userId: string, token: string): Promise<void>;
  listPushTokens(userIds: string[]): Promise<{ userId: string; token: string }[]>;
  /** Called when Expo's push service reports a token as dead. */
  removePushToken(token: string): Promise<void>;
}
