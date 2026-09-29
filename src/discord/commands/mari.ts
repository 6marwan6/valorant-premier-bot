import { SlashCommandBuilder } from "discord.js";
import type { Command } from "./types.js";
import { startDirectChatDm } from "../consoleConversation.js";
import { MAX_PLAYER_MESSAGE_CHARS } from "../../modules/ai/conversationService.js";

/**
 * /mari — plan section 63 "Future Extensions": "`/ai` — Allow players to
 * directly talk to the team AI", pulled forward from that list into V1
 * (2026-09-28) and named after the bot's own in-character name (every
 * other private message in this codebase is already signed "M.A.R.I.").
 * Section 63 itself says this "should not affect the V1 architecture" —
 * and it doesn't: this file is Discord-facing glue only (message option
 * in, DM out), reusing Phase 7/9's entire conversation/retrieval/privacy
 * pipeline unchanged (see conversationService.ts's `openDirectChat` and
 * conversationContextBuilder.ts's `buildDirectChatContext`). Continuing an
 * already-open chat is just running `/mari` again — there is no separate
 * "reply" command; the 💬 Reply button under Mari's own DM messages works
 * here exactly like it does for a CONSOLE conversation.
 *
 * A registered player only (same posture as /memories, section 42): this
 * is a personal chat, not an admin tool, so there is no admin guard here.
 */
const data = new SlashCommandBuilder()
  .setName("mari")
  .setDescription("Chat directly with Mari, the team AI.")
  .setDMPermission(false)
  .addStringOption((opt) =>
    opt
      .setName("message")
      .setDescription("What do you want to say?")
      .setRequired(true)
      .setMaxLength(MAX_PLAYER_MESSAGE_CHARS),
  );

const mariCommand: Command = {
  data,
  async execute(interaction, ctx) {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
      return;
    }

    const player = await ctx.repositories.players.getByDiscordUserId(guildId, interaction.user.id);
    if (!player) {
      await interaction.reply({
        content: "You're not on the active roster, so there's no one for Mari to chat with here.",
        ephemeral: true,
      });
      return;
    }

    const text = interaction.options.getString("message", true);

    const result = await startDirectChatDm(ctx, {
      player,
      guildId,
      text,
      sourceRef: `command:${interaction.id}`,
    });

    switch (result.kind) {
      case "unavailable":
        await interaction.reply({ content: "Mari isn't available right now — try again later.", ephemeral: true });
        return;
      case "dm_failed":
        await interaction.reply({
          content: "I couldn't DM you — please allow DMs from server members, then try again.",
          ephemeral: true,
        });
        return;
      case "sent":
        await interaction.reply({
          content: result.created ? "Started a chat with Mari 👋 Check your DMs!" : "Sent! Check your DMs 💬",
          ephemeral: true,
        });
        return;
    }
  },
};

export default mariCommand;
