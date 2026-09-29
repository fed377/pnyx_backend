# Seed pipeline

Fills a Supabase project with persona accounts that behave like real users. They post through the
real Gemini scorer and moderation gate, and they vote through `PnyxService.castVote`, so their grid
positions are **derived by the vote replay, never written**. This replaces `scripts/seed-supabase.ts`,
which writes fixture positions and made-up tallies directly (kept for now, see the end).

```
generate.ts  →  seed-data/manifest.json + media/ + avatars/     (no database; review this)
load.ts      →  replays the manifest through PnyxService         (resumable, per-project state file)
clean.ts     →  deletes every seed account via forgetMe          (dry run unless --yes)
simulation.ts   vote / follow / timeline model (pure, tested in test/seedSimulation.test.ts)
```

`seed-data/` is gitignored.

## One-time setup

1. Apply `supabase/migrations/0015_seed_accounts.sql`. It adds `profiles.is_seed`, makes it
   service-role-only like `privacy_tier`, and adds the `seed_apply_timeline` RPC (service-role only).
2. In `.env`: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`, and `PEXELS_API_KEY`
   (free at pexels.com/api) for the media stage.
3. For sound on videos: install ffmpeg (`winget install Gyan.FFmpeg`, or set `FFMPEG_PATH`) and put
   music files (`.mp3 .m4a .aac .wav .ogg .flac`) in `seed-data/music/`.

## Audio

Pexels clips are mostly silent. The `audio` stage mixes a track from `seed-data/music/` **into the video
file itself**, so the post's sound is simply the video's audio track, the same as a real upload, and
nothing in the database or the app knows the difference. A clip's own ambient sound, if it has any,
stays underneath at low volume. The video picture isn't re-encoded, only the audio.

- **You supply the music.** Only use tracks whose license allows use in an app, such as your own,
  CC0, CC BY, or a royalty-free library that permits it. If attribution is required, add
  `seed-data/music/credits.json` (`{ "file.mp3": "Artist — Title (CC BY 4.0)" }`). The credit is
  recorded on each post's `media.audio` in the manifest.
- Each video gets a track picked at random (the same pick every run), starting at a random point,
  with a short fade in and out. The track loops if it's shorter than the clip.
- The untouched download is kept as `media/<key>.orig.mp4`. To re-mix a post, delete its
  `media.audio` from the manifest and run `npm run seed:generate -- --only audio`.
- The music is part of what Gemini hears when it scores a post, just as it would be for a real user's
  video.
- With no tracks in `seed-data/music/`, the stage prints a note and the videos stay silent.

## First run: the 5-persona example

Proves the pipeline end to end before you pay for any generation.

```bash
mkdir -p seed-data && cp scripts/seed/manifest.example.json seed-data/manifest.json
npm run seed:generate -- --only media,audio,avatars   # Pexels + ffmpeg + DiceBear, no Gemini
npm run seed:load -- --dry-run
npm run seed:load -- --target <project-ref>       # ideally a Supabase branch, not prod
npm run seed:clean -- --target <project-ref>      # see what would go
npm run seed:clean -- --target <project-ref> --yes
```

With only 15 posts nobody reaches `UNLOCK_AT` (50 votes), and the dry run says so. That's expected.

## Full run

```bash
rm -rf seed-data                                   # or keep it and just top up
npm run seed:generate -- --personas 50             # ~20 speakers × 4–9 takes ≈ 120 posts
#   → review / edit seed-data/manifest.json
npm run seed:load -- --dry-run
npm run seed:load -- --target <project-ref>
```

Every stage in both scripts skips work it has already done, so re-run after any failure. Stages can
be run on their own with `--only`:

- generate: `personas posts comments media audio avatars`
- load: `accounts avatars posts votes follows comments timeline tidy report`

## What load does, stage by stage

| Stage | Through | Notes |
|---|---|---|
| accounts | `auth.admin.createUser` + profile update | Email `<key>@seed.pnyx.local`, `is_seed = true`, `onboarded`, birthday. The handle comes from the signup trigger (it adds a suffix if the handle is taken). `grid_positions` is not touched. |
| avatars | `createUploadTicket` → PUT → `service.updateProfile` | Goes through the own-media check on `avatarUrl`. |
| posts | `createUploadTicket` → PUT → `service.createContent` | Real Gemini scoring and moderation, one post at a time, retried on 503. A 422 is recorded as `rejected` in the state file with its reason, never retried. |
| votes | `service.castVote` | See the vote model below. Personas run in parallel (`--concurrency`, default 6); each persona's votes run one after another, because `recomputePositions` reads the previous votes. |
| follows | `service.setFollow` | Mostly the most-aligned people (by hidden position), plus the odd random one. Private profiles are never followed. |
| comments | `service.addComment`, `service.voteComment` | A voter agrees with probability equal to their alignment with the commenter. |
| timeline | `seed_apply_timeline` RPC | Spreads posts, votes, comments and join dates over `--span-days` (default 30). Keeps each persona's votes in the order they were cast. |
| tidy | direct deletes | Removes notifications to or from seed accounts, plus strikes from rejected posts. |
| report | read only | Per persona: votes, unlocked, how close the derived position is to the hidden one, and a **replay check**. |

## Vote model (`simulation.ts`)

Each persona has a hidden `truePosition` that only the simulator reads. For each post it computes
`affinity(truePosition, post.scores)`, the same measure the feed ranker uses. It then standardises
that across all the posts the persona can see and adds noise scaled by `temperament.volatility`.
Fixed cut-offs turn that into love / like / dislike / hate (about 25/45/22/8), shifted by
`temperament.harshness`. `temperament.activity` sets how many posts it votes on, and the floor is
`UNLOCK_AT + 10`. Votes are cast oldest-post-first.

The report's **true↔derived** column shows how far real votes pulled each persona toward its hidden
position. A low number is not a seeding bug. It says something about how much the available posts
can move someone, which is worth knowing about the algorithm itself.

## Why the timeline can't corrupt positions

`recomputePositions` orders votes by `created_at`, and the decay is by position in that order
(`decayFor(age)`), not by time. The timeline gives each persona strictly increasing times in cast
order, so the order is unchanged and so are the stored positions. The report checks this after every
run: it replays each persona's votes and compares the result with `grid_positions`. On any mismatch
it prints `REPLAY MISMATCH` and exits non-zero.

## Things to know

- **Cost and limits:** about 1 Gemini call per post to score it, plus roughly 7 persona calls,
  ~20 post calls and ~120 comment calls to generate. Pexels allows 200 requests/hour by default. The
  media stage stops cleanly when it hits the limit; re-run it later.
- **Load time:** each vote is about 6–8 database round trips (vote, tallies, replay, notification,
  alignment checks). 50 personas × ~90 votes takes roughly 10–15 minutes at the default concurrency.
- **Rejected posts leave their uploaded file** in Storage under the persona's folder. `clean.ts`
  removes it with the account.
- **Cleaning deletes real users' votes on seed posts** (they cascade with the content). Those users'
  positions are recomputed on their next vote.
- **Legacy seed:** accounts made by `scripts/seed-supabase.ts` (`@pnyx.local`, no `is_seed`) are
  ignored by `clean.ts`. Delete them by hand if you move to this pipeline.
