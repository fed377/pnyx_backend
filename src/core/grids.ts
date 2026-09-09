import type { Grid, GridId, GridPoint, Point } from "./types";

/**
 * The five grids (spec §3).
 *
 * Axis orientation is derived from the quadrant labels in the spec tables rather
 * than the column order of the summary table, because the two disagree for
 * Mind (the summary lists Emotive↔Scientific first, but the table puts that on
 * the vertical axis). Every grid here follows one rule: the first-listed pole of
 * each axis sits at the negative end.
 *
 * Known spec inconsistency — CULTURE: two of the four quadrants label Broad/Niche
 * in a way that cannot coexist. (+x,+y) is "Classical+Niche" and (-x,+y) is
 * "Classical+Broad", which puts Niche at +x; but (+x,-y) is "Contemporary+Broad"
 * and (-x,-y) is "Contemporary+Niche", which puts Broad at +x. We keep Niche at
 * +x — it matches the classical half of the table and the axis rule every other
 * grid follows. Coordinates, names and hex values are exactly as specified.
 */

export const GRID_IDS: GridId[] = ["values", "mind", "soul", "culture", "focus"];

const values: Grid = {
  id: "values",
  label: "Values",
  determines: "Animal",
  axisX: { neg: "Individualist", pos: "Communitarian" },
  axisY: { neg: "Progressive", pos: "Traditionalist" },
  points: [
    { x: 0, y: 0, animal: "dragon", name: "Adapt", meaning: "Balances independence and belonging" },
    { x: 0.33, y: 0.33, animal: "bear", name: "Stable", meaning: "Values security, loyalty, continuity" },
    { x: 0.66, y: 0.66, animal: "lion", name: "Lead", meaning: "Protects the group and its traditions" },
    { x: 1, y: 1, animal: "wolf", name: "Loyalty", meaning: "The group comes first" },
    { x: 0.33, y: -0.33, animal: "fish", name: "Flex", meaning: "Moves with change while staying connected" },
    { x: 0.66, y: -0.66, animal: "capybara", name: "Harmony", meaning: "Seeks cooperation and social balance" },
    { x: 1, y: -1, animal: "deer", name: "Empath", meaning: "Prioritises inclusion and others' wellbeing" },
    { x: -0.33, y: -0.33, animal: "turtle", name: "Patience", meaning: "Follows its own pace, open to change" },
    { x: -0.66, y: -0.66, animal: "owl", name: "Marvel", meaning: "Questions convention, thinks independently" },
    { x: -1, y: -1, animal: "eagle", name: "Free", meaning: "Values autonomy above convention" },
    { x: -0.33, y: 0.33, animal: "bull", name: "Fervent", meaning: "Holds firmly to personal principles" },
    { x: -0.66, y: 0.66, animal: "cobra", name: "Defy", meaning: "Resists pressure to conform" },
    { x: -1, y: 1, animal: "fox", name: "Cunning", meaning: "Finds its own way around constraints" },
  ],
};

const mind: Grid = {
  id: "mind",
  label: "Mind",
  determines: "Primary colour",
  axisX: { neg: "Theoretical", pos: "Practical" },
  axisY: { neg: "Scientific", pos: "Emotive" },
  points: [
    { x: 0, y: 0, name: "Violet", hex: "#8B5CF6", meaning: "Weighs feeling and evidence in equal measure" },
    { x: 0.33, y: 0.33, name: "Amethyst", hex: "#A855F7", meaning: "Trusts instinct, then tests it on something real" },
    { x: 0.66, y: 0.66, name: "Orchid", hex: "#C026D3", meaning: "Reads the room faster than the report" },
    { x: 1, y: 1, name: "Magenta", hex: "#E11D8D", meaning: "Decides on feel and builds it the same day" },
    { x: 0.33, y: -0.33, name: "Lavender", hex: "#A78BFA", meaning: "Wants the method, but only if it ships" },
    { x: 0.66, y: -0.66, name: "Periwinkle", hex: "#818CF8", meaning: "Measures first, argues later" },
    { x: 1, y: -1, name: "Indigo", hex: "#6366F1", meaning: "Evidence, applied — nothing decorative" },
    { x: -0.33, y: -0.33, name: "Sapphire", hex: "#4F46E5", meaning: "Prefers the underlying rule to the worked example" },
    { x: -0.66, y: -0.66, name: "Cobalt", hex: "#4338CA", meaning: "Happiest one abstraction above the problem" },
    { x: -1, y: -1, name: "Ultramarine", hex: "#312E81", meaning: "Truth first, usefulness whenever" },
    { x: -0.33, y: 0.33, name: "Plum", hex: "#7E22CE", meaning: "Thinks in images and meanings" },
    { x: -0.66, y: 0.66, name: "Royal", hex: "#7C3AED", meaning: "Builds whole worlds before touching one" },
    { x: -1, y: 1, name: "Iris", hex: "#6D28D9", meaning: "The feeling is the argument" },
  ],
};

const soul: Grid = {
  id: "soul",
  label: "Soul",
  determines: "Highlight",
  axisX: { neg: "Grave", pos: "Humorous" },
  axisY: { neg: "Introvert", pos: "Extrovert" },
  points: [
    { x: 0, y: 0, name: "Teal", hex: "#14B8A6", meaning: "Reads a room, then decides how much to take up" },
    { x: 0.33, y: 0.33, name: "Coral", hex: "#FB7185", meaning: "Warms a room without trying to own it" },
    { x: 0.66, y: 0.66, name: "Pink", hex: "#F43F8E", meaning: "The one who starts the group chat" },
    { x: 1, y: 1, name: "Rose", hex: "#E11D74", meaning: "Runs on people and punchlines" },
    { x: 0.33, y: -0.33, name: "Mint", hex: "#2DD4BF", meaning: "Quiet, and quietly very funny" },
    { x: 0.66, y: -0.66, name: "Aqua", hex: "#06B6D4", meaning: "Says one thing an hour and it lands" },
    { x: 1, y: -1, name: "Cyan", hex: "#0891B2", meaning: "Deadpan, offstage, unbothered" },
    { x: -0.33, y: -0.33, name: "Slate", hex: "#475569", meaning: "Says less than they know" },
    { x: -0.66, y: -0.66, name: "Navy", hex: "#334155", meaning: "Keeps their weather to themselves" },
    { x: -1, y: -1, name: "Midnight", hex: "#1E293B", meaning: "Solitude is the default setting" },
    { x: -0.33, y: 0.33, name: "Amber", hex: "#D97706", meaning: "Speaks up, and means it" },
    { x: -0.66, y: 0.66, name: "Vermilion", hex: "#C2410C", meaning: "Arrives with a position" },
    { x: -1, y: 1, name: "Crimson", hex: "#BE123C", meaning: "Public, urgent, unwilling to soften it" },
  ],
};

const culture: Grid = {
  id: "culture",
  label: "Culture",
  determines: "Base",
  axisX: { neg: "Broad", pos: "Niche" },
  axisY: { neg: "Contemporary", pos: "Classical" },
  points: [
    { x: 0, y: 0, name: "Stone", hex: "#94A3B8", meaning: "Takes the canon and the feed at face value" },
    { x: 0.33, y: 0.33, name: "Champagne", hex: "#D6C6A8", meaning: "Old things, off the beaten path" },
    { x: 0.66, y: 0.66, name: "Antique", hex: "#C9A66B", meaning: "Collects what the canon forgot" },
    { x: 1, y: 1, name: "Gold", hex: "#B89445", meaning: "Devoted to the rare and the enduring" },
    { x: 0.33, y: -0.33, name: "Sky", hex: "#7DD3FC", meaning: "Finds the new thing early" },
    { x: 0.66, y: -0.66, name: "Aqua", hex: "#67E8F9", meaning: "Lives three months ahead of the feed" },
    { x: 1, y: -1, name: "Cyan", hex: "#22D3EE", meaning: "Nothing mainstream, nothing older than last year" },
    { x: -0.33, y: -0.33, name: "Lilac", hex: "#A5B4FC", meaning: "Watches what everyone is watching, now" },
    { x: -0.66, y: -0.66, name: "Indigo", hex: "#818CF8", meaning: "Fluent in the current moment" },
    { x: -1, y: -1, name: "Electric", hex: "#6366F1", meaning: "Whatever is big this week, they are already in it" },
    { x: -0.33, y: 0.33, name: "Sage", hex: "#86A68A", meaning: "The classics, the popular ones" },
    { x: -0.66, y: 0.66, name: "Olive", hex: "#8F9560", meaning: "Trusts what has already lasted" },
    { x: -1, y: 1, name: "Moss", hex: "#647052", meaning: "The canon, widely shared, well worn" },
  ],
};

const focus: Grid = {
  id: "focus",
  label: "Focus",
  determines: "Shadow",
  axisX: { neg: "Competitive", pos: "Relaxed" },
  axisY: { neg: "Intellectual", pos: "Physical" },
  points: [
    { x: 0, y: 0, name: "Charcoal", hex: "#25253A", meaning: "Trains, thinks, and doesn't keep score" },
    { x: 0.33, y: 0.33, name: "Umber", hex: "#46333A", meaning: "Moves for the pleasure of moving" },
    { x: 0.66, y: 0.66, name: "Rust", hex: "#633B32", meaning: "Long walks, no stopwatch" },
    { x: 1, y: 1, name: "Burnt", hex: "#713C2F", meaning: "The body, unhurried" },
    { x: 0.33, y: -0.33, name: "Bluegrey", hex: "#293B4A", meaning: "Reads widely, races nobody" },
    { x: 0.66, y: -0.66, name: "Navy", hex: "#1F3445", meaning: "Curiosity without a deadline" },
    { x: 1, y: -1, name: "Ink", hex: "#172B3A", meaning: "Thinking is the hobby" },
    { x: -0.33, y: -0.33, name: "Indigo", hex: "#29264A", meaning: "Wants to be right, and first" },
    { x: -0.66, y: -0.66, name: "Plum", hex: "#30203F", meaning: "Keeps score in silence" },
    { x: -1, y: -1, name: "Obsidian", hex: "#21182F", meaning: "Mastery, measured against everyone" },
    { x: -0.33, y: 0.33, name: "Maroon", hex: "#542634", meaning: "Plays to win the match" },
    { x: -0.66, y: 0.66, name: "Burgundy", hex: "#641F32", meaning: "Trains for the scoreboard" },
    { x: -1, y: 1, name: "Crimson", hex: "#681D2B", meaning: "Physical, and there to beat you" },
  ],
};

export const GRIDS: Record<GridId, Grid> = { values, mind, soul, culture, focus };
export const GRID_LIST: Grid[] = [values, mind, soul, culture, focus];

/** Nearest of the 13 named reference points — display only (spec §3.2 note). */
export function nearestPoint(gridId: GridId, p: Point): GridPoint {
  const pts = GRIDS[gridId].points;
  let best = pts[0];
  let bestD = Infinity;
  for (const q of pts) {
    const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = q;
    }
  }
  return best;
}

/** Human-readable quadrant label for a position, e.g. "Emotive · Practical". */
export function orientationOf(gridId: GridId, p: Point): string {
  const g = GRIDS[gridId];
  if (p.x === 0 && p.y === 0) return "Balanced";
  const parts: string[] = [];
  if (p.y !== 0) parts.push(p.y > 0 ? g.axisY.pos : g.axisY.neg);
  if (p.x !== 0) parts.push(p.x > 0 ? g.axisX.pos : g.axisX.neg);
  return parts.join(" · ");
}
