import { describe, expect, it } from "vitest";
import { parseEnv } from "../../src/config/env.js";

const validBase = {
  DISCORD_BOT_TOKEN: "token",
  DISCORD_CLIENT_ID: "123",
  DISCORD_GUILD_ID: "456",
  DISCORD_PUBLIC_KEY: "pubkey",
  DATABASE_URL: "postgres://user:pass@localhost:5432/db",
};

describe("parseEnv", () => {
  it("accepts a minimal valid environment and fills in defaults", () => {
    const env = parseEnv(validBase);
    expect(env.DISCORD_BOT_TOKEN).toBe("token");
    // Plan section 3 says "Europe/frankfurt", which is not a real IANA zone
    // (see README). Resolved to Africa/Cairo — plan section 11's own
    // worked example, and the team is Cairo-based.
    expect(env.DEFAULT_TIMEZONE).toBe("Africa/Cairo");
    expect(env.NODE_ENV).toBe("development");
    expect(env.LOG_LEVEL).toBe("info");
  });

  it("rejects a missing DISCORD_BOT_TOKEN", () => {
    const { DISCORD_BOT_TOKEN, ...rest } = validBase;
    expect(() => parseEnv(rest)).toThrow(/DISCORD_BOT_TOKEN/);
  });

  it("rejects a missing DATABASE_URL", () => {
    const { DATABASE_URL, ...rest } = validBase;
    expect(() => parseEnv(rest)).toThrow(/DATABASE_URL/);
  });

  it("rejects a missing DISCORD_PUBLIC_KEY (required for HTTP Interactions signature verification)", () => {
    const { DISCORD_PUBLIC_KEY, ...rest } = validBase;
    expect(() => parseEnv(rest)).toThrow(/DISCORD_PUBLIC_KEY/);
  });

  it("does not require LLM_API_KEY (no AI until Phase 6)", () => {
    const env = parseEnv(validBase);
    expect(env.LLM_API_KEY).toBeUndefined();
  });

  it("leaves the AI provider unset by default and applies bounded LLM defaults (plan sections 57/59)", () => {
    const env = parseEnv(validBase);
    expect(env.LLM_BASE_URL).toBeUndefined();
    expect(env.LLM_MODEL).toBeUndefined();
    expect(env.LLM_TIMEOUT_MS).toBe(10_000);
    expect(env.LLM_MAX_TOKENS).toBe(1024);
  });

  it("coerces numeric LLM settings and rejects a malformed base URL", () => {
    const env = parseEnv({ ...validBase, LLM_TIMEOUT_MS: "5000", LLM_MAX_TOKENS: "512" });
    expect(env.LLM_TIMEOUT_MS).toBe(5000);
    expect(env.LLM_MAX_TOKENS).toBe(512);
    expect(() => parseEnv({ ...validBase, LLM_BASE_URL: "not a url" })).toThrow(/LLM_BASE_URL/);
  });

  it("allows overriding the bootstrap timezone", () => {
    const env = parseEnv({ ...validBase, DEFAULT_TIMEZONE: "Africa/Cairo" });
    expect(env.DEFAULT_TIMEZONE).toBe("Africa/Cairo");
  });

  it("rejects an invalid NODE_ENV", () => {
    expect(() => parseEnv({ ...validBase, NODE_ENV: "staging" })).toThrow();
  });
});
