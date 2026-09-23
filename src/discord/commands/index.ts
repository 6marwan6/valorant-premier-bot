import type { Command } from "./types.js";
import setupCommand from "./setup.js";
import createMatchCommand from "./createMatch.js";
import editMatchCommand from "./editMatch.js";
import cancelMatchCommand from "./cancelMatch.js";
import listMatchesCommand from "./listMatches.js";
import postMatchCommand from "./postMatch.js";

/**
 * Central command registry. Every command file exports a default `Command`
 * and gets listed here once. Used by both:
 *   - src/scripts/deployCommands.ts (registers with the Discord REST API)
 *   - src/discord/interactions/dispatchCommand.ts (routes incoming
 *     ChatInputCommandInteractions to the right handler)
 *
 * Phase 1: /setup. Phase 2 (plan section 59): the match commands. Phase 3:
 * /post-match (provisional — see its own file doc) + attendance buttons
 * (handled via dispatchButton.ts, not the command registry). Later phases
 * append commands here as they're built (plan section 41: /add-player,
 * /complete-match, ... and section 42: /profile, /memories, /ai-settings).
 */
export const commands: Command[] = [
  setupCommand,
  createMatchCommand,
  editMatchCommand,
  cancelMatchCommand,
  listMatchesCommand,
  postMatchCommand,
];

export const commandsByName: Map<string, Command> = new Map(
  commands.map((command) => [command.data.name, command]),
);
