import { pathToFileURL } from "node:url";
import cors from "@fastify/cors";
import Fastify from "fastify";
import { assertConfig, config } from "./config";
import { NullMediaStore, SupabaseMediaStore, type MediaStore } from "./media";
import { MemoryRepository } from "./repo/memory";
import { SupabaseRepository } from "./repo/supabase";
import type { Repository } from "./repo/types";
import { registerRoutes } from "./routes";
import { DeterministicScorer } from "./scoring/scorer";
import { PnyxService } from "./service";

export function buildServer(
  repo: Repository = new MemoryRepository(),
  media: MediaStore = new NullMediaStore(),
) {
  // Quiet under vitest: request logging dominates the cost of an inject() call.
  const app = Fastify({
    logger: process.env.VITEST ? false : { level: process.env.LOG_LEVEL ?? "info" },
  });
  const service = new PnyxService(repo, new DeterministicScorer(), media);
  registerRoutes(app, service);
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

  const app = buildServer(repo, media);
  await app.register(cors, { origin: true });

  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    { store: config.store, devAuth: config.devAuth, scorer: "deterministic-stub" },
    "PNYX API ready",
  );
  if (config.store === "memory") {
    app.log.warn("running on the in-memory store — nothing is persisted");
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
