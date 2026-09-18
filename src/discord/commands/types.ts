import type {
  ChatInputCommandInteraction,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
  SlashCommandBuilder,
} from "discord.js";
import type { AppContext } from "../../appContext.js";

export type SlashCommandData =
  | SlashCommandBuilder
  | SlashCommandOptionsOnlyBuilder
  | SlashCommandSubcommandsOnlyBuilder;

/**
 * A single slash command: its Discord-facing definition plus the handler
 * that runs when it's invoked. Every command in src/discord/commands/
 * exports one of these as its default export, and commands/index.ts
 * collects them into a registry keyed by name.
 */
export interface Command {
  data: SlashCommandData;
  execute: (interaction: ChatInputCommandInteraction, ctx: AppContext) => Promise<void>;
}
