import { createClient } from "@supabase/supabase-js";
import type { FastifyRequest } from "fastify";
import { config } from "./config";
import { ApiError } from "./domain";

const admin = config.supabaseUrl && config.supabaseServiceKey
  ? createClient(config.supabaseUrl, config.supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

/**
 * Resolves the calling user.
 *
 * With Supabase the bearer token is a real access token, verified against the
 * auth server. In dev-auth mode `Bearer dev:<userId>` is accepted so the API can
 * be exercised without any accounts — config.ts refuses to let that mode run
 * against a real database.
 */
export async function requireUser(req: FastifyRequest): Promise<string> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw new ApiError(401, "missing bearer token");
  const token = header.slice("Bearer ".length).trim();

  if (config.devAuth && token.startsWith("dev:")) {
    const id = token.slice(4).trim();
    if (!id) throw new ApiError(401, "dev token needs a user id: 'Bearer dev:<userId>'");
    return id;
  }

  if (!admin) throw new ApiError(401, "no auth backend configured");
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) throw new ApiError(401, "invalid or expired token");
  return data.user.id;
}
