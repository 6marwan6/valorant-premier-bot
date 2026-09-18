import type { Command } from "./types.js";
import setupCommand from "./setup.js";

/**
 * Central command registry. Every command file exports a default `Command`
 * and gets listed here once. Used by both:
 *   - src/scripts/deployCommands.ts (registers with the Discord REST API)
 *   - src/discord/interactions/dispatchCommand.ts (routes incoming
 *     ChatInputCommandInteractions to the right handler)
 *
 * Phase 1 only ships /setup. Later phases append commands here as they're
 * built (plan section 41: /add-player, /create-match, /complete-match, ...
 * and section 42: /profile, /memories, /ai-settings).
 */
export const commands: Command[] = [setupCommand];

export const commandsByName: Map<string, Command> = new Map(
  commands.map((command) => [command.data.name, command]),
);
