import type { Positions, VotePower } from "../core/types";
import type { ContentRow, PositionsRow, ProfileRow, VoteRow } from "../domain";

export type ContentFilter = {
  type?: ContentRow["type"];
  types?: ContentRow["type"][];
  authorId?: string;
  moderationStatus?: ContentRow["moderationStatus"];
  limit?: number;
};

export type NewContent = Omit<ContentRow, "id" | "createdAt" | "tallies">;

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

  /* votes */
  upsertVote(vote: Omit<VoteRow, "id" | "createdAt">): Promise<{ previousPower: VotePower | null }>;
  /** Newest first, capped at `limit`. The service reverses it for replay. */
  recentVotes(userId: string, limit: number): Promise<VoteRow[]>;
  countVotes(userId: string): Promise<number>;

  /* social */
  listFollowing(userId: string): Promise<string[]>;
  listFollowers(userId: string): Promise<string[]>;
  setFollow(followerId: string, followeeId: string, following: boolean): Promise<void>;

  /* GDPR */
  deleteUser(userId: string): Promise<void>;
}
