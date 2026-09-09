import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "./config";
import { ApiError } from "./domain";

const credentials = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
  name: z.string().min(1).max(80).optional(),
});

const refresh = z.object({ refreshToken: z.string().min(10) });

const oauthQuery = z.object({ redirect: z.string().min(1).max(500) });

/** Deep links back into this app, plus Expo Go's dev URL. */
const ALLOWED_REDIRECT = /^(pnyx:\/\/|exp:\/\/|exps:\/\/|https?:\/\/localhost([:/]|$))/;

type Session = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number | null;
  userId: string;
};

/**
 * Thin proxy over Supabase Auth so the app needs exactly one piece of config —
 * the API URL — and no Supabase key of its own. The profile row is created by
 * the on_auth_user_created trigger, not here.
 */
export function registerAuthRoutes(app: FastifyInstance) {
  let client: SupabaseClient | null = null;
  const auth = () => {
    if (!config.supabaseUrl || !config.supabaseServiceKey) {
      throw new ApiError(501, "auth needs STORE=supabase with Supabase keys configured");
    }
    client ??= createClient(config.supabaseUrl, config.supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    return client;
  };

  const toSession = (data: {
    session: { access_token: string; refresh_token: string; expires_at?: number } | null;
    user: { id: string } | null;
  }): Session => {
    if (!data.session || !data.user) throw new ApiError(401, "no session returned");
    return {
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      expiresAt: data.session.expires_at ?? null,
      userId: data.user.id,
    };
  };

  app.post("/auth/signup", async (req, reply) => {
    const { email, password, name } = credentials.parse(req.body);
    const { data, error } = await auth().auth.signUp({
      email,
      password,
      options: { data: name ? { name } : {} },
    });
    if (error) throw new ApiError(400, error.message);
    // With email confirmation enabled Supabase returns a user but no session.
    if (!data.session) {
      return reply.code(202).send({ pending: true, message: "check your email to confirm the account" });
    }
    return toSession({ session: data.session, user: data.user });
  });

  app.post("/auth/signin", async (req) => {
    const { email, password } = credentials.parse(req.body);
    const { data, error } = await auth().auth.signInWithPassword({ email, password });
    if (error) throw new ApiError(401, error.message);
    return toSession({ session: data.session, user: data.user });
  });

  /**
   * Hands the app the Supabase authorize URL for Google. The app opens it in a
   * browser and Supabase redirects back to `redirect` with the tokens attached,
   * so the app still needs no Supabase key of its own.
   */
  app.get("/auth/google/url", async (req) => {
    const { redirect } = oauthQuery.parse(req.query);
    if (!ALLOWED_REDIRECT.test(redirect)) {
      throw new ApiError(400, "unsupported redirect target");
    }
    if (!config.supabaseUrl) {
      throw new ApiError(501, "auth needs STORE=supabase with Supabase keys configured");
    }
    const url =
      `${config.supabaseUrl}/auth/v1/authorize` +
      `?provider=google&redirect_to=${encodeURIComponent(redirect)}`;
    return { url };
  });

  app.post("/auth/refresh", async (req) => {
    const { refreshToken } = refresh.parse(req.body);
    const { data, error } = await auth().auth.refreshSession({ refresh_token: refreshToken });
    if (error) throw new ApiError(401, error.message);
    return toSession({ session: data.session, user: data.user });
  });
}
