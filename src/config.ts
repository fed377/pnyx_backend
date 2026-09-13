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
  supabaseJwtSecret: process.env.SUPABASE_JWT_SECRET ?? "",

  /** Spec §8 content scoring. Without it the server falls back to the deterministic stub. */
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  scorerModel: process.env.SCORER_MODEL ?? "gemini-2.5-flash-lite",

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
}
