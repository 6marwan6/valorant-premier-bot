import "dotenv/config";
import { loadEnv } from "./config/env.js";
import { logger } from "./config/logger.js";
import { createDatabase } from "./database/client.js";
import { createDiscordClient } from "./discord/client.js";
import { registerReadyEvent } from "./discord/events/ready.js";
import { registerInteractionCreateEvent } from "./discord/events/interactionCreate.js";
import { buildAppContext } from "./appContext.js";

/**
 * Phase 1 — Discord Foundation (plan section 59).
 * Boots: env validation -> DB connection -> Discord client -> event
 * wiring -> login. No AI, no matches, no attendance yet — those are later
 * phases.
 */
async function main() {
  const env = loadEnv();
  const { db, pool } = createDatabase(env);
  const client = createDiscordClient();

  const ctx = buildAppContext({ client, db, env, logger });

  registerReadyEvent(client, ctx);
  registerInteractionCreateEvent(client, ctx);

  const shutdown = async (signal: string) => {
    logger.info({ event: "shutdown.start", signal }, "Shutting down");
    client.destroy();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await client.login(env.DISCORD_BOT_TOKEN);
}

main().catch((err) => {
  logger.error({ event: "startup.failed", err: err instanceof Error ? err.stack : String(err) }, "Fatal startup error");
  process.exit(1);
});
