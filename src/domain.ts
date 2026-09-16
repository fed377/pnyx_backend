import type { GridId, Positions, PrivacyTier, Scores, VotePower } from "./core/types";

export type ProfileRow = {
  id: string;
  handle: string;
  name: string;
  pronouns: string;
  bio: string;
  city: string;
  avatarUrl?: string;
  privacyTier: PrivacyTier;
  /** Which grids this person lets others compare against (spec §4.4). */
  gridPublic: Record<GridId, boolean>;
  premium: boolean;
  /**
   * Whether this account has been through Onboarding (handle, age-gate,
   * bio) — an account-level fact, not a device-level one. The client used
   * to track "has onboarded" purely as local AsyncStorage state, which a
   * sign-out or a second device had no way to know was already true.
   */
  onboarded: boolean;
  /** Which of the notification kinds a push should actually go out for.
   * "follow" has no toggle — there was never a Settings row for it, so it
   * always sends. */
  notifPrefs: { votes: boolean; replies: boolean; alignments: boolean };
  createdAt: string;
};

/** Derived from votes by the server. Never accepted from a client. */
export type PositionsRow = {
  userId: string;
  positions: Positions;
  voteCount: number;
  unlocked: boolean;
};

export type ContentType = "video" | "image" | "text";
export type ModerationStatus = "pending" | "approved" | "rejected";

export type Tallies = { love: number; like: number; dislike: number; hate: number };

export type ContentRow = {
  id: string;
  authorId: string;
  type: ContentType;
  body: string;
  context?: string;
  music?: string;
  mediaUrl?: string;
  scores: Scores;
  scorer: string;
  moderationStatus: ModerationStatus;
  tallies: Tallies;
  createdAt: string;
};

export type VoteRow = {
  id: string;
  userId: string;
  contentId: string;
  power: VotePower;
  /** r and C at cast time, so the window can be replayed exactly (spec §7). */
  scoresSnapshot: Scores;
  createdAt: string;
};

export type CommentRow = {
  id: string;
  contentId: string;
  authorId: string;
  body: string;
  createdAt: string;
  up: number;
  down: number;
  /** This viewer's own agree/disagree, if they've cast one. */
  myVote: 1 | -1 | null;
};

export type HotTakeRow = {
  id: string;
  authorId: string;
  category: GridId;
  body: string;
  up: number;
  down: number;
  comments: number;
  createdAt: string;
  expiresAt: string;
};

export type ConversationRow = {
  id: string;
  userA: string;
  userB: string;
  createdAt: string;
};

export type MessageRow = {
  id: string;
  conversationId: string;
  senderId: string;
  body?: string;
  /** A forwarded post, and the sender's own vote on it at forward time. */
  contentId?: string;
  voteSnapshot?: VotePower;
  createdAt: string;
};

export type NotificationRow = {
  id: string;
  userId: string;
  actorId?: string;
  kind: string;
  /** Pre-rendered suffix — the client prepends the actor's name itself. */
  body: string;
  contentId?: string;
  /** "alignment" only. */
  pct?: number;
  readAt?: string;
  createdAt: string;
};

export const bucketOf = (power: VotePower): keyof Tallies =>
  power === 2 ? "love" : power === 1 ? "like" : power === -1 ? "dislike" : "hate";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Extra fields merged into the error response body (e.g. a moderation code). */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
