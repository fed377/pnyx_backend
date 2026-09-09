import type {
  Content,
  Conversation,
  GridId,
  HotTake,
  Person,
  Positions,
  Score,
  Scores,
} from "./types";

/* ── Helpers ──────────────────────────────────────────────────────────────── */

/** Grids the model judged irrelevant get a near-central point and low confidence. */
const IRRELEVANT: Score = { x: 0, y: 0, confidence: 0.12 };

type Triple = [x: number, y: number, confidence: number];

function scores(partial: Partial<Record<GridId, Triple>>): Scores {
  const build = (t?: Triple): Score => (t ? { x: t[0], y: t[1], confidence: t[2] } : { ...IRRELEVANT });
  return {
    values: build(partial.values),
    mind: build(partial.mind),
    soul: build(partial.soul),
    culture: build(partial.culture),
    focus: build(partial.focus),
  };
}

function pos(
  values: [number, number],
  mind: [number, number],
  soul: [number, number],
  culture: [number, number],
  focus: [number, number],
): Positions {
  return {
    values: { x: values[0], y: values[1] },
    mind: { x: mind[0], y: mind[1] },
    soul: { x: soul[0], y: soul[1] },
    culture: { x: culture[0], y: culture[1] },
    focus: { x: focus[0], y: focus[1] },
  };
}

const DAY = 86_400_000;
/** Anchored to load time so "4h ago" stays true whenever the prototype is opened. */
const NOW = Date.now();

/* ── The user ─────────────────────────────────────────────────────────────── */

export const ME_ID = "me";

export const ME_DEFAULTS = {
  handle: "federico",
  name: "Federico Villari",
  pronouns: "he/him",
  bio: "Building things in Varese. Mostly here to find out what I actually think.",
  city: "Varese",
};

/* ── People ───────────────────────────────────────────────────────────────── */

export const PEOPLE: Person[] = [
  {
    id: "mara",
    handle: "mara.v",
    name: "Mara Colombo",
    pronouns: "she/her",
    bio: "Architect. Believes a city is judged by its benches.",
    tier: "speaker",
    city: "Varese",
    positions: pos([0.62, 0.28], [0.41, 0.19], [0.36, 0.44], [-0.21, 0.48], [0.34, 0.22]),
    voteCount: 412,
    following: true,
    follower: true,
  },
  {
    id: "tobia",
    handle: "tobia",
    name: "Tobia Ferraris",
    pronouns: "he/him",
    bio: "Physics teacher. Will explain the thing whether or not you asked.",
    tier: "speaker",
    city: "Varese",
    positions: pos([-0.18, -0.44], [0.55, -0.72], [-0.28, -0.31], [0.12, -0.36], [-0.4, -0.62]),
    voteCount: 388,
    following: true,
    follower: true,
  },
  {
    id: "nkechi",
    handle: "nkechi",
    name: "Nkechi Obi",
    pronouns: "she/her",
    bio: "Sound engineer. Loud opinions, quiet mixes.",
    tier: "speaker",
    city: "Milan",
    positions: pos([0.44, -0.58], [-0.36, 0.61], [0.68, 0.72], [0.55, -0.63], [0.28, 0.41]),
    voteCount: 501,
    following: true,
    follower: false,
  },
  {
    id: "dario",
    handle: "dario_p",
    name: "Dario Pellegrini",
    pronouns: "he/him",
    bio: "Runs a bike shop. Anti-car, pro-hill.",
    tier: "speaker",
    city: "Varese",
    positions: pos([0.78, -0.34], [0.66, -0.22], [0.19, 0.28], [-0.44, -0.18], [0.71, 0.66]),
    voteCount: 264,
    following: true,
    follower: true,
  },
  {
    id: "siv",
    handle: "siv",
    name: "Siv Halvorsen",
    pronouns: "they/them",
    bio: "Translator. Reads the footnotes first.",
    tier: "active",
    city: "Oslo",
    positions: pos([-0.52, -0.29], [-0.68, -0.41], [-0.44, -0.55], [0.61, 0.34], [-0.22, -0.7]),
    voteCount: 190,
    following: false,
    follower: true,
  },
  {
    id: "elena",
    handle: "elenam",
    name: "Elena Marchetti",
    pronouns: "she/her",
    bio: "Pastry, mostly. Traditionalist about butter.",
    tier: "speaker",
    city: "Como",
    positions: pos([0.51, 0.66], [0.34, 0.48], [0.42, 0.16], [-0.35, 0.62], [0.44, 0.31]),
    voteCount: 333,
    following: false,
    follower: true,
  },
  {
    id: "rui",
    handle: "rui",
    name: "Rui Tavares",
    pronouns: "he/him",
    bio: "Backend engineer. Ships on Fridays, unapologetically.",
    tier: "active",
    city: "Lisbon",
    positions: pos([-0.31, -0.51], [0.82, -0.55], [-0.36, -0.12], [0.24, -0.55], [-0.58, -0.44]),
    voteCount: 277,
    following: true,
    follower: false,
  },
  {
    id: "bea",
    handle: "bea.q",
    name: "Beatrice Quaglia",
    pronouns: "she/her",
    bio: "Nurse, night shifts. Ask me about coffee at 4am.",
    tier: "active",
    city: "Varese",
    positions: pos([0.84, -0.12], [-0.22, 0.44], [-0.14, 0.33], [-0.52, -0.08], [0.18, 0.52]),
    voteCount: 156,
    following: false,
    follower: true,
  },
  {
    id: "konsta",
    handle: "konsta",
    name: "Konsta Ahonen",
    pronouns: "he/him",
    bio: "Ultrarunner. Talks less than he trains.",
    tier: "private",
    city: "Helsinki",
    positions: pos([-0.66, -0.22], [0.28, -0.61], [-0.72, -0.68], [0.08, -0.3], [-0.61, 0.74]),
    voteCount: 88,
    following: false,
    follower: false,
  },
  {
    id: "yaz",
    handle: "yaz",
    name: "Yasmine Haddad",
    pronouns: "she/her",
    bio: "Curator. Half the canon is admin, the other half is luck.",
    tier: "speaker",
    city: "Milan",
    positions: pos([0.22, -0.66], [-0.55, 0.38], [0.31, 0.55], [0.72, 0.44], [0.12, -0.48]),
    voteCount: 445,
    following: true,
    follower: true,
  },
  {
    id: "pietro",
    handle: "pietro.g",
    name: "Pietro Gallo",
    pronouns: "he/him",
    bio: "Five-a-side twice a week. Keeps score even in friendlies.",
    tier: "active",
    city: "Gallarate",
    positions: pos([0.36, 0.72], [0.61, 0.12], [0.52, -0.38], [-0.66, -0.42], [-0.74, 0.58]),
    voteCount: 121,
    following: false,
    follower: false,
  },
  {
    id: "noor",
    handle: "noor",
    name: "Noor Kaya",
    pronouns: "she/her",
    bio: "Urban planner. The 8-year-old test is the only test.",
    tier: "speaker",
    city: "Rotterdam",
    positions: pos([0.71, -0.55], [0.18, -0.24], [0.24, 0.18], [-0.28, -0.51], [0.36, -0.34]),
    voteCount: 366,
    following: true,
    follower: true,
  },
];

export const PEOPLE_BY_ID: Record<string, Person> = Object.fromEntries(
  PEOPLE.map((p) => [p.id, p]),
);

/* ── Content ──────────────────────────────────────────────────────────────── */

let seq = 0;
const id = () => `c${(++seq).toString().padStart(2, "0")}`;

function split(love: number, like: number, dislike: number, hate: number) {
  return { love, like, dislike, hate };
}

/** Reels — Feed only (spec §6.1: no reels on Home). */
export const REELS: Content[] = [
  {
    id: id(),
    authorId: "noor",
    type: "video",
    text: "A city works if an eight-year-old can cross it alone.",
    context: "Filmed on Via Sacco, 7:40am",
    music: "Colombo — Piazza Loop",
    createdAt: NOW - 2 * DAY,
    scores: scores({ values: [0.72, -0.55, 0.86], culture: [-0.3, -0.45, 0.54], focus: [0.3, -0.2, 0.4] }),
    globalSplit: split(31, 44, 18, 7),
    comments: [
      { id: "k1", authorId: "dario", text: "This is the whole argument, in one sentence.", up: 214, down: 12 },
      { id: "k2", authorId: "pietro", text: "Nice idea until you actually need to get somewhere.", up: 63, down: 88 },
    ],
  },
  {
    id: id(),
    authorId: "tobia",
    type: "video",
    text: "Most productivity advice is anxiety with a spreadsheet attached.",
    context: "Third coffee, second draft",
    createdAt: NOW - 3 * DAY,
    scores: scores({ mind: [-0.35, -0.5, 0.72], focus: [0.45, -0.6, 0.68], soul: [0.3, -0.35, 0.4] }),
    globalSplit: split(22, 51, 20, 7),
    comments: [{ id: "k3", authorId: "rui", text: "My calendar is a coping mechanism and I've made peace with it.", up: 340, down: 9 }],
  },
  {
    id: id(),
    authorId: "yaz",
    type: "video",
    text: "The best work is made under constraints. Total freedom produces mush.",
    createdAt: NOW - 4 * DAY,
    scores: scores({ mind: [-0.5, 0.35, 0.62], culture: [0.6, 0.4, 0.74], focus: [-0.4, -0.45, 0.5] }),
    globalSplit: split(38, 33, 21, 8),
    comments: [
      { id: "k4", authorId: "nkechi", text: "Every good album I've mixed had a deadline and a broken budget.", up: 176, down: 14 },
    ],
  },
  {
    id: id(),
    authorId: "nkechi",
    type: "video",
    text: "Silence in a song is a choice. Most people are just afraid of it.",
    music: "Obi — Room Tone",
    createdAt: NOW - 5 * DAY,
    scores: scores({ mind: [-0.42, 0.55, 0.66], culture: [0.66, -0.2, 0.6], soul: [0.2, -0.4, 0.44] }),
    globalSplit: split(44, 36, 14, 6),
    comments: [{ id: "k5", authorId: "siv", text: "Same is true of translation. And of dinner parties.", up: 91, down: 3 }],
  },
  {
    id: id(),
    authorId: "dario",
    type: "video",
    text: "Nobody actually likes open-plan offices. We just stopped saying it.",
    createdAt: NOW - 5 * DAY,
    scores: scores({ values: [-0.45, -0.3, 0.64], soul: [-0.35, -0.6, 0.58], focus: [0.25, -0.5, 0.36] }),
    globalSplit: split(29, 47, 17, 7),
    comments: [
      { id: "k6", authorId: "bea", text: "Try a ward. Open plan with alarms.", up: 128, down: 6 },
      { id: "k7", authorId: "mara", text: "We design them because they're cheap, not because they work.", up: 205, down: 11 },
    ],
  },
  {
    id: id(),
    authorId: "elena",
    type: "video",
    text: "Learning one dish properly beats knowing forty badly.",
    context: "Fourth attempt at the same tart",
    createdAt: NOW - 6 * DAY,
    scores: scores({ values: [0.3, 0.6, 0.5], culture: [0.35, 0.62, 0.7], focus: [-0.3, 0.3, 0.52] }),
    globalSplit: split(35, 45, 15, 5),
    comments: [{ id: "k8", authorId: "konsta", text: "Same principle as training. Repetition is the shortcut.", up: 84, down: 2 }],
  },
  {
    id: id(),
    authorId: "konsta",
    type: "video",
    text: "Competitive sport at school does more harm than it does good.",
    createdAt: NOW - 7 * DAY,
    scores: scores({ focus: [0.6, 0.55, 0.78], values: [0.4, -0.5, 0.55], soul: [-0.2, -0.3, 0.3] }),
    globalSplit: split(18, 27, 38, 17),
    comments: [
      { id: "k9", authorId: "pietro", text: "Absolutely not. Losing at eleven taught me more than any lesson did.", up: 291, down: 74 },
    ],
  },
  {
    id: id(),
    authorId: "siv",
    type: "video",
    text: "Reading the book after the film is the correct order, actually.",
    createdAt: NOW - 8 * DAY,
    scores: scores({ culture: [0.5, 0.25, 0.6], mind: [-0.55, 0.3, 0.5], soul: [0.35, -0.45, 0.42] }),
    globalSplit: split(21, 34, 32, 13),
    comments: [{ id: "k10", authorId: "yaz", text: "Heresy, and yet.", up: 147, down: 22 }],
  },
  {
    id: id(),
    authorId: "mara",
    type: "video",
    text: "Every apartment block should be required to have one shared room.",
    context: "Cortina courtyard, rebuilt 2019",
    createdAt: NOW - 9 * DAY,
    scores: scores({ values: [0.82, 0.3, 0.8], culture: [-0.35, 0.4, 0.48], focus: [0.35, -0.15, 0.34] }),
    globalSplit: split(33, 42, 18, 7),
    comments: [{ id: "k11", authorId: "noor", text: "The ones that have them have half the turnover. It's measurable.", up: 188, down: 5 }],
  },
  {
    id: id(),
    authorId: "rui",
    type: "video",
    text: "Talent is mostly early exposure wearing a costume.",
    createdAt: NOW - 10 * DAY,
    scores: scores({ mind: [0.4, -0.62, 0.7], values: [0.35, -0.6, 0.56], focus: [-0.45, -0.4, 0.44] }),
    globalSplit: split(27, 43, 22, 8),
    comments: [{ id: "k12", authorId: "tobia", text: "Twenty years of teaching says yes, with an asterisk.", up: 233, down: 18 }],
  },
  {
    id: id(),
    authorId: "bea",
    type: "video",
    text: "Small talk is a skill, and looking down on it is a tell.",
    createdAt: NOW - 11 * DAY,
    scores: scores({ soul: [0.45, 0.68, 0.76], values: [0.6, -0.2, 0.5], mind: [0.3, 0.4, 0.4] }),
    globalSplit: split(30, 41, 21, 8),
    comments: [{ id: "k13", authorId: "siv", text: "It's the load-bearing wall of every workplace.", up: 119, down: 16 }],
  },
  {
    id: id(),
    authorId: "pietro",
    type: "video",
    text: "Keeping score makes the game better. Pretending you don't is worse.",
    createdAt: NOW - 12 * DAY,
    scores: scores({ focus: [-0.75, 0.6, 0.82], soul: [0.3, 0.35, 0.44], values: [-0.3, 0.35, 0.4] }),
    globalSplit: split(24, 38, 26, 12),
    comments: [{ id: "k14", authorId: "konsta", text: "I keep score. I just don't tell anyone.", up: 162, down: 7 }],
  },
  {
    id: id(),
    authorId: "yaz",
    type: "video",
    text: "Museums should be free and open until midnight.",
    createdAt: NOW - 13 * DAY,
    scores: scores({ values: [0.66, -0.35, 0.72], culture: [-0.4, 0.5, 0.64], focus: [0.3, -0.55, 0.46] }),
    globalSplit: split(47, 35, 13, 5),
    comments: [{ id: "k15", authorId: "mara", text: "Midnight is when you'd actually look at anything properly.", up: 254, down: 9 }],
  },
  {
    id: id(),
    authorId: "tobia",
    type: "video",
    text: "Astrology is a personality test with a much better art department.",
    createdAt: NOW - 14 * DAY,
    scores: scores({ mind: [0.35, -0.78, 0.84], soul: [0.55, 0.2, 0.5], culture: [-0.3, -0.4, 0.42] }),
    globalSplit: split(26, 33, 25, 16),
    comments: [
      { id: "k16", authorId: "nkechi", text: "And it works, which is the annoying part.", up: 198, down: 41 },
      { id: "k17", authorId: "bea", text: "Say that to the night shift.", up: 77, down: 12 },
    ],
  },
];

/** Home posts — image and text (spec §6.1). */
export const POSTS: Content[] = [
  {
    id: id(),
    authorId: "mara",
    type: "image",
    text: "A bench facing another bench costs the same as a bench facing a road.",
    context: "Giardini Estensi, this morning",
    createdAt: NOW - 4 * 3_600_000,
    scores: scores({ values: [0.75, 0.2, 0.78], culture: [-0.3, 0.45, 0.5], soul: [0.2, 0.15, 0.3] }),
    globalSplit: split(42, 40, 13, 5),
    comments: [{ id: "p1", authorId: "noor", text: "The cheapest civic intervention there is.", up: 96, down: 2 }],
  },
  {
    id: id(),
    authorId: "rui",
    type: "text",
    text: "If your codebase needs a wiki to explain the folder structure, the folder structure is the bug.",
    createdAt: NOW - 9 * 3_600_000,
    scores: scores({ mind: [0.85, -0.6, 0.8], focus: [-0.4, -0.65, 0.56], culture: [0.3, -0.5, 0.36] }),
    globalSplit: split(35, 44, 15, 6),
    comments: [{ id: "p2", authorId: "tobia", text: "Replace 'codebase' with 'syllabus' and it still holds.", up: 141, down: 4 }],
  },
  {
    id: id(),
    authorId: "elena",
    type: "image",
    text: "Butter, flour, patience. Everything else on the shelf is marketing.",
    context: "Batch 12, still not right",
    createdAt: NOW - 15 * 3_600_000,
    scores: scores({ culture: [-0.25, 0.72, 0.76], values: [0.3, 0.66, 0.6], focus: [0.4, 0.35, 0.44] }),
    globalSplit: split(51, 33, 11, 5),
    comments: [{ id: "p3", authorId: "bea", text: "Batch 12 looked perfect from here.", up: 58, down: 1 }],
  },
  {
    id: id(),
    authorId: "nkechi",
    type: "text",
    text: "Every scene that calls itself underground has a mailing list, a dress code, and a hierarchy. It's just a club with worse lighting.",
    createdAt: NOW - 22 * 3_600_000,
    scores: scores({ culture: [0.7, -0.4, 0.72], soul: [0.4, 0.5, 0.5], values: [-0.35, -0.4, 0.44] }),
    globalSplit: split(29, 38, 22, 11),
    comments: [{ id: "p4", authorId: "yaz", text: "The lighting is the dress code.", up: 173, down: 6 }],
  },
  {
    id: id(),
    authorId: "noor",
    type: "image",
    text: "Four metres of pavement is worth more to a street than forty parking spaces.",
    context: "Rotterdam, Witte de Withstraat",
    createdAt: NOW - 30 * 3_600_000,
    scores: scores({ values: [0.68, -0.6, 0.8], culture: [-0.3, -0.35, 0.44], focus: [0.35, -0.3, 0.4] }),
    globalSplit: split(38, 36, 18, 8),
    comments: [{ id: "p5", authorId: "dario", text: "Say it louder for the comune.", up: 112, down: 15 }],
  },
  {
    id: id(),
    authorId: "siv",
    type: "text",
    text: "Untranslatable words are a myth invented by people who don't want to write a second sentence.",
    createdAt: NOW - 38 * 3_600_000,
    scores: scores({ mind: [-0.62, -0.35, 0.7], culture: [0.55, 0.3, 0.58], soul: [0.3, -0.5, 0.42] }),
    globalSplit: split(31, 37, 21, 11),
    comments: [{ id: "p6", authorId: "yaz", text: "Brutal and correct.", up: 88, down: 7 }],
  },
  {
    id: id(),
    authorId: "dario",
    type: "image",
    text: "The hill doesn't care how much your bike cost.",
    context: "Campo dei Fiori, 1,226m",
    createdAt: NOW - 46 * 3_600_000,
    scores: scores({ focus: [0.5, 0.78, 0.8], values: [-0.3, -0.3, 0.4], soul: [0.35, -0.3, 0.38] }),
    globalSplit: split(46, 39, 10, 5),
    comments: [{ id: "p7", authorId: "konsta", text: "It cares a little. Not as much as the ad says.", up: 134, down: 8 }],
  },
  {
    id: id(),
    authorId: "bea",
    type: "text",
    text: "Being good in a crisis is not a personality trait. It's a rota, a checklist, and eleven people you trust.",
    createdAt: NOW - 55 * 3_600_000,
    scores: scores({ values: [0.86, -0.25, 0.82], mind: [0.6, -0.3, 0.55], focus: [-0.3, -0.2, 0.34] }),
    globalSplit: split(49, 37, 10, 4),
    comments: [{ id: "p8", authorId: "mara", text: "This should be on a wall somewhere.", up: 201, down: 3 }],
  },
  {
    id: id(),
    authorId: "yaz",
    type: "image",
    text: "Half the canon is admin. The other half is who happened to keep the letters.",
    context: "Archive box 44, unopened since 1978",
    createdAt: NOW - 66 * 3_600_000,
    scores: scores({ culture: [0.68, 0.4, 0.76], mind: [-0.5, 0.35, 0.58], values: [0.2, -0.45, 0.4] }),
    globalSplit: split(37, 34, 20, 9),
    comments: [{ id: "p9", authorId: "siv", text: "Survivorship bias with a gift shop.", up: 166, down: 4 }],
  },
  {
    id: id(),
    authorId: "pietro",
    type: "text",
    text: "A friendly is still a match. If you didn't want to win you'd have gone for a walk.",
    createdAt: NOW - 74 * 3_600_000,
    scores: scores({ focus: [-0.78, 0.62, 0.8], soul: [0.4, 0.3, 0.42], values: [-0.25, 0.4, 0.38] }),
    globalSplit: split(22, 35, 28, 15),
    comments: [{ id: "p10", authorId: "dario", text: "The walk is also good though.", up: 97, down: 19 }],
  },
];

export const ALL_CONTENT: Content[] = [...REELS, ...POSTS];
export const CONTENT_BY_ID: Record<string, Content> = Object.fromEntries(
  ALL_CONTENT.map((c) => [c.id, c]),
);

/* ── Hot Takes (ephemeral, Home) ──────────────────────────────────────────── */

export const HOT_TAKES: HotTake[] = [
  { id: "h1", authorId: "dario", text: "Bike lanes painted next to parked cars are a dare, not infrastructure." },
  { id: "h2", authorId: "elena", text: "Panettone is a winter food and August panettone is a scam." },
  { id: "h3", authorId: "nkechi", text: "Live albums are better than studio albums and it isn't close." },
  { id: "h4", authorId: "siv", text: "Subtitles on, always, in every language, including your own." },
  { id: "h5", authorId: "tobia", text: "Homework should end at fourteen." },
  { id: "h6", authorId: "yaz", text: "A gallery with a queue is doing something right." },
];

/* ── Messages ─────────────────────────────────────────────────────────────── */

export const CONVERSATIONS: Conversation[] = [
  {
    id: "m1",
    personId: "mara",
    messages: [
      { id: "m1a", from: "mara", text: "Did you see the bench post? I'm genuinely curious what you'd vote.", at: NOW - 5 * 3_600_000 },
      { id: "m1b", from: "mara", contentId: "c15", vote: 2, at: NOW - 5 * 3_600_000 + 60_000 },
      { id: "m1c", from: ME_ID, text: "Loved it too. The Giardini ones face the path, which is worse.", at: NOW - 4 * 3_600_000 },
      { id: "m1d", from: "mara", text: "Exactly the complaint. Someone chose that.", at: NOW - 3.5 * 3_600_000 },
    ],
  },
  {
    id: "m2",
    personId: "dario",
    messages: [
      { id: "m2a", from: "dario", text: "Sunday, Campo dei Fiori. You're coming.", at: NOW - 26 * 3_600_000 },
      { id: "m2b", from: ME_ID, text: "If it isn't raining.", at: NOW - 25 * 3_600_000 },
      { id: "m2c", from: "dario", contentId: "c21", vote: 2, at: NOW - 24 * 3_600_000 },
      { id: "m2d", from: "dario", text: "It's never raining at the top.", at: NOW - 24 * 3_600_000 + 30_000 },
    ],
  },
  {
    id: "m3",
    personId: "yaz",
    messages: [
      { id: "m3a", from: "yaz", contentId: "c13", vote: 2, at: NOW - 2 * DAY },
      { id: "m3b", from: "yaz", text: "Midnight museums. I'd run one. Would you come?", at: NOW - 2 * DAY + 120_000 },
      { id: "m3c", from: ME_ID, text: "Only if the café stays open too.", at: NOW - 2 * DAY + 3_600_000 },
    ],
  },
  {
    id: "m4",
    personId: "tobia",
    messages: [
      { id: "m4a", from: "tobia", text: "Your Mind position moved a lot this week. What have you been voting on?", at: NOW - 3 * DAY },
      { id: "m4b", from: ME_ID, text: "Mostly disagreeing with you, apparently.", at: NOW - 3 * DAY + 900_000 },
      { id: "m4c", from: "tobia", text: "Good. That's the app working.", at: NOW - 3 * DAY + 1_200_000 },
    ],
  },
];

/* ── Notifications ────────────────────────────────────────────────────────── */

export type Notification = { id: string; personId: string; text: string; at: number };

export const NOTIFICATIONS: Notification[] = [
  { id: "n1", personId: "mara", text: "loved your take on shared rooms", at: NOW - 2 * 3_600_000 },
  { id: "n2", personId: "noor", text: "started following you", at: NOW - 7 * 3_600_000 },
  { id: "n3", personId: "tobia", text: "replied to your comment", at: NOW - 19 * 3_600_000 },
  { id: "n4", personId: "yaz", text: "your alignment with her passed 70%", at: NOW - 2 * DAY },
  { id: "n5", personId: "dario", text: "hated a post you loved", at: NOW - 3 * DAY },
];
