# PNYX — backend

The API that owns the algorithm. Node 20+, TypeScript, Fastify, Supabase (hosted Postgres,
Auth and Storage). Spec §4 (algorithm), §7 (data model) and §8 (scoring pipeline).

```bash
cd pnyx-backend
npm install
cp .env.example .env
npm run dev          # http://127.0.0.1:4000
npm test             # 22 tests
npm run build        # type check
npm run core:check   # verify the shared algorithm hasn't drifted from the app
```

Out of the box it runs on an **in-memory store** seeded with the sample people and posts, so
you can exercise the whole thing before creating a Supabase project. Nothing is persisted.

```bash
curl localhost:4000/health
curl -H "Authorization: Bearer dev:me" localhost:4000/me
curl -X POST localhost:4000/votes -H "Authorization: Bearer dev:me" \
     -H "Content-Type: application/json" -d '{"contentId":"c01","power":2}'
```

## The one rule this service exists to enforce

**Grid positions are derived, never submitted.** There is no endpoint that accepts a position,
and no RLS policy that lets a user write `grid_positions` — only this process, holding the
service-role key, may write that table. Every vote triggers a replay of the decay window from
the origin:

```
P[G,n] = P[G,0] + Σ (q_i · C_i · D_i)/10 · (r_[G,i] − P[G,i−1])      D_i = 0.99^age
```

Votes older than the point where `D < 0.081` fall out of the window, capping the effective
sample at ~250 votes. Each vote stores the AI scores as they were at cast time, so a window can
be replayed exactly even if the content is re-scored later (spec §7).

If you change one thing in this repo, don't change that.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | no auth |
| GET | `/me` | profile, positions, unlock state, named type |
| PATCH | `/me` | name, handle, pronouns, bio, city, privacy tier, per-grid visibility |
| DELETE | `/me` | Right to Be Forgotten (spec §6.5) |
| POST | `/votes` | `{contentId, power}` with power ∈ {2, 1, −1, −2}; returns the new positions |
| GET | `/feed/reels` | ranked reels, your own included (the client disables voting) |
| GET | `/home` | image and text posts, people you follow first |
| GET | `/people` | the most-aligned people, ranked |
| GET | `/people/:id` | a profile as you're allowed to see it, plus alignment |
| PUT/DELETE | `/follows/:id` | follow / unfollow |
| POST | `/content/upload-url` | Speaker-gated signed upload URL for one file |
| POST | `/content` | Speaker-gated; attaches the upload, scores it, queues moderation |

## Layout

```
src/
  core/          the algorithm — shared verbatim with the app (see below)
  repo/          Repository interface + memory and Supabase implementations
  scoring/       ContentScorer interface + the placeholder scorer
  service.ts     domain logic: voting, alignment, feeds, contribute, GDPR
  routes.ts      HTTP surface, zod-validated
  auth.ts        Supabase JWT verification (+ dev tokens)
supabase/
  migrations/    schema, RLS policies, triggers, RPCs
```

### The shared core

`src/core/` is a copy of the app's `pnyx-native/src/lib/` — the grid tables, movement equation,
decay, alignment and recommendation ranking. Both sides run the *same* code so the number the
phone draws and the number the server stores cannot disagree.

It is a copy, not a package, which means it can drift. `npm run core:check` hashes both sides
and fails if they differ. Run it in CI. Promoting it to a shared workspace package is the right
fix once there's a reason to restructure the repos.

## Connecting Supabase

1. **Create a project** at supabase.com. Note the region — put it near your users, not near you.

2. **Apply the schema.** Either paste `supabase/migrations/0001_init.sql` into the SQL editor
   (Dashboard → SQL Editor → New query → Run), or use the CLI against the hosted project:

   ```bash
   npm i -g supabase
   supabase login
   supabase link --project-ref <project-ref>
   supabase db push
   ```

   Supabase's *local* stack needs Docker; pushing to a hosted project does not.

3. **Copy your keys** from Dashboard → Project Settings → API into `.env`:

   ```
   STORE=supabase
   DEV_AUTH=false
   SUPABASE_URL=https://<project-ref>.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=<service_role key>
   ```

   Use the **service_role** key, not the anon key — this process is the trusted writer of
   `grid_positions`. It bypasses RLS by design and must never ship to a client or a repo.

   `DEV_AUTH` must be `false`. With it on, `Bearer dev:<userId>` lets any caller act as any
   user; `config.ts` refuses to start if you combine that with a real database.

4. **Seed some content** so there's something to vote on:

   ```bash
   npm run seed
   ```

   Creates the sample people as real auth users and inserts their posts, pre-approved.
   Development only — it writes fixture grid positions that are not derived from votes.

5. **Start it:** `npm run dev`, then check `curl localhost:4000/health`.

### What the schema sets up for you

- A trigger on `auth.users` creates the `profiles` and `grid_positions` rows the moment someone
  signs up, deriving a unique handle from their email. Without it a new account has no profile
  and every call 404s.
- RLS policies on every table, written for the case where the *app* talks to Supabase directly
  with a user token. Note there is deliberately no write policy on `grid_positions`.
- A `forget_me(uuid)` function that deletes the auth user and cascades through every table.
- `adjust_tallies(...)` so two concurrent voters can't clobber each other's counts.

### Storage

Media lives in a public Supabase Storage bucket called `content`, 50MB per file, limited to
jpeg/png/webp/heic and mp4/mov. Create it once:

```
Dashboard -> Storage -> New bucket -> name "content", Public, 50MB
```

Uploads are **not** proxied through this process. `POST /content/upload-url` returns a signed
URL and the app PUTs the bytes straight to Supabase; the API only sees the resulting path.
Objects are written under `u/<userId>/…` and `POST /content` refuses a path that does not
belong to the caller, or one where nothing was actually uploaded.

Text-only posts can no longer be created (`type` must be `image` or `video`, and `mediaPath`
is required). Existing text rows still serve — the DB enum is unchanged.

### Auth in the app

The client signs in with `@supabase/supabase-js` and sends the resulting access token as
`Authorization: Bearer <token>`. This API verifies it against Supabase Auth on every request
(`src/auth.ts`) and trusts nothing else about the caller's identity.

## What is deliberately not real yet

1. **The scorer falls back to a placeholder if `GEMINI_API_KEY` is unset.** `GeminiScorer`
   (`src/scoring/geminiScorer.ts`) is a real implementation on `@google/genai` — it both places a
   post on the five grids and doubles as the moderation gate (spec §8), and `server.ts` wires it
   up whenever a key is configured. Without one, `DeterministicScorer` hashes text into
   coordinates instead: not a model, positions carry no meaning, logs a warning on boot but
   doesn't refuse to start. Fine for local dev with nothing configured; not fit for real users.

2. **Moderation has no *manual* route yet.** The scorer call inside `createContent` already
   *is* the moderation gate — it throws before insertion on `policy_violation`/`low_effort`, so
   anything that reaches the DB has already been screened and is marked `approved` immediately.
   `service.moderate()`/`setModerationStatus` exist for a future manual takedown/appeal surface
   (there's no admin role in the auth model yet to expose it to), but ordinary posting no longer
   depends on it.

3. **`mostAligned` is linear** over the user base. Fine for a Varese-sized pilot, needs the
   `alignments` cache table (already in the schema) or a spatial index before a real population.

4. **Tier changes aren't rate-limited.** Spec §6.5 says one change per period but leaves the
   period TBD; `profiles.tier_changed_at` is there to hold the rule once you pick a number.

5. **Messages, notifications and Hot Takes are real now**, not stubs — `POST/GET` routes exist
   for all three (`routes.ts`) and the app reads live data for them in remote mode.

6. **Alignment normalisation** uses distance over the grid maximum (2√2) rather than "normalised
   to each user's own vote-count scale" (§4.4), which isn't specified precisely enough to build.

7. **No rate limiting beyond auth's own brute-force guard.** `@fastify/rate-limit` applies a
   300 req/min default everywhere and a 10 req/min guard on signup/signin/google-token/
   forgot-password — reasonable defaults, not tuned against real traffic.

8. **Right to Be Forgotten now deletes uploaded media too** (`MediaStore.deleteAll`), not just
   the DB rows — the Postgres `forget_me()` function only ever handled the latter.

## Tests

`npm test` covers the parts that must not break: that a vote moves the voter and the movement is
persisted, that love moves further than like and dislike moves *away*, that re-voting replaces
rather than stacks, that you cannot vote on your own post or on unmoderated content, that the
type unlocks at exactly 50, that alignment is 100% with yourself and symmetric between two
people, that private grids are withheld while the total still scores, that only Speakers can
post, that Forget Me erases everything, and that no route exists which would let a client write
its own position.
