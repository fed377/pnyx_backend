import { afterEach, describe, expect, it } from "vitest";
import { assertConfig, config } from "../src/config";

const originalEnv = { ...process.env };
const originalConfig = { ...config };

afterEach(() => {
  process.env = { ...originalEnv };
  Object.assign(config, originalConfig);
});

describe("assertConfig — production safety net", () => {
  it("refuses STORE=memory in production", () => {
    process.env.NODE_ENV = "production";
    config.store = "memory";
    expect(() => assertConfig()).toThrow(/STORE=memory/);
  });

  it("refuses to boot without GEMINI_API_KEY in production", () => {
    process.env.NODE_ENV = "production";
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "key";
    config.store = "supabase";
    config.devAuth = false;
    config.geminiApiKey = "";
    expect(() => assertConfig()).toThrow(/GEMINI_API_KEY/);
  });

  it("boots in production with the supabase store, dev auth off, and a real gemini key", () => {
    process.env.NODE_ENV = "production";
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "key";
    config.store = "supabase";
    config.devAuth = false;
    config.geminiApiKey = "real-key";
    expect(() => assertConfig()).not.toThrow();
  });

  it("doesn't require any of this outside production", () => {
    delete process.env.NODE_ENV;
    config.store = "memory";
    config.geminiApiKey = "";
    expect(() => assertConfig()).not.toThrow();
  });
});
