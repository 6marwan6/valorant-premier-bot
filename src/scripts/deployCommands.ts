import "dotenv/config";
import { REST, Routes } from "discord.js";
import { loadEnv } from "../config/env.js";
import { logger } from "../config/logger.js";
import { commands } from "../discord/commands/index.js";

/**
 * Registers slash commands with Discord.
 *
 * Uses GUILD commands (Routes.applicationGuildCommands), not global ones.
 * Plan section 54: "V1 supports exactly one Discord server/team... Avoid
 * unnecessary abstractions." Guild commands update instantly (global
 * commands can take up to an hour to propagate) and there's only ever one
 * guild in scope, so there's no reason to pay that latency cost.
 *
 * Run with: npm run deploy-commands
 */
async function main() {
  const env = loadEnv();
  const rest = new REST().setToken(env.DISCORD_BOT_TOKEN);

  const body = commands.map((c) => c.data.toJSON());

  logger.info(
    { event: "deployCommands.start", commandCount: body.length, commands: body.map((c) => c.name) },
    "Registering guild slash commands",
  );

  await rest.put(Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, env.DISCORD_GUILD_ID), {
    body,
  });

  logger.info({ event: "deployCommands.complete" }, "Slash commands registered");
}

main().catch((err) => {
  logger.error({ event: "deployCommands.failed", err: String(err) }, "Failed to register commands");
  process.exit(1);
});
