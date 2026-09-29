/**
 * Builds seed-data/manifest.json and the files it points at. Touches no
 * database — review (and edit) the manifest before `npm run seed:load`.
 *
 *   npm run seed:generate                        # every stage, filling in whatever is missing
 *   npm run seed:generate -- --only media,avatars
 *   npm run seed:generate -- --personas 60 --seed 7
 *
 * Stages, in order (each skips what the manifest already has, so it's resumable):
 *   personas  Gemini writes people around hidden positions chosen here, spread across every grid
 *   posts     Gemini writes each speaker's takes (text only — scores come from the real scorer at load)
 *   comments  Gemini writes replies in other personas' voices
 *   media     Pexels photos/videos matching each post's mediaQuery   (needs PEXELS_API_KEY)
 *   audio     mixes a track from seed-data/music/ into each video    (needs ffmpeg)
 *   avatars   DiceBear illustrated avatars                           (no key)
 *
 * Options:
 *   --personas <n>       target persona count (default 50)
 *   --seed <n>           randomness seed for a new manifest (default 1; an existing manifest keeps its own)
 *   --posts-min/-max     takes per speaker (default 4..9, scaled by activity)
 *   --comments-max <n>   replies per post (default 3)
 *
 * Env: GEMINI_API_KEY (personas/posts/comments), PEXELS_API_KEY (media),
 *      SEED_MODEL (defaults to SCORER_MODEL), FFMPEG_PATH (audio; defaults to ffmpeg on PATH).
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ApiError as GenAiApiError, GoogleGenAI, Type, type Schema } from "@google/genai";
import { z } from "zod";
import { MIN_AGE } from "../../src/domain";
import { config } from "../../src/config";
import { totalAlignment } from "../../src/core/algorithm";
import { GRID_IDS } from "../../src/core/grids";
import type { GridId, Positions } from "../../src/core/types";
import {
  argNumber,
  argStages,
  argString,
  checkManifestIntegrity,
  DATA_DIR,
  dataFile,
  describeError,
  describePosition,
  installFetchRetry,
  manifestSchema,
  MANIFEST_PATH,
  mapPool,
  parseArgs,
  rngFor,
  saveManifest,
  shuffle,
  sleep,
  withRetry,
  type Manifest,
  type Persona,
  type Post,
} from "./lib";

const STAGES = ["personas", "posts", "comments", "media", "audio", "avatars"] as const;
type Stage = (typeof STAGES)[number];

const args = parseArgs();
const only = argStages(args);
const runs = (s: Stage) => !only || only.has(s);
const targetPersonas = argNumber(args, "personas", 50);
const postsMin = argNumber(args, "posts-min", 4);
const postsMax = argNumber(args, "posts-max", 9);
const commentsMax = argNumber(args, "comments-max", 3);

/* ── Gemini ────────────────────────────────────────────────────────────────── */

let gemini: GoogleGenAI | null = null;
const model = process.env.SEED_MODEL || config.scorerModel;

const WRITER_BRIEF = `You write realistic, varied people and posts for seeding PNYX, a social app where \
people post short opinion "takes" over a photo or short video, and others react love / like / dislike / hate. \
Every person must read like a real, specific human — not a caricature of their politics or personality. \
Vary ages, genders, backgrounds, countries and cities, jobs, and writing styles (some terse, some wry, \
some earnest; casing and punctuation can be casual). Never use real people's names, real brands as the \
point of a post, or anything that would identify a real private individual. Takes can be spicy and \
unpopular, but never hateful toward a group, violent, sexual, or about illegal activity — every post \
goes through a moderation gate that rejects those.`;

async function generateJson<T>(prompt: string, schema: Schema, parse: (v: unknown) => T): Promise<T> {
  if (!config.geminiApiKey) throw new Error("GEMINI_API_KEY is required for this stage.");
  gemini ??= new GoogleGenAI({ apiKey: config.geminiApiKey });
  const client = gemini;
  return withRetry(
    async () => {
      const res = await client.models.generateContent({
        model,
        contents: prompt,
        config: { systemInstruction: WRITER_BRIEF, responseMimeType: "application/json", responseSchema: schema, temperature: 1 },
      });
      if (!res.text) throw new Error("model returned no output");
      return parse(JSON.parse(res.text));
    },
    // Rate limits and overloads, plus the odd malformed reply — both worth another go.
    (err) => (err instanceof GenAiApiError && [429, 500, 503].includes(err.status)) || err instanceof SyntaxError || err instanceof z.ZodError,
  );
}

const S = {
  str: { type: Type.STRING } as Schema,
  num: { type: Type.NUMBER } as Schema,
  grids: { type: Type.ARRAY, items: { type: Type.STRING, format: "enum", enum: [...GRID_IDS] } } as Schema,
};

/* ── Stage: personas ───────────────────────────────────────────────────────── */

/**
 * Hidden positions are chosen here, not by the model: language models drift
 * to the centre, and a cluster of centrists makes every alignment read 70%.
 * Latin-hypercube per axis guarantees every stretch of every axis is covered.
 */
function spreadPositions(n: number, seed: number, batch: number): Positions[] {
  const rng = rngFor(seed, "positions", batch);
  const axis = () => shuffle([...Array(n).keys()], rng).map((i) => ((i + rng()) / n) * 2 - 1);
  const cols = Object.fromEntries(GRID_IDS.map((g) => [g, { x: axis(), y: axis() }])) as Record<GridId, { x: number[]; y: number[] }>;
  return Array.from({ length: n }, (_, i) =>
    Object.fromEntries(GRID_IDS.map((g) => [g, { x: round2(cols[g].x[i]!), y: round2(cols[g].y[i]!) }])) as Positions,
  );
}
const round2 = (n: number) => Math.round(n * 100) / 100;

const personaReply = z.object({
  people: z.array(
    z.object({
      slot: z.number().int(),
      name: z.string(),
      handle: z.string(),
      pronouns: z.string(),
      bio: z.string(),
      city: z.string(),
      age: z.number(),
      topics: z.array(z.string()),
    }),
  ),
});

const personaSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    people: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          slot: S.num,
          name: S.str,
          handle: S.str,
          pronouns: S.str,
          bio: S.str,
          city: S.str,
          age: S.num,
          topics: { type: Type.ARRAY, items: S.str },
        },
        required: ["slot", "name", "handle", "pronouns", "bio", "city", "age", "topics"],
      },
    },
  },
  required: ["people"],
};

function cleanHandle(raw: string, taken: Set<string>): string {
  let base = raw.toLowerCase().replace(/[^a-z0-9._]/g, "").slice(0, 18);
  if (base.length < 2) base = "pnyx";
  let handle = base;
  for (let n = 2; taken.has(handle); n++) handle = `${base.slice(0, 18 - String(n).length)}${n}`;
  taken.add(handle);
  return handle;
}

async function stagePersonas(m: Manifest) {
  const need = targetPersonas - m.personas.length;
  console.log(`\n── personas (${m.personas.length} → ${targetPersonas})`);
  if (need <= 0) return;

  const batch = m.personas.length; // distinct seed per top-up, so new people don't reuse old positions
  const positions = spreadPositions(need, m.seed, batch);
  const rng = rngFor(m.seed, "persona-traits", batch);
  const tiers: Persona["tier"][] = positions.map(() => {
    const r = rng();
    return r < 0.4 ? "speaker" : r < 0.9 ? "active" : "private";
  });
  const handles = new Set(m.personas.map((p) => p.handle));
  const keys = new Set(m.personas.map((p) => p.key));
  const year = new Date().getUTCFullYear();

  // Batches are independent calls, and left alone the model reaches for the
  // same few names every time (a first full run produced 11 "Vance"s and four
  // identical "Dr. Aris Thorne"s). Everything already used is passed in as an
  // exclusion list, and any collision is sent back for another attempt.
  const firstNames = new Set<string>();
  const surnames = new Set<string>();
  const cities = new Map<string, number>();
  const claim = (name: string, city: string) => {
    const { first, surnameParts } = nameParts(name);
    firstNames.add(first);
    for (const part of surnameParts) surnames.add(part);
    cities.set(cityKey(city), (cities.get(cityKey(city)) ?? 0) + 1);
  };
  const clash = (name: string, city: string): string | null => {
    const { first, surnameParts, titled } = nameParts(name);
    if (titled) return "has a title";
    if (firstNames.has(first)) return `first name "${first}" already used`;
    const taken = surnameParts.find((part) => surnames.has(part));
    if (taken) return `surname "${taken}" already used`;
    if ((cities.get(cityKey(city)) ?? 0) >= MAX_PER_CITY) return `${MAX_PER_CITY} people already live in ${city}`;
    return null;
  };
  for (const p of m.personas) claim(p.name, p.city);

  for (let start = 0; start < need; start += 8) {
    let pending = positions.slice(start, start + 8).map((pos, i) => ({ slot: start + i, pos, tier: tiers[start + i]! }));

    for (let attempt = 1; attempt <= 3 && pending.length > 0; attempt++) {
      const usedCities = [...cities].filter(([, n]) => n >= MAX_PER_CITY).map(([c]) => c);
      const prompt = [
        `Write ${pending.length} people. Each has a hidden position on PNYX's five grids — let it shape who they`,
        `are (job, city, interests, how they write their bio) without ever stating it. Bios: at most 150`,
        `characters, first person or fragmentary, like a real profile. Handles: lowercase letters, digits,`,
        `dots or underscores, 3–18 characters. Age between ${Math.max(MIN_AGE + 2, 18)} and 70. Topics: 3–5 things they'd post about.`,
        "",
        "Names: an ordinary first name and surname, no titles (no Dr., Prof., Sgt., Father). Draw on many",
        "cultures and regions — Latin America, Africa, South and East Asia, the Middle East, Eastern and",
        "Southern Europe as well as the English-speaking world — and pick cities to match, not just the",
        "usual US/UK/Nordic ones. Avoid the stock names language models overuse (Vance, Thorne, Aris, Elara,",
        "Soren, Kael, Lyra, Finch, Sterling and the like).",
        firstNames.size ? `Already taken, do not reuse — first names: ${[...firstNames].join(", ")}.` : "",
        surnames.size ? `Surnames: ${[...surnames].join(", ")}.` : "",
        usedCities.length ? `Cities that are full: ${usedCities.join(", ")}.` : "",
        "",
        ...pending.map((s) => `Slot ${s.slot} (${s.tier === "speaker" ? "posts often" : "mostly reacts, rarely posts"}):\n${describePosition(s.pos)}`),
      ]
        .filter((line, i, all) => line !== "" || all[i - 1] !== "")
        .join("\n");

      const reply = await generateJson(prompt, personaSchema, (v) => personaReply.parse(v));
      const retry: typeof pending = [];
      for (const s of pending) {
        const person = reply.people.find((p) => p.slot === s.slot);
        const problem = !person ? "skipped by the model" : clash(person.name, person.city);
        if (problem || !person) {
          if (attempt === 3) console.log(`  slot ${s.slot}: ${problem} after 3 tries — re-run to fill the gap`);
          retry.push(s);
          continue;
        }
        claim(person.name, person.city);
        addPersona(s, person);
      }
      pending = retry;
    }
    saveManifest(m);
  }

  function addPersona(s: { slot: number; pos: Positions; tier: Persona["tier"] }, person: z.infer<typeof personaReply>["people"][number]) {
    const handle = cleanHandle(person.handle, handles);
    let key = handle.replace(/[._]+/g, "-").replace(/^-+|-+$/g, "") || "persona";
    while (keys.has(key)) key = `${key}-${Math.floor(rng() * 1000)}`;
    keys.add(key);
    const age = Math.min(70, Math.max(18, Math.round(person.age)));
    const month = 1 + Math.floor(rng() * 12);
    const day = 1 + Math.floor(rng() * 28);
    m.personas.push({
      key,
      handle,
      name: person.name.slice(0, 60),
      pronouns: person.pronouns.slice(0, 20),
      bio: person.bio.slice(0, 200),
      city: person.city.slice(0, 60),
      tier: s.tier,
      birthday: `${year - age - 1}-${pad(month)}-${pad(day)}`,
      truePosition: s.pos,
      temperament: { activity: round2(0.3 + rng() * 0.7), volatility: round2(0.1 + rng() * 0.5), harshness: round2(rng()) },
      topics: person.topics.slice(0, 5),
    });
    console.log(`  + ${key.padEnd(24)} ${s.tier.padEnd(8)} ${person.name}, ${person.city}`);
  }
}
const pad = (n: number) => String(n).padStart(2, "0");

const MAX_PER_CITY = 2;
const TITLE = /^(dr|prof|sgt|fr|father|mr|mrs|ms|rev|sir|dame|capt)\.?\s/i;

/** "Dr. Aris Thorne" → { first: "aris", last: "thorne", titled: true }. Hyphenated
 * surnames count each part, so "Lin-Vogel" collides with an existing "Lin". */
function nameParts(name: string): { first: string; surnameParts: string[]; titled: boolean } {
  const titled = TITLE.test(name.trim());
  // Initials ("Zoe K.") don't count as a surname.
  const words = name.trim().replace(TITLE, "").toLowerCase().split(/\s+/).filter((w) => !/^\p{L}\.?$/u.test(w));
  const last = words.length > 1 ? words[words.length - 1]! : "";
  return { first: words[0] ?? "", surnameParts: last ? last.split("-").filter(Boolean) : [], titled };
}

/** "Portland, OR" and "portland" are the same city. */
const cityKey = (city: string) => city.split(",")[0]!.trim().toLowerCase();

/* ── Stage: posts ──────────────────────────────────────────────────────────── */

const postReply = z.object({
  posts: z.array(
    z.object({
      type: z.enum(["image", "video"]),
      text: z.string(),
      context: z.string().optional(),
      categories: z.array(z.enum(["values", "mind", "soul", "culture", "focus"])).optional(),
      mediaQuery: z.string(),
    }),
  ),
});

const postSchemaGemini: Schema = {
  type: Type.OBJECT,
  properties: {
    posts: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          type: { type: Type.STRING, format: "enum", enum: ["image", "video"] },
          text: S.str,
          context: S.str,
          categories: S.grids,
          mediaQuery: S.str,
        },
        required: ["type", "text", "mediaQuery"],
      },
    },
  },
  required: ["posts"],
};

function personaCard(p: Persona) {
  return `${p.name} (@${p.handle}), ${p.city}. Bio: "${p.bio}". Posts about: ${p.topics.join(", ")}.\nHidden position:\n${describePosition(p.truePosition)}`;
}

async function stagePosts(m: Manifest) {
  console.log("\n── posts");
  const authored = new Set(m.posts.map((p) => p.authorKey));
  for (const p of m.personas.filter((x) => x.tier === "speaker" && !authored.has(x.key))) {
    const rng = rngFor(m.seed, "post-count", p.key);
    const n = Math.round(postsMin + (postsMax - postsMin) * (0.5 * p.temperament.activity + 0.5 * rng()));
    const prompt = [
      `Write ${n} posts by this person:`,
      personaCard(p),
      "",
      "Each post is one genuine opinion, observation or hot take in their own voice — something people",
      "could actually love or hate. `text` is the take itself, at most 140 characters, no hashtags.",
      "`context` is optional: a short line (at most 60 characters) like where it was filmed or what",
      "prompted it; omit it about half the time. Cover different topics, not one idea reworded; let their",
      "position show through what they believe, not through labels. About 70% `video`, the rest `image`.",
      "`categories`: the 1–3 grids the take actually touches (values = society/politics, mind = how one",
      "thinks, soul = temperament/humour, culture = taste, focus = ambition vs ease, intellect vs body).",
      "`mediaQuery`: 2–4 concrete, visual words for a stock photo/video search that would sit behind the",
      "take (e.g. \"city tram morning\", \"kitchen pasta hands\") — scenery and objects, no named people.",
    ].join("\n");
    const reply = await generateJson(prompt, postSchemaGemini, (v) => postReply.parse(v));
    reply.posts.slice(0, n).forEach((post, i) => {
      m.posts.push({
        key: `${p.key}-p${i + 1}`,
        authorKey: p.key,
        type: post.type,
        text: post.text.slice(0, 280),
        context: post.context?.trim() ? post.context.slice(0, 80) : undefined,
        categories: post.categories?.length ? [...new Set(post.categories)] : undefined,
        mediaQuery: post.mediaQuery,
      });
    });
    saveManifest(m);
    console.log(`  + ${p.key.padEnd(24)} ${Math.min(n, reply.posts.length)} takes`);
  }
}

/* ── Stage: comments ───────────────────────────────────────────────────────── */

const commentReply = z.object({ replies: z.array(z.object({ slot: z.number().int(), text: z.string() })) });
const commentSchemaGemini: Schema = {
  type: Type.OBJECT,
  properties: {
    replies: {
      type: Type.ARRAY,
      items: { type: Type.OBJECT, properties: { slot: S.num, text: S.str }, required: ["slot", "text"] },
    },
  },
  required: ["replies"],
};

async function stageComments(m: Manifest) {
  console.log("\n── comments");
  const byKey = new Map(m.personas.map((p) => [p.key, p]));
  const hasComments = new Set(m.comments.map((c) => c.postKey));
  const todo = m.posts.filter((post) => !hasComments.has(post.key));

  await mapPool(todo, 3, async (post) => {
    const rng = rngFor(m.seed, "comment-count", post.key);
    const k = Math.floor(rng() * (commentsMax + 1));
    const author = byKey.get(post.authorKey);
    if (k === 0 || !author) return;

    // A mix of people who'd agree and people who'd push back.
    const others = m.personas
      .filter((p) => p.key !== author.key)
      .map((p) => ({ p, pct: totalAlignment(p.truePosition, author.truePosition) }))
      .sort((a, b) => b.pct - a.pct);
    const half = Math.ceil(others.length / 2);
    const pool = [shuffle(others.slice(0, half), rng), shuffle(others.slice(half), rng)];
    const commenters = Array.from({ length: Math.min(k, others.length) }, (_, i) => pool[i % 2]!.shift() ?? pool[(i + 1) % 2]!.shift()!)
      .filter(Boolean)
      .map((o) => o.p);

    const prompt = [
      `A post by ${author.name} (@${author.handle}): "${post.text}"${post.context ? ` — ${post.context}` : ""}`,
      "",
      "Write one reply from each of these people, in their own voice, reacting to the take — agreeing,",
      "pushing back, adding a detail, or joking, as their position suggests. At most 200 characters each,",
      "no hashtags, don't address the author by handle.",
      "",
      ...commenters.map((c, slot) => `Slot ${slot}: ${personaCard(c)}`),
    ].join("\n");
    const reply = await generateJson(prompt, commentSchemaGemini, (v) => commentReply.parse(v));
    commenters.forEach((c, slot) => {
      const text = reply.replies.find((r) => r.slot === slot)?.text.trim();
      if (text) m.comments.push({ key: `${post.key}-c${slot + 1}`, postKey: post.key, authorKey: c.key, text: text.slice(0, 500) });
    });
    saveManifest(m);
    console.log(`  + ${post.key.padEnd(28)} ${commenters.length} replies`);
  });
}

/* ── Stage: media (Pexels) ─────────────────────────────────────────────────── */

const MAX_VIDEO_BYTES = 20 * 1024 * 1024;

class RateLimited extends Error {}

type PexelsVideo = {
  id: number;
  url: string;
  duration: number;
  user: { name: string };
  video_files: { link: string; file_type: string; width: number | null; height: number | null }[];
};
type PexelsPhoto = { id: number; url: string; photographer: string; src: { portrait: string; large: string } };

async function pexels<T>(endpoint: string, params: Record<string, string>): Promise<T> {
  const key = process.env.PEXELS_API_KEY;
  if (!key) throw new Error("PEXELS_API_KEY is required for the media stage (free at pexels.com/api).");
  const res = await fetch(`https://api.pexels.com/${endpoint}?${new URLSearchParams(params)}`, {
    headers: { Authorization: key },
  });
  if (res.status === 429) throw new RateLimited("Pexels rate limit reached (default 200 requests/hour).");
  if (!res.ok) throw new Error(`Pexels ${endpoint} ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

/** Full query, then progressively looser, portrait first. */
function queryVariants(q: string): { query: string; orientation?: string }[] {
  const words = q.trim().split(/\s+/);
  const texts = [...new Set([words.join(" "), words.slice(0, 2).join(" "), words[0]!])];
  return [...texts.map((query) => ({ query, orientation: "portrait" })), { query: texts[0]! }];
}

async function download(url: string, file: string, maxBytes: number): Promise<boolean> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status}: ${url}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > maxBytes) return false;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  return true;
}

async function fetchMedia(post: Post, used: Set<number>): Promise<Post["media"] | null> {
  for (const variant of queryVariants(post.mediaQuery)) {
    const params: Record<string, string> = { query: variant.query, per_page: "20" };
    if (variant.orientation) params.orientation = variant.orientation;

    if (post.type === "video") {
      const res = await pexels<{ videos: PexelsVideo[] }>("videos/search", params);
      for (const v of res.videos) {
        if (used.has(v.id) || v.duration < 4 || v.duration > 25) continue;
        // Largest mp4 whose short side is ≤ 720px — plenty for a phone, small for Storage.
        const file = v.video_files
          .filter((f) => f.file_type === "video/mp4" && f.width && f.height && Math.min(f.width, f.height) <= 720)
          .sort((a, b) => Math.min(b.width!, b.height!) - Math.min(a.width!, a.height!))[0];
        if (!file) continue;
        const rel = `media/${post.key}.mp4`;
        if (!(await download(file.link, dataFile(rel), MAX_VIDEO_BYTES))) continue;
        // A new clip: any kept original belongs to the old one, and the audio stage would mix that instead.
        rmSync(dataFile(`media/${post.key}.orig.mp4`), { force: true });
        used.add(v.id);
        return { file: rel, mimeType: "video/mp4", source: "pexels", sourceId: v.id, sourceUrl: v.url, credit: `${v.user.name} on Pexels` };
      }
    } else {
      const res = await pexels<{ photos: PexelsPhoto[] }>("v1/search", params);
      const photo = res.photos.find((ph) => !used.has(ph.id));
      if (!photo) continue;
      const rel = `media/${post.key}.jpg`;
      await download(photo.src.portrait || photo.src.large, dataFile(rel), MAX_VIDEO_BYTES);
      used.add(photo.id);
      return { file: rel, mimeType: "image/jpeg", source: "pexels", sourceId: photo.id, sourceUrl: photo.url, credit: `${photo.photographer} on Pexels` };
    }
  }
  return null;
}

async function stageMedia(m: Manifest) {
  console.log("\n── media (Pexels)");
  const used = new Set(m.posts.flatMap((p) => (p.media ? [p.media.sourceId] : [])));
  const todo = m.posts.filter((p) => !p.media || !existsSync(dataFile(p.media.file)));
  for (const post of todo) {
    try {
      const media = await fetchMedia(post, used);
      if (!media) {
        console.log(`  ✗ ${post.key}: nothing for "${post.mediaQuery}" — edit its mediaQuery and re-run`);
        continue;
      }
      post.media = media;
      saveManifest(m);
      console.log(`  + ${post.key.padEnd(28)} ${post.type} #${media.sourceId}`);
    } catch (err) {
      if (err instanceof RateLimited) {
        console.log(`  ${err.message} Stopping here; re-run the media stage later to continue.`);
        return;
      }
      throw err;
    }
    await sleep(250);
  }
}

/* ── Stage: audio (ffmpeg) ─────────────────────────────────────────────────── */

/**
 * Stock clips are mostly silent, so each video gets a music track mixed into
 * the file itself — the post's sound is just the video's audio, as it would be
 * for a real upload. Tracks come from seed-data/music/, supplied by you: only
 * put music there whose license allows use in an app, and put attribution in
 * music/credits.json ({ "file.mp3": "Artist — Title (CC BY 4.0)" }) when it's required.
 *
 * The downloaded clip is kept as media/<key>.orig.mp4, so a re-mix (clear the
 * post's `media.audio` and re-run) always starts from the untouched file.
 */
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const MUSIC_EXT = /\.(mp3|m4a|aac|wav|ogg|flac)$/i;
/** Music level, and how much of the clip's own sound (street noise, wind) stays under it. */
const MUSIC_VOLUME = 0.8;
const ORIGINAL_VOLUME = 0.35;

function ffmpeg(args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ["-hide_banner", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err: NodeJS.ErrnoException) =>
      reject(
        err.code === "ENOENT"
          ? new Error(`ffmpeg not found (tried "${FFMPEG}"). Install it (e.g. \`winget install Gyan.FFmpeg\`) or set FFMPEG_PATH.`)
          : err,
      ),
    );
    child.on("close", (code) => resolve({ code: code ?? 1, stderr }));
  });
}

/** Duration and whether there's an audio stream, from ffmpeg's own input banner (no ffprobe needed). */
async function probe(file: string): Promise<{ duration: number; hasAudio: boolean }> {
  // With no output file ffmpeg exits non-zero after printing the input info — expected.
  const { stderr } = await ffmpeg(["-i", file]);
  const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (!d) throw new Error(`could not read duration of ${file}`);
  return {
    duration: Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]),
    hasAudio: /Stream #\d+:\d+.*: Audio:/.test(stderr),
  };
}

async function stageAudio(m: Manifest) {
  console.log("\n── audio (ffmpeg)");
  const musicDir = dataFile("music");
  const tracks = existsSync(musicDir) ? readdirSync(musicDir).filter((f) => MUSIC_EXT.test(f)).sort() : [];
  if (tracks.length === 0) {
    console.log(`  No tracks in ${musicDir} — skipped. Add royalty-free music there and re-run \`--only audio\`.`);
    return;
  }
  const creditsFile = path.join(musicDir, "credits.json");
  const credits: Record<string, string> = existsSync(creditsFile) ? JSON.parse(readFileSync(creditsFile, "utf8")) : {};

  const trackInfo = new Map<string, { duration: number }>();
  const todo = m.posts.filter((p) => p.type === "video" && p.media && !p.media.audio && existsSync(dataFile(p.media.file)));
  for (const post of todo) {
    const media = post.media!;
    const rng = rngFor(m.seed, "track", post.key);
    const track = tracks[Math.floor(rng() * tracks.length)]!;
    const trackPath = path.join(musicDir, track);
    if (!trackInfo.has(track)) trackInfo.set(track, await probe(trackPath));
    const trackDuration = trackInfo.get(track)!.duration;

    const current = dataFile(media.file);
    const original = current.replace(/\.mp4$/, ".orig.mp4");
    if (!existsSync(original)) copyFileSync(current, original);
    const clip = await probe(original);
    const length = clip.duration;

    // Start somewhere inside the track (skipping the very start, often silent),
    // looping it if it's shorter than the clip.
    const loop = trackDuration < length + 1;
    const start = loop ? 0 : round2(Math.min(trackDuration - length - 0.5, 2 + rng() * Math.max(0, trackDuration - length - 2)));
    const fadeOutAt = Math.max(0, length - 1);
    const music =
      `[1:a]atrim=start=${start}:duration=${length},asetpts=PTS-STARTPTS,volume=${MUSIC_VOLUME},` +
      `afade=t=in:d=0.4,afade=t=out:st=${fadeOutAt}:d=1`;
    const filter = clip.hasAudio
      ? // amix halves each input; the trailing volume restores the level.
        `${music}[m];[0:a]volume=${ORIGINAL_VOLUME}[o];[o][m]amix=inputs=2:duration=first,volume=2[a]`
      : `${music}[a]`;

    const tmp = current.replace(/\.mp4$/, ".mixing.mp4");
    const { code, stderr } = await ffmpeg([
      "-y",
      "-i", original,
      ...(loop ? ["-stream_loop", "-1"] : []),
      "-i", trackPath,
      "-filter_complex", filter,
      "-map", "0:v:0",
      "-map", "[a]",
      "-c:v", "copy", // no re-encode: same picture, same quality, fast
      "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "44100",
      "-t", String(length),
      "-movflags", "+faststart", // playable before it's fully downloaded
      tmp,
    ]);
    if (code !== 0) throw new Error(`ffmpeg failed on ${post.key}:\n${stderr.split("\n").slice(-8).join("\n")}`);
    if (statSync(tmp).size > MAX_VIDEO_BYTES) {
      rmSync(tmp, { force: true });
      console.log(`  ✗ ${post.key}: mixed file over ${MAX_VIDEO_BYTES / 1024 / 1024}MB, left silent`);
      continue;
    }
    renameSync(tmp, current);
    media.audio = { track: `music/${track}`, start, ...(credits[track] ? { credit: credits[track] } : {}) };
    saveManifest(m);
    console.log(`  + ${post.key.padEnd(28)} ${track} @${start}s${clip.hasAudio ? " (over original sound)" : ""}`);
  }
}

/* ── Stage: avatars (DiceBear) ─────────────────────────────────────────────── */

async function stageAvatars(m: Manifest) {
  console.log("\n── avatars (DiceBear)");
  for (const p of m.personas) {
    if (p.avatar && existsSync(dataFile(p.avatar.file))) continue;
    const rel = `avatars/${p.key}.png`;
    const url =
      `https://api.dicebear.com/9.x/notionists/png?size=256&seed=${encodeURIComponent(p.key)}` +
      "&backgroundColor=b6e3f4,c0aede,d1d4f9,ffd5dc,ffdfbf";
    await download(url, dataFile(rel), 2 * 1024 * 1024);
    p.avatar = { file: rel, mimeType: "image/png" };
    saveManifest(m);
    console.log(`  + ${p.key}`);
  }
}

/* ── Main ──────────────────────────────────────────────────────────────────── */

async function main() {
  if (only) {
    const unknown = [...only].filter((s) => !(STAGES as readonly string[]).includes(s));
    if (unknown.length) throw new Error(`Unknown stage(s): ${unknown.join(", ")}. Stages: ${STAGES.join(", ")}`);
  }

  mkdirSync(DATA_DIR, { recursive: true });
  const m: Manifest = existsSync(MANIFEST_PATH)
    ? manifestSchema.parse(JSON.parse(readFileSync(MANIFEST_PATH, "utf8")))
    : { version: 1, seed: argNumber(args, "seed", 1), personas: [], posts: [], comments: [] };
  if (argString(args, "seed") && existsSync(MANIFEST_PATH)) {
    console.log(`Note: --seed ignored, the existing manifest keeps seed ${m.seed}.`);
  }
  console.log(`Manifest ${MANIFEST_PATH} (seed ${m.seed}, model ${model})`);

  if (runs("personas")) await stagePersonas(m);
  if (runs("posts")) await stagePosts(m);
  if (runs("comments")) await stageComments(m);
  if (runs("media")) await stageMedia(m);
  if (runs("audio")) await stageAudio(m);
  if (runs("avatars")) await stageAvatars(m);

  checkManifestIntegrity(m);
  saveManifest(m);
  const missing = m.posts.filter((p) => !p.media).length;
  console.log(
    `\n${m.personas.length} personas, ${m.posts.length} posts (${missing} still without media), ${m.comments.length} comments.` +
      "\nReview seed-data/manifest.json, then: npm run seed:load -- --dry-run",
  );
}

installFetchRetry();

main().catch((err) => {
  console.error("\nSeed generate failed:", describeError(err));
  process.exit(1);
});
