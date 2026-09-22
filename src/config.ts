import "dotenv/config";

const bool = (v: string | undefined, fallback: boolean) =>
  v === undefined ? fallback : v === "1" || v.toLowerCase() === "true";

export const config = {
  port: Number(process.env.PORT ?? 4000),
  host: process.env.HOST ?? "127.0.0.1",

  /** "memory" runs the whole API with no database, seeded from the spec's sample data. */
  store: (process.env.STORE ?? "memory") as "memory" | "supabase",

  supabaseUrl: process.env.SUPABASE_URL ?? "",
  /** Server-side only. Bypasses RLS, so it must never reach a client. */
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",

  /**
   * Browser origins allowed to call this API cross-origin (comma-separated).
   * The native app's own requests aren't subject to CORS at all — this only
   * matters if a browser-based client ever exists. Empty means none: no
   * known web client exists yet, so the safe default is to deny rather than
   * reflect every origin.
   */
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  /** Spec §8 content scoring. Without it the server falls back to the deterministic stub. */
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  scorerModel: process.env.SCORER_MODEL ?? "gemini-2.5-flash-lite",

  /** Outbound transactional email via Resend (https://resend.com/api-keys). */
  resendApiKey: process.env.RESEND_API_KEY ?? "",
  emailFrom: process.env.EMAIL_FROM ?? "Pnyx <onboarding@resend.dev>",

  /**
   * Accept `Authorization: Bearer dev:<userId>` instead of a real Supabase JWT.
   * Convenient locally, refused whenever STORE=supabase.
   */
  devAuth: bool(process.env.DEV_AUTH, true),
};

export function assertConfig() {
  if (config.store === "supabase") {
    const missing = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"].filter((k) => !process.env[k]);
    if (missing.length) {
      throw new Error(`STORE=supabase needs ${missing.join(", ")} — see .env.example`);
    }
    if (config.devAuth) {
      throw new Error("DEV_AUTH must be off when STORE=supabase: it would let anyone act as any user");
    }
  }

  // Beta-readiness audit finding (blocker): STORE defaults to "memory" with no
  // safety net — a real deployment that forgot to set STORE=supabase would
  // boot fine and silently discard every beta user's account/votes/posts on
  // the next restart. Gated on NODE_ENV=production (the one env var every
  // hosting platform either sets automatically or expects you to) rather
  // than on STORE itself, so `npm run dev` locally stays zero-config.
  if (process.env.NODE_ENV === "production") {
    if (config.store === "memory") {
      throw new Error(
        "STORE=memory in a production environment would silently discard every user's data on restart. " +
          "Set STORE=supabase (with SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY) — or unset NODE_ENV if this really is a throwaway environment.",
      );
    }
    if (!config.geminiApiKey) {
      throw new Error(
        "GEMINI_API_KEY is required in production: without it, every post is \"moderated\" by a fake " +
          "non-semantic stub instead of real scoring — unmoderated content would masquerade as screened. " +
          "Set GEMINI_API_KEY — or unset NODE_ENV if this really is a throwaway environment.",
      );
    }
  }
}
