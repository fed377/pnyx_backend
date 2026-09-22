import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Read once at startup, not per-request — these are static pages, not
// user data. Draft content: every [BRACKETED] placeholder needs filling in
// (legal entity name, contact email, DMCA agent, governing law, effective
// date) before this is a real, publishable policy — see each file's own
// placeholders.
const TERMS_HTML = readFileSync(join(__dirname, "legal", "terms.html"), "utf-8");
const PRIVACY_HTML = readFileSync(join(__dirname, "legal", "privacy.html"), "utf-8");
const EULA_HTML = readFileSync(join(__dirname, "legal", "eula.html"), "utf-8");
const DMCA_HTML = readFileSync(join(__dirname, "legal", "dmca.html"), "utf-8");

/** Public, unauthenticated pages — linked from the create-account screen and
 * Settings, neither of which had a real destination before this. */
export function registerLegalRoutes(app: FastifyInstance) {
  app.get("/legal/terms", async (_req, reply) => reply.type("text/html").send(TERMS_HTML));
  app.get("/legal/privacy", async (_req, reply) => reply.type("text/html").send(PRIVACY_HTML));
  app.get("/legal/eula", async (_req, reply) => reply.type("text/html").send(EULA_HTML));
  app.get("/legal/dmca", async (_req, reply) => reply.type("text/html").send(DMCA_HTML));
}
