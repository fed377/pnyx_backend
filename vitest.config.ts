import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The first inject() pays for route compilation; give it room on a cold worker.
    testTimeout: 20_000,
    include: ["test/**/*.test.ts"],
    // Pin the mode so the suite never depends on whatever is in a developer's
    // .env — dotenv does not override variables that are already set.
    env: {
      STORE: "memory",
      DEV_AUTH: "true",
      SUPABASE_URL: "",
      SUPABASE_SERVICE_ROLE_KEY: "",
    },
  },
});
