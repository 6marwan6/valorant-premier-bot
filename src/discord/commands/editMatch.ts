import { SlashCommandBuilder } from "discord.js";
import type { Command } from "./types.js";
import { requireAdminWithConfig } from "../commandGuards.js";
import { formatMatchDateTime } from "../../modules/matches/dateTime.js";
import { syncAnnouncementIfPosted } from "../announcementSync.js";

/**
 * /edit-match — plan section 41. All fields besides match_id are
 * optional; at least one must be supplied (enforced in MatchService).
 * Blocked once a match is COMPLETED or CANCELLED (plan section 11).
 */
const data = new SlashCommandBuilder()
  .setName("edit-match")
  .setDescription("Edit an existing Premier match. Admin only.")
  .setDMPermission(false)
  .addIntegerOption((opt) =>
    opt.setName("match_id").setDescription("Match number, e.g. 42").setRequired(true),
  )
  .addStringOption((opt) => opt.setName("opponent").setDescription("New opponent team name").setRequired(false))
  .addStringOption((opt) =>
    opt.setName("date").setDescription("New date, DD/MM/YYYY (must be given with time)").setRequired(false),
  )
  .addStringOption((opt) =>
    opt.setName("time").setDescription("New time, 24h HH:mm (must be given with date)").setRequired(false),
  );

const editMatchCommand: Command = {
  data,
  async execute(interaction, ctx) {
    const guard = await requireAdminWithConfig(interaction, ctx);
    if (!guard) return;

    const matchId = interaction.options.getInteger("match_id", true);
    const opponent = interaction.options.getString("opponent") ?? undefined;
    const date = interaction.options.getString("date") ?? undefined;
    const time = interaction.options.getString("time") ?? undefined;

    const result = await ctx.services.matches.editMatch({
      guildId: guard.guildId,
      matchId,
      opponent,
      dateStr: date,
      timeStr: time,
    });

    if (!result.ok) {
      await interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
      return;
    }

    const match = result.value;
    ctx.logger.info({ event: "match.edited", guildId: guard.guildId, matchId: match.id }, "Match edited");

    // If this match's opponent/time changed after it was already posted
    // publicly, the roster message's header is now stale — refresh it.
    const withAttendance = await ctx.services.attendance.getMatchWithAttendance(guard.guildId, matchId);
    if (withAttendance) {
      await syncAnnouncementIfPosted(ctx, withAttendance);
    }

    await interaction.reply({
      content: [
        `✅ **Match #${match.id} updated.**`,
        `Opponent: ${match.opponent}`,
        `When: ${formatMatchDateTime(match.scheduledAt, match.timezone)} (${match.timezone})`,
        `Status: ${match.status}`,
      ].join("\n"),
      ephemeral: true,
    });
  },
};

export default editMatchCommand;
