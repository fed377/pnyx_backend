export type GridId = "values" | "mind" | "soul" | "culture" | "focus";

export type Point = { x: number; y: number };

/** A named reference position on a grid (one of 13 per grid). */
export type GridPoint = Point & {
  name: string;
  /** Colour value for the grids that drive a colour; the Values grid uses `animal`. */
  hex?: string;
  animal?: AnimalId;
  meaning: string;
};

export type Grid = {
  id: GridId;
  label: string;
  /** What this grid contributes to the identity icon. */
  determines: string;
  axisX: { neg: string; pos: string };
  axisY: { neg: string; pos: string };
  points: GridPoint[];
};

export type AnimalId =
  | "dragon"
  | "bear"
  | "lion"
  | "wolf"
  | "fish"
  | "capybara"
  | "deer"
  | "turtle"
  | "owl"
  | "eagle"
  | "bull"
  | "cobra"
  | "fox";

export type Positions = Record<GridId, Point>;

/** AI content score on one grid: position + the model's confidence in it. */
export type Score = Point & { confidence: number };
export type Scores = Record<GridId, Score>;

export type VotePower = 1 | 2 | -1 | -2;

export type Vote = {
  contentId: string;
  power: VotePower;
  at: number;
  /** Snapshot of the AI scores at cast time, so history can be replayed. */
  scores: Scores;
};

export type PrivacyTier = "speaker" | "active" | "private";

export type ContentType = "video" | "image" | "text";

export type Comment = {
  id: string;
  authorId: string;
  text: string;
  up: number;
  down: number;
};

export type Content = {
  id: string;
  authorId: string;
  type: ContentType;
  /** The take itself. Every PNYX post is an opinion. */
  text: string;
  /** Optional second line shown under the take on image/reel surfaces. */
  context?: string;
  /** Uploaded media, when the post has any. Seeded posts do not. */
  mediaUrl?: string;
  /** Absent on sample content, which is treated as already approved. */
  moderationStatus?: "pending" | "approved" | "rejected";
  music?: string;
  createdAt: number;
  scores: Scores;
  comments: Comment[];
  /** Deterministic mock of the global vote split, used after the user votes. */
  globalSplit: { love: number; like: number; dislike: number; hate: number };
};

export type Person = {
  id: string;
  handle: string;
  name: string;
  pronouns: string;
  bio: string;
  tier: PrivacyTier;
  city: string;
  /** A real uploaded photo, when they have one — falls back to the monogram
   * avatar otherwise. */
  avatarUrl?: string;
  positions: Positions;
  voteCount: number;
  following: boolean;
  follower: boolean;
};

export type HotTake = {
  id: string;
  authorId: string;
  text: string;
  /** Which grid this take is filed under — shown as its category chip. */
  category: GridId;
  /** Static reaction counts. Hot Takes are ephemeral and don't move your
   * grids (spec), so these are display-only, not something you can cast. */
  up: number;
  down: number;
  comments: number;
  createdAt: number;
};

export type ChatMessage = {
  id: string;
  from: string;
  text?: string;
  contentId?: string;
  /** A forwarded post carries the sender's vote on it. */
  vote?: VotePower;
  at: number;
};

export type Conversation = {
  id: string;
  personId: string;
  messages: ChatMessage[];
};
