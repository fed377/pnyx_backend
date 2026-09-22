import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireUser } from "./auth";
import { config } from "./config";
import { ageOn, ApiError, MIN_AGE } from "./domain";

/** Matches the handle format enforced elsewhere (routes.ts's profilePatch, the 0001 schema check). */
const HANDLE_RE = /^[a-z0-9._]+$/i;
const handleField = z.string().min(2).max(30).regex(HANDLE_RE);

/** YYYY-MM-DD, matching what the create-account screen sends. */
const birthdayField = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime()), "invalid date");

const signUpCredentials = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
  name: z.string().min(1).max(80).optional(),
  /** Chosen on the create-account screen, live-checked via /auth/handle-check.
   * Travels through signUp's user_metadata into the handle_new_user trigger
   * (migration 0012) — falls back to an email-derived handle if omitted. */
  handle: handleField.optional(),
  /** Collected on the create-account screen now, not a separate onboarding
   * step — checked against MIN_AGE below before the account is even
   * created, then written onto the new profile row once it exists. */
  birthday: birthdayField,
});

/** Login accepts either an email or a handle — resolved to an email below,
 * since Supabase's own signInWithPassword only ever takes one. */
const signInCredentials = z.object({
  identifier: z.string().min(2).max(254),
  password: z.string().min(8).max(200),
});

const handleCheckQuery = z.object({ handle: handleField });

const refresh = z.object({ refreshToken: z.string().min(10) });

const changePassword = z.object({
  // Absent for an account with no password yet (a Google-only sign-up
  // setting one for the first time) — present and required otherwise.
  currentPassword: z.string().min(8).max(200).optional(),
  newPassword: z.string().min(8).max(200),
});

const oauthQuery = z.object({ redirect: z.string().min(1).max(500) });

const googleToken = z.object({ idToken: z.string().min(10) });

/** Accepts an email or a handle, like signin — resolved the same way below. */
const forgotPassword = z.object({
  identifier: z.string().min(1).max(254),
  redirect: z.string().min(1).max(500),
});

const resetPassword = z.object({ newPassword: z.string().min(8).max(200) });

/** Deep links back into this app, plus Expo Go's dev URL — current Expo Go
 * builds use `expo://`, older ones (and some tooling) still use `exp://`. */
const ALLOWED_REDIRECT = /^(pnyx:\/\/|expo:\/\/|exp:\/\/|exps:\/\/|https?:\/\/localhost([:/]|$))/;

/** Credential-stuffing/brute-force surface — much tighter than the app-wide
 * default (see server.ts), since these are the routes an attacker actually
 * wants to hammer. */
const BRUTE_FORCE_GUARD = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

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

  /**
   * Wraps a client deep link in the same-origin https bridge (see
   * /auth/mobile-redirect below) that every Supabase email/redirect flow in
   * this file goes through — Supabase's redirect_to validation is unreliable
   * for custom app schemes even when correctly allowlisted, silently falling
   * back to the project's Site URL instead of erroring. `req`-derived, never
   * client-supplied, so this can't become an open redirect.
   */
  const bridgeFor = (req: FastifyRequest, redirect: string) =>
    `${req.protocol}://${req.hostname}/auth/mobile-redirect?to=${encodeURIComponent(redirect)}`;

  /**
   * Handle -> email, for logging in (or requesting a password reset) with a
   * handle. Not authenticated (there's no session yet), so this only ever
   * needs the profiles table, not the repository layer. Returns null rather
   * than throwing on a miss — callers turn that into the same generic
   * response a wrong password/unregistered email already gets, so a
   * mistyped handle can't be told apart from either (no account-existence
   * leak either way).
   */
  const emailForHandle = async (handle: string): Promise<string | null> => {
    const { data: profile } = await auth().from("profiles").select("id").eq("handle", handle).maybeSingle();
    if (!profile) return null;
    const { data: userData } = await auth().auth.admin.getUserById(profile.id);
    return userData.user?.email ?? null;
  };

  app.post("/auth/signup", BRUTE_FORCE_GUARD, async (req, reply) => {
    const { email, password, name, handle, birthday } = signUpCredentials.parse(req.body);
    // Checked before the account is even created — no orphan under-16
    // accounts left behind by a rejected signup.
    if (ageOn(birthday) < MIN_AGE) {
      throw new ApiError(403, `you must be at least ${MIN_AGE} to use PNYX`);
    }
    const { data, error } = await auth().auth.signUp({
      email,
      password,
      options: { data: { ...(name ? { name } : {}), ...(handle ? { handle } : {}) } },
    });
    if (error) throw new ApiError(400, error.message);
    // The profiles row is created by the on_auth_user_created trigger, which
    // doesn't know about birthday — set it directly here, along with
    // onboarded (there's no separate onboarding step to complete any more).
    if (data.user) {
      await auth().from("profiles").update({ birthday, onboarded: true }).eq("id", data.user.id);
    }
    // With email confirmation enabled Supabase returns a user but no session.
    if (!data.session) {
      return reply.code(202).send({ pending: true, message: "check your email to confirm the account" });
    }
    return toSession({ session: data.session, user: data.user });
  });

  app.post("/auth/signin", BRUTE_FORCE_GUARD, async (req) => {
    const { identifier, password } = signInCredentials.parse(req.body);
    const email = identifier.includes("@") ? identifier : await emailForHandle(identifier);
    if (!email) throw new ApiError(401, "Invalid login credentials");
    const { data, error } = await auth().auth.signInWithPassword({ email, password });
    if (error) throw new ApiError(401, error.message);
    return toSession({ session: data.session, user: data.user });
  });

  /** Live "is this handle free" check for the create-account screen. Public
   * and unauthenticated — same reasoning as emailForHandle above, and handle
   * existence is already visible via People search to anyone signed in. */
  app.get("/auth/handle-check", async (req) => {
    const { handle } = handleCheckQuery.parse(req.query);
    const { data: profile } = await auth().from("profiles").select("id").eq("handle", handle).maybeSingle();
    return { available: !profile };
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
      `?provider=google&redirect_to=${encodeURIComponent(bridgeFor(req, redirect))}`;
    return { url };
  });

  /**
   * A bridge page. Supabase's redirect_to validation is reliable for
   * https:// targets but flaky for custom app schemes (expo://, pnyx://)
   * even when they're correctly allowlisted — it silently falls back to the
   * project's Site URL instead. So the app tells Supabase to come back
   * *here* (an https:// URL, which Supabase honors) with the real deep
   * link tucked into `to`, and this page's own script finishes the last
   * hop client-side.
   *
   * This has to be a page with inline JS, not a server-side redirect:
   * Supabase's session comes back in the URL *fragment*
   * (`#access_token=...`), and fragments are never sent to a server — only
   * client-side script can read one.
   *
   * `to` is re-validated against the exact same allowlist `/auth/google/url`
   * uses, both here and in the page's own script. Without that this would
   * be an open redirect that hands a real, just-issued session to whatever
   * `to` says — anyone could craft their own link to this public endpoint.
   */
  app.get("/auth/mobile-redirect", async (req, reply) => {
    const { to } = z.object({ to: z.string().min(1).max(500) }).parse(req.query);
    if (!ALLOWED_REDIRECT.test(to)) {
      throw new ApiError(400, "unsupported redirect target");
    }
    return reply.type("text/html").send(`<!doctype html>
<title>Signing you in…</title>
<body style="font: 16px -apple-system, sans-serif; padding: 2rem;">
<p>Signing you in…</p>
<script>
  var to = ${JSON.stringify(to)};
  // Re-checked here too: this script runs with whatever "to" is in the
  // URL, which could differ from what the server above validated if
  // someone reached this page with a hand-crafted link instead of one
  // this API generated.
  var allowed = /^(pnyx:\\/\\/|expo:\\/\\/|exp:\\/\\/|exps:\\/\\/)/;
  if (allowed.test(to)) {
    location.replace(to + location.hash);
  } else {
    document.body.textContent = "Could not complete sign-in.";
  }
</script>
</body>`);
  });

  /**
   * The native path: the app runs the system Google account picker itself
   * (via @react-native-google-signin) and hands us the resulting Google ID
   * token — no browser, no redirect_to allowlist to maintain. Supabase
   * verifies the token against Google directly.
   */
  app.post("/auth/google/token", BRUTE_FORCE_GUARD, async (req) => {
    const { idToken } = googleToken.parse(req.body);
    const { data, error } = await auth().auth.signInWithIdToken({ provider: "google", token: idToken });
    if (error) throw new ApiError(401, error.message);
    return toSession({ session: data.session, user: data.user });
  });

  app.post("/auth/refresh", async (req) => {
    const { refreshToken } = refresh.parse(req.body);
    const { data, error } = await auth().auth.refreshSession({ refresh_token: refreshToken });
    if (error) throw new ApiError(401, error.message);
    return toSession({ session: data.session, user: data.user });
  });

  /**
   * Emails a recovery link (Supabase's own, routed through the same bridge
   * page every deep-link flow in this file uses). Accepts an email or a
   * handle, like signin. Always returns the same response regardless of
   * whether the account is actually registered — this is a public,
   * unauthenticated endpoint, and confirming an account's existence here
   * would be a user-enumeration leak.
   */
  app.post("/auth/forgot-password", BRUTE_FORCE_GUARD, async (req) => {
    const { identifier, redirect } = forgotPassword.parse(req.body);
    if (!ALLOWED_REDIRECT.test(redirect)) {
      throw new ApiError(400, "unsupported redirect target");
    }
    if (config.supabaseUrl) {
      const email = identifier.includes("@") ? identifier : await emailForHandle(identifier);
      if (email) {
        await auth().auth.resetPasswordForEmail(email, { redirectTo: bridgeFor(req, redirect) });
      }
    }
    return { ok: true };
  });

  /**
   * Sets a new password from a recovery link. Authenticated by the recovery
   * session's own access token (requireUser accepts it like any other valid
   * token) rather than a current-password check — clicking a link only
   * Supabase emailed to the account's real address already proves ownership,
   * which is the whole point of this flow existing for someone who can't
   * sign in to reach /auth/change-password in the first place.
   */
  app.post("/auth/reset-password", async (req) => {
    const userId = await requireUser(req);
    const { newPassword } = resetPassword.parse(req.body);
    const { error } = await auth().auth.admin.updateUserById(userId, { password: newPassword });
    if (error) throw new ApiError(400, error.message);
    return { ok: true };
  });

  /**
   * Whether this account has a password at all. A Google-only sign-up has
   * no password identity — Settings uses this to show "Set a password"
   * (no current-password field) instead of "Change password".
   */
  app.get("/auth/password-status", async (req) => {
    const userId = await requireUser(req);
    const { data, error } = await auth().auth.admin.getUserById(userId);
    if (error || !data.user) throw new ApiError(400, "no such account");
    const hasPassword = (data.user.identities ?? []).some((i) => i.provider === "email");
    return { hasPassword };
  });

  /**
   * Re-verifies the current password (a fresh access token alone proves the
   * session is live, not that the caller still knows the password) before
   * setting the new one via the admin API — the client never gets a key that
   * could do this unchecked. The one exception is an account with no
   * password yet (Google-only): there is nothing to verify, so
   * currentPassword is neither required nor checked — /auth/password-status
   * is what the client uses to know which form to show.
   */
  app.post("/auth/change-password", async (req) => {
    const userId = await requireUser(req);
    const { currentPassword, newPassword } = changePassword.parse(req.body);
    const client = auth();

    const { data: userData, error: userErr } = await client.auth.admin.getUserById(userId);
    if (userErr || !userData.user?.email) throw new ApiError(400, "no email on this account");

    const hasPassword = (userData.user.identities ?? []).some((i) => i.provider === "email");
    if (hasPassword) {
      if (!currentPassword) throw new ApiError(400, "current password is required");
      const { error: verifyErr } = await client.auth.signInWithPassword({
        email: userData.user.email,
        password: currentPassword,
      });
      if (verifyErr) throw new ApiError(401, "current password is incorrect");
    }

    const { error: updateErr } = await client.auth.admin.updateUserById(userId, { password: newPassword });
    if (updateErr) throw new ApiError(400, updateErr.message);

    return { ok: true };
  });
}
