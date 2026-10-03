import { SlashCommandBuilder } from "discord.js";
import type { Command } from "./types.js";
import { startDirectChatDm } from "../consoleConversation.js";
import { runServerChatTurn } from "../serverChat.js";
import { MAX_PLAYER_MESSAGE_CHARS } from "../../modules/ai/conversationService.js";

/**
 * /mari — plan section 63's `/ai` ("Allow players to directly talk to the
 * team AI"), pulled forward into V1 (2026-09-28) and named after the bot's
 * own in-character name (every private message here is signed "M.A.R.I.").
 *
 * **Revised 2026-09-29 (plan sections 42 and 63):** `/mari` now answers
 * **publicly, in the channel it was used in** — a *server chat*. It is the
 * server half of the split the product owner asked for:
 *
 * - **Server chat (this command's default, and `@Mari`).** Public by nature,
 *   so Mari only uses what the whole team may see: admin-entered lore
 *   (PUBLIC by default), facts players said in the server (TEAM), team facts
 *   from the database, and never anything a player said in a DM.
 * - **DM chat.** Private. The natural way in is simply to DM the bot (needs
 *   the gateway worker — plan section 4's note). `private: true` here is the
 *   fallback that works without one: the reply goes to the caller's DMs
 *   instead, exactly as `/mari` behaved before this revision.
 *
 * The public answer is filled into the deferred placeholder
 * (handleDiscordInteraction.ts defers `/mari` publicly), so it appears in
 * the same channel as a normal reply to the command. Errors meant only for
 * the caller (not on the roster, DMs closed) stay ephemeral — the adapter
 * swaps the public placeholder for a private followup.
 *
 * A registered, ACTIVE player only (same posture as /memories, section 42):
 * this is a personal chat, not an admin tool, so there is no admin guard.
 */
const data = new SlashCommandBuilder()
  .setName("mari")
  .setDescription("Chat with Mari, the team AI. She answers right here in the channel.")
  .setDMPermission(false)
  .addStringOption((opt) =>
    opt
      .setName("message")
      .setDescription("What do you want to say?")
      .setRequired(true)
      .setMaxLength(MAX_PLAYER_MESSAGE_CHARS),
  )
  .addBooleanOption((opt) =>
    opt
      .setName("private")
      .setDescription("Answer in a private DM instead of here (your DM chat also remembers what you tell it).")
      .setRequired(false),
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
    if (!player || !player.active) {
      await interaction.reply({
        content: "Mari doesn't know you yet — ask an admin to add you with `/add-member` (or `/add-player` if you play Premier).",
        ephemeral: true,
      });
      return;
    }

    const text = interaction.options.getString("message", true);
    const wantsPrivate = interaction.options.getBoolean("private") === true;

    if (wantsPrivate) {
      const result = await startDirectChatDm(ctx, { player, guildId, text, sourceRef: `command:${interaction.id}` });
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
            content: result.created ? "Started a private chat with Mari 👋 Check your DMs!" : "Sent! Check your DMs 💬",
            ephemeral: true,
          });
          return;
      }
    }

    const result = await runServerChatTurn(ctx, {
      guildId,
      player,
      text,
      sourceRef: `command:${interaction.id}`,
      deliver: (reply) => interaction.editReply({ content: reply, suppressMentions: true } as never).then(() => undefined),
    });

    switch (result.kind) {
      case "replied":
      case "ignored":
        return;
      case "unavailable":
        await interaction.reply({ content: "Mari isn't available right now — try again later.", ephemeral: true });
        return;
      case "not_a_player":
        await interaction.reply({ content: "You're not on the active roster, so there's no one for Mari to chat with here.", ephemeral: true });
        return;
      case "failed":
        await interaction.reply({ content: "Something went wrong on my end — try again in a moment.", ephemeral: true });
        return;
    }
  },
};

export default mariCommand;
