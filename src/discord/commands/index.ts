import type { Command } from "./types.js";
import setupCommand from "./setup.js";
import createMatchCommand from "./createMatch.js";
import editMatchCommand from "./editMatch.js";
import cancelMatchCommand from "./cancelMatch.js";
import listMatchesCommand from "./listMatches.js";
import postMatchCommand from "./postMatch.js";
import addPlayerCommand from "./addPlayer.js";
import editPlayerCommand from "./editPlayer.js";
import removePlayerCommand from "./removePlayer.js";
import playerCommand from "./player.js";
import memoriesCommand from "./memories.js";
import completeMatchCommand from "./completeMatch.js";
import mariCommand from "./mari.js";
import addMemoryCommand from "./addMemory.js";
import mariSayCommand from "./mariSay.js";
import mariJoinCommand from "./mariJoin.js";
import mariVoiceCommand from "./mariVoice.js";

/**
 * Central command registry. Every command file exports a default `Command`
 * and gets listed here once. Used by both:
 *   - src/scripts/deployCommands.ts (registers with the Discord REST API)
 *   - src/discord/interactions/dispatchCommand.ts (routes incoming
 *     ChatInputCommandInteractions to the right handler)
 *
 * Phase 1: /setup. Phase 2 (plan section 59): the match commands. Phase 3:
 * /post-match (provisional — see its own file doc) + attendance buttons
 * (handled via dispatchButton.ts, not the command registry). Phase 5:
 * /add-player, /edit-player, /remove-player, /player (plan section 41).
 * Phase 8: /memories (plan sections 42/43). Later phases append their own
 * (section 42: /profile, /ai-settings; section 41: /complete-match, /team).
 * 2026-09-28: /mari (section 63's `/ai`, pulled forward) and /add-memory
 * (manual starter facts, an admin extension of section 21).
 * 2026-09-30: /mari-say (admin has Mari post a message verbatim in a channel).
 * 2026-10-01: /mari-join (admin tells Mari which voice channel to join, and when).
 * 2026-10-01 (d): /mari-voice (admin has Mari send a voice note, like /mari-say but spoken).
 */
export const commands: Command[] = [
  setupCommand,
  createMatchCommand,
  editMatchCommand,
  cancelMatchCommand,
  listMatchesCommand,
  postMatchCommand,
  addPlayerCommand,
  editPlayerCommand,
  removePlayerCommand,
  playerCommand,
  memoriesCommand,
  completeMatchCommand,
  mariCommand,
  addMemoryCommand,
  mariSayCommand,
  mariJoinCommand,
  mariVoiceCommand,
];

export const commandsByName: Map<string, Command> = new Map(
  commands.map((command) => [command.data.name, command]),
);
