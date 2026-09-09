import type { GridId, Scores } from "../core/types";
import { GRID_IDS } from "../core/grids";

export type ScorableContent = {
  type: "video" | "image";
  body: string;
  /** Grids the author says the post touches (spec §6.8). */
  categories?: GridId[];
};

/**
 * Spec §8: assign an (x, y) position plus a confidence per grid, for every post.
 *
 * This is the highest-risk, highest-cost component in the whole system, and the
 * spec (§13) says its real per-post cost should be measured before anything else
 * is finalised. Everything behind this interface is swappable: implement it with
 * a model, keep the API unchanged, and instrument cost at that boundary.
 */
export interface ContentScorer {
  readonly name: string;
  score(content: ScorableContent): Promise<Scores>;
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

  async score(content: ScorableContent): Promise<Scores> {
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
    return out;
  }
}
