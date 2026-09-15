import type { FastifyError, FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "./auth";
import { registerAuthRoutes } from "./authRoutes";
import { UNLOCK_AT } from "./core/algorithm";
import type { VotePower } from "./core/types";
import { ApiError } from "./domain";
import type { PnyxService } from "./service";

const votePower = z.union([z.literal(2), z.literal(1), z.literal(-1), z.literal(-2)]);
const gridId = z.enum(["values", "mind", "soul", "culture", "focus"]);

const castVoteBody = z.object({
  contentId: z.string().min(1),
  power: votePower,
});

const profilePatch = z.object({
  name: z.string().min(1).max(80).optional(),
  handle: z.string().min(2).max(30).regex(/^[a-z0-9._]+$/i).optional(),
  pronouns: z.string().max(40).optional(),
  bio: z.string().max(400).optional(),
  city: z.string().max(80).optional(),
  avatarUrl: z.string().url().max(500).optional(),
  privacyTier: z.enum(["speaker", "active", "private"]).optional(),
  gridPublic: z
    .object({
      values: z.boolean(),
      mind: z.boolean(),
      soul: z.boolean(),
      culture: z.boolean(),
      focus: z.boolean(),
    })
    .optional(),
  // One-way completion flag, set once by completeOnboarding() — see the
  // ProfileRow field's own comment for why this lives server-side at all.
  onboarded: z.boolean().optional(),
});

// Text-only posts can no longer be created: every new post carries media.
const newContent = z.object({
  type: z.enum(["image", "video"]),
  body: z.string().min(8).max(220),
  categories: z.array(gridId).min(1).max(5),
  mediaPath: z.string().min(1).max(300),
  mediaType: z.string().min(3).max(100),
  context: z.string().max(120).optional(),
  music: z.string().max(120).optional(),
});

const uploadRequest = z.object({ contentType: z.string().min(3).max(100) });

const newComment = z.object({ body: z.string().min(1).max(500) });
const commentVote = z.object({ power: z.union([z.literal(1), z.literal(-1)]) });

const newHotTake = z.object({ category: gridId, body: z.string().min(1).max(220) });

const newMessage = z
  .object({
    body: z.string().min(1).max(2000).optional(),
    contentId: z.string().min(1).optional(),
    votePower: votePower.optional(),
  })
  .refine((v) => v.body !== undefined || v.contentId !== undefined, {
    message: "a message needs text or a forwarded post",
  });

export function registerRoutes(app: FastifyInstance, service: PnyxService) {
  app.get("/health", async () => ({ ok: true, unlockAt: UNLOCK_AT }));

  registerAuthRoutes(app);

  /* ── Me ───────────────────────────────────────────────────────────────── */

  app.get("/me", async (req) => service.me(await requireUser(req)));

  app.patch("/me", async (req) => {
    const userId = await requireUser(req);
    const patch = profilePatch.parse(req.body);
    return service.updateProfile(userId, patch);
  });

  app.get("/me/votes", async (req) => {
    const userId = await requireUser(req);
    return { items: await service.myVotes(userId) };
  });

  /** Spec §6.5: Right to Be Forgotten. */
  app.delete("/me", async (req, reply) => {
    const userId = await requireUser(req);
    await service.forgetMe(userId);
    return reply.code(204).send();
  });

  /* ── Voting ───────────────────────────────────────────────────────────── */

  app.post("/votes", async (req) => {
    const userId = await requireUser(req);
    const { contentId, power } = castVoteBody.parse(req.body);
    return service.castVote(userId, contentId, power as VotePower);
  });

  /* ── Feeds ────────────────────────────────────────────────────────────── */

  app.get("/feed/reels", async (req) => {
    const userId = await requireUser(req);
    const { limit } = z.object({ limit: z.coerce.number().min(1).max(100).default(30) }).parse(req.query);
    return { items: await service.reels(userId, limit) };
  });

  app.get("/home", async (req) => {
    const userId = await requireUser(req);
    const { limit } = z.object({ limit: z.coerce.number().min(1).max(100).default(40) }).parse(req.query);
    return { items: await service.home(userId, limit) };
  });

  /* ── People ───────────────────────────────────────────────────────────── */

  app.get("/people", async (req) => {
    const userId = await requireUser(req);
    const { limit } = z.object({ limit: z.coerce.number().min(1).max(50).default(10) }).parse(req.query);
    return { items: await service.mostAligned(userId, limit) };
  });

  app.get("/people/:id", async (req) => {
    const userId = await requireUser(req);
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    return service.viewProfile(userId, id);
  });

  app.put("/follows/:id", async (req) => {
    const userId = await requireUser(req);
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    await service.setFollow(userId, id, true);
    return { following: true };
  });

  app.delete("/follows/:id", async (req) => {
    const userId = await requireUser(req);
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    await service.setFollow(userId, id, false);
    return { following: false };
  });

  /* ── Contribute ───────────────────────────────────────────────────────── */

  /** Step one of posting: a signed URL the app PUTs the file straight to. */
  app.post("/content/upload-url", async (req) => {
    const userId = await requireUser(req);
    const { contentType } = uploadRequest.parse(req.body);
    return service.createUploadTicket(userId, contentType);
  });

  app.post("/content", async (req, reply) => {
    const userId = await requireUser(req);
    const input = newContent.parse(req.body);
    const row = await service.createContent(userId, input);
    return reply.code(201).send(row);
  });

  /* ── Messages ─────────────────────────────────────────────────────────── */

  app.get("/conversations", async (req) => {
    const userId = await requireUser(req);
    return { items: await service.listConversations(userId) };
  });

  /** Opens (or starts) the 1:1 thread with `:id` and returns its history. */
  app.get("/conversations/with/:id", async (req) => {
    const userId = await requireUser(req);
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    return service.openConversation(userId, id);
  });

  app.get("/conversations/:id/messages", async (req) => {
    const userId = await requireUser(req);
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    return { items: await service.listMessages(userId, id) };
  });

  app.post("/conversations/:id/messages", async (req, reply) => {
    const userId = await requireUser(req);
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const input = newMessage.parse(req.body);
    const message = await service.sendMessage(userId, id, input);
    return reply.code(201).send(message);
  });

  /* ── Hot takes ────────────────────────────────────────────────────────── */

  app.get("/hot-takes", async (req) => {
    await requireUser(req);
    const { limit } = z.object({ limit: z.coerce.number().min(1).max(100).default(30) }).parse(req.query);
    return { items: await service.hotTakes(limit) };
  });

  app.post("/hot-takes", async (req, reply) => {
    const userId = await requireUser(req);
    const { category, body } = newHotTake.parse(req.body);
    const take = await service.postHotTake(userId, category, body);
    return reply.code(201).send(take);
  });

  /* ── Notifications ────────────────────────────────────────────────────── */

  app.get("/notifications", async (req) => {
    const userId = await requireUser(req);
    const { limit } = z.object({ limit: z.coerce.number().min(1).max(100).default(50) }).parse(req.query);
    return { items: await service.listNotifications(userId, limit) };
  });

  /* ── Comments ─────────────────────────────────────────────────────────── */

  app.get("/content/:id/comments", async (req) => {
    const userId = await requireUser(req);
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    return { items: await service.listComments(userId, id) };
  });

  app.post("/content/:id/comments", async (req, reply) => {
    const userId = await requireUser(req);
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const { body } = newComment.parse(req.body);
    const comment = await service.addComment(userId, id, body);
    return reply.code(201).send(comment);
  });

  app.post("/comments/:id/vote", async (req) => {
    const userId = await requireUser(req);
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const { power } = commentVote.parse(req.body);
    return service.voteComment(userId, id, power);
  });

  app.setErrorHandler((err: FastifyError | ApiError, _req, reply) => {
    if (err instanceof ApiError) return reply.code(err.status).send({ error: err.message, ...err.details });
    if (err instanceof z.ZodError) {
      return reply.code(400).send({ error: "invalid request", issues: err.issues });
    }
    // @fastify/rate-limit (and other Fastify-native errors) already carry
    // their own correct status — 429 with a Retry-After, mainly — so pass
    // those straight through instead of flattening every non-ApiError into
    // an opaque 500.
    if (typeof err.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    app.log.error({ err }, "unhandled error");
    return reply.code(500).send({ error: "internal error" });
  });
}
