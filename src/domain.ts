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
