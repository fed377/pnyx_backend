import type { GridId, Scores } from "../core/types";
import { GRID_IDS } from "../core/grids";

export type ScorableContent = {
  type: "video" | "image";
  body: string;
  /** Grids the author says the post touches (spec §6.8). */
  categories?: GridId[];
  /** Public URL of the uploaded file, for scorers that can look at the media itself. */
  mediaUrl?: string;
};

/**
 * A scorer doesn't just place a post on the five grids — it's also the first
 * (and only, cost-wise) thing that looks at a post before it can reach anyone,
 * so it doubles as the moderation gate:
 *
 * - "ok": a genuine, on-topic opinion. Score it normally.
 * - "policy_violation": content that should never be published (illegal, unsafe,
 *   or otherwise against the ToS). The poster is flagged for it — never mind
 *   that PNYX exists to host unpopular opinions, this is about content, not
 *   viewpoint.
 * - "low_effort": nothing wrong with it, but there's no actual opinion or
 *   meaningful statement to react to (spam, blank captions, keyboard mashing).
 *   Not a strike — just not publishable on an app whose whole premise is a
 *   genuine reaction to a genuine take.
 */
export type ModerationVerdict = "ok" | "policy_violation" | "low_effort";

export type ScoreOutcome =
  | { verdict: "ok"; scores: Scores }
  | { verdict: "policy_violation"; reason: string }
  | { verdict: "low_effort"; reason: string };

/**
 * Spec §8: assign an (x, y) position plus a confidence per grid, for every post
 * — and, per the above, decide whether the post can be published at all.
 *
 * This is the highest-risk, highest-cost component in the whole system, and the
 * spec (§13) says its real per-post cost should be measured before anything else
 * is finalised. Everything behind this interface is swappable: implement it with
 * a model, keep the API unchanged, and instrument cost at that boundary.
 */
export interface ContentScorer {
  readonly name: string;
  score(content: ScorableContent): Promise<ScoreOutcome>;
}

/** Grids the model judged irrelevant get a near-central point and low confidence. */
const IRRELEVANT = { x: 0, y: 0, confidence: 0.12 };

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

/**
 * Placeholder scorer: deterministic, free, and instant.
 *
 * It is NOT a model. It spreads content across the grids the author selected so
 * the pipeline, the movement equation and the recommender can be exercised
 * end-to-end. Positions carry no semantic meaning — do not ship it to users and
 * do not draw conclusions from profiles built on it.
 */
export class DeterministicScorer implements ContentScorer {
  readonly name = "deterministic-stub";

  async score(content: ScorableContent): Promise<ScoreOutcome> {
    const relevant = new Set<GridId>(
      content.categories?.length ? content.categories : GRID_IDS,
    );
    const out = {} as Scores;
    for (const g of GRID_IDS) {
      if (!relevant.has(g)) {
        out[g] = { ...IRRELEVANT };
        continue;
      }
      const seed = `${content.body}|${g}`;
      out[g] = {
        x: Number((hash(seed + "x") * 2 - 1).toFixed(4)),
        y: Number((hash(seed + "y") * 2 - 1).toFixed(4)),
        // Author-declared categories get mid confidence; nothing here is certain.
        confidence: Number((0.4 + hash(seed + "c") * 0.3).toFixed(4)),
      };
    }
    // This is a placeholder scorer with no semantic understanding — it can't
    // actually judge moderation or meaningfulness, so it never blocks.
    return { verdict: "ok", scores: out };
  }
}
