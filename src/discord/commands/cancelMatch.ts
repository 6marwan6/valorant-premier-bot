import { SlashCommandBuilder } from "discord.js";
import type { Command } from "./types.js";
import { requireAdminWithConfig } from "../commandGuards.js";
import { syncAnnouncementIfPosted } from "../announcementSync.js";

/**
 * /cancel-match — plan section 41 / section 12: cancellation is allowed
 * "from any state before completion", rejected if already COMPLETED or
 * CANCELLED.
 */
const data = new SlashCommandBuilder()
  .setName("cancel-match")
  .setDescription("Cancel a Premier match. Admin only.")
  .setDMPermission(false)
  .addIntegerOption((opt) =>
    opt.setName("match_id").setDescription("Match number, e.g. 42").setRequired(true),
  );

const cancelMatchCommand: Command = {
  data,
  async execute(interaction, ctx) {
    const guard = await requireAdminWithConfig(interaction, ctx);
    if (!guard) return;

    const matchId = interaction.options.getInteger("match_id", true);

    const result = await ctx.services.matches.cancelMatch({ guildId: guard.guildId, matchId });

    if (!result.ok) {
      await interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
      return;
    }

    ctx.logger.info(
      { event: "match.cancelled", guildId: guard.guildId, matchId: result.value.id },
      "Match cancelled",
    );

    // If this match was already posted publicly (plan sections 14/16), the
    // roster message must reflect the cancellation and lose its buttons —
    // otherwise players could keep clicking a dead match indefinitely.
    const withAttendance = await ctx.services.attendance.getMatchWithAttendance(guard.guildId, matchId);
    if (withAttendance) {
      await syncAnnouncementIfPosted(ctx, withAttendance);
    }

    await interaction.reply({
      content: `🚫 **Match #${result.value.id}** against ${result.value.opponent} has been cancelled.`,
      ephemeral: true,
    });
  },
};

export default cancelMatchCommand;
