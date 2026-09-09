import type { FastifyInstance } from "fastify";
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

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof z.ZodError) {
      return reply.code(400).send({ error: "invalid request", issues: err.issues });
    }
    app.log.error({ err }, "unhandled error");
    return reply.code(500).send({ error: "internal error" });
  });
}
