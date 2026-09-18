import { Client, GatewayIntentBits, Partials } from "discord.js";

/**
 * Creates the Discord.js gateway client.
 *
 * Intents are kept to the minimum Phase 1 needs:
 *   - Guilds: required for any guild-scoped interaction/command handling.
 *
 * Guild-interaction payloads (slash commands, buttons) already include the
 * invoking member's roles, so no privileged GUILD_MEMBERS intent is needed
 * just to run permission checks (see discord/permissions.ts).
 *
 * GatewayIntentBits.GuildMessages + MessageContent (both privileged/
 * message-content-gated) are intentionally NOT requested here. Plan section
 * 45 ("Discord Message Processing") only becomes relevant from Phase 8
 * onward (memory extraction) and should be added then, scoped to the
 * configured memory channels only.
 */
export function createDiscordClient(): Client {
  return new Client({
    intents: [GatewayIntentBits.Guilds],
    partials: [Partials.Channel],
  });
}
