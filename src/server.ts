import { pathToFileURL } from "node:url";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { assertConfig, config } from "./config";
import { NullMediaStore, SupabaseMediaStore, type MediaStore } from "./media";
import { ExpoPushSender, NullPushSender, type PushSender } from "./push";
import { MemoryRepository } from "./repo/memory";
import { SupabaseRepository } from "./repo/supabase";
import type { Repository } from "./repo/types";
import { registerRoutes } from "./routes";
import { GeminiScorer } from "./scoring/geminiScorer";
import { DeterministicScorer } from "./scoring/scorer";
import type { ContentScorer } from "./scoring/scorer";
import { PnyxService } from "./service";

export function buildServer(
  repo: Repository = new MemoryRepository(),
  media: MediaStore = new NullMediaStore(),
  scorer: ContentScorer = new DeterministicScorer(),
  pushSender: PushSender = new NullPushSender(),
) {
  const app = Fastify({
    // Quiet under vitest: request logging dominates the cost of an inject() call.
    logger: process.env.VITEST ? false : { level: process.env.LOG_LEVEL ?? "info" },
    // Render (and most PaaS hosts) terminate TLS at the edge and forward
    // plain HTTP internally — without this, req.protocol/req.hostname would
    // report the internal "http" hop instead of what the client actually
    // used, which the OAuth bridge page (authRoutes.ts) depends on to build
    // its own callback URL correctly.
    trustProxy: true,
  });
  // Global default: generous enough not to bother real usage, but every route
  // that used to have no ceiling at all (voting, posting, comments, ...) now
  // has one. Auth's own brute-force-sensitive routes get a much tighter
  // per-route limit below.
  //
  // Routes are registered inside a plugin (not directly on `app`) so their
  // `onRoute` notifications fire after rate-limit's own — plain app.get/post
  // calls run synchronously immediately, while app.register() calls (this one
  // included) are queued and boot in call order, so without this wrapping the
  // routes would exist before rate-limit's hook did and never see it at all.
  app.register(rateLimit, { max: 300, timeWindow: "1 minute" });
  app.register(async (instance) => {
    const service = new PnyxService(repo, scorer, media, pushSender);
    registerRoutes(instance, service);
  });
  return app;
}

async function main() {
  assertConfig();

  const repo: Repository =
    config.store === "supabase"
      ? new SupabaseRepository(config.supabaseUrl, config.supabaseServiceKey)
      : new MemoryRepository();

  const media: MediaStore =
    config.store === "supabase"
      ? new SupabaseMediaStore(config.supabaseUrl, config.supabaseServiceKey)
      : new NullMediaStore();

  // Spec §8: real scoring needs a key. Without one we fall back to the deterministic
  // stub rather than refuse to boot, so local dev still works with no AI configured —
  // but the stub is not fit for real users, hence the loud warning below.
  const scorer: ContentScorer = config.geminiApiKey
    ? new GeminiScorer({ apiKey: config.geminiApiKey, model: config.scorerModel })
    : new DeterministicScorer();

  const app = buildServer(repo, media, scorer, new ExpoPushSender());
  await app.register(cors, { origin: true });

  await app.listen({ port: config.port, host: config.host });
  app.log.info({ store: config.store, devAuth: config.devAuth, scorer: scorer.name }, "PNYX API ready");
  if (config.store === "memory") {
    app.log.warn("running on the in-memory store — nothing is persisted");
  }
  if (scorer.name === "deterministic-stub") {
    app.log.warn("GEMINI_API_KEY is not set — posts are scored with the deterministic stub, not AI");
  }
}

// Only start a listener when run directly; tests import buildServer instead.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
