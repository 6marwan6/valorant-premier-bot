import { z } from "zod";

/**
 * Environment variable contract — plan section 52 "Environment Variables".
 *
 * Split into two groups:
 *  - required at all times (bot cannot boot without them)
 *  - bootstrap-only fallbacks for MATCH_CHANNEL_ID / ADMIN_ROLE_ID /
 *    DEFAULT_TIMEZONE, which section 53 says should live in the database
 *    once an admin has run /setup. We still accept them from the
 *    environment so a fresh deployment has sane defaults before /setup
 *    has ever been run.
 */
export const envSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1, "DISCORD_BOT_TOKEN is required"),
  DISCORD_CLIENT_ID: z.string().min(1, "DISCORD_CLIENT_ID is required"),
  DISCORD_GUILD_ID: z.string().min(1, "DISCORD_GUILD_ID is required"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  // Not required in Phase 1 (plan: Phase 6 is the first phase that needs AI).
  LLM_API_KEY: z.string().optional(),

  // Bootstrap-only fallbacks — see database/schema/serverConfig.ts for the
  // authoritative, per-guild, DB-backed configuration.
  DEFAULT_TIMEZONE: z.string().default("Europe/Berlin"),
  MATCH_CHANNEL_ID: z.string().optional(),
  ADMIN_ROLE_ID: z.string().optional(),

  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Standalone schema for database-only tooling (migrations, seed scripts).
 * These run in contexts (CI, local `npm run db:migrate`) that shouldn't
 * need to supply a real Discord bot token just to touch the database.
 */
export const databaseEnvSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
});
export type DatabaseEnv = z.infer<typeof databaseEnvSchema>;

export function loadDatabaseEnv(): DatabaseEnv {
  const result = databaseEnvSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}

/**
 * Parses and validates a raw environment object against {@link envSchema}.
 * Kept separate from process.env access so it can be unit tested with
 * arbitrary fixtures (see tests/unit/env.test.ts).
 */
export function parseEnv(raw: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}

let cachedEnv: Env | undefined;

/**
 * Loads env vars from process.env (via dotenv, called once in index.ts)
 * and memoizes the validated result for the lifetime of the process.
 */
export function loadEnv(): Env {
  if (!cachedEnv) {
    cachedEnv = parseEnv(process.env);
  }
  return cachedEnv;
}

/** Test-only escape hatch to reset the memoized env between test cases. */
export function __resetEnvCacheForTests(): void {
  cachedEnv = undefined;
}
