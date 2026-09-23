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
  // Required for verifying HTTP Interactions requests (see
  // discord/verifyInteraction.ts) — distinct from DISCORD_BOT_TOKEN.
  // Serverless hosting (Vercel functions) uses Discord's HTTP Interactions
  // model instead of a persistent gateway connection, per the project's
  // hosting decision — see README "Hosting & Deployment".
  DISCORD_PUBLIC_KEY: z.string().min(1, "DISCORD_PUBLIC_KEY is required"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  // Phase 4 (plan section 13/59): shared secret the external cron
  // scheduler (cron-job.org / Upstash QStash) sends as
  // `Authorization: Bearer <CRON_SECRET>` — see
  // services/scheduling/cronAuth.ts and api/cron/reminders.ts. Optional
  // at the schema level only so existing Phase 1-3 deployments (and
  // tests) that don't touch cron endpoints don't need to set it; the cron
  // endpoint itself refuses every request when it's unset (fails closed,
  // not open).
  CRON_SECRET: z.string().optional(),

  // Phase 6 (plan sections 57/59): any OpenAI-style Chat Completions
  // provider. All optional at the schema level — if the key, base URL or
  // model is missing the AI layer simply stays off and attendance works
  // exactly as before (plan design principle #8). Models stay configurable
  // per section 57; provider-specific request fields (e.g. reasoning
  // effort) go in LLM_EXTRA_BODY as a JSON object.
  LLM_API_KEY: z.string().optional(),
  LLM_BASE_URL: z.string().url().optional(),
  LLM_MODEL: z.string().min(1).optional(),
  LLM_EXTRA_BODY: z.string().optional(),
  // Interactions run under vercel.json's maxDuration; the LLM call happens
  // after the attendance write, so it gets its own bounded budget.
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  // Reasoning models spend max_tokens on thinking before the answer.
  LLM_MAX_TOKENS: z.coerce.number().int().positive().default(1024),

  // Bootstrap-only fallbacks — see database/schema/serverConfig.ts for the
  // authoritative, per-guild, DB-backed configuration.
  //
  // Plan section 3 says "Europe/frankfurt", which isn't a valid IANA zone
  // (see README's "flagged discrepancy" section, now resolved) — defaults
  // to Africa/Cairo instead, per plan section 11's own worked example and
  // the team being Cairo-based. Override via /setup or this env var if
  // that's wrong for your deployment.
  DEFAULT_TIMEZONE: z.string().default("Africa/Cairo"),
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
