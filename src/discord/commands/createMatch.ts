import { SlashCommandBuilder } from "discord.js";
import type { Command } from "./types.js";
import { requireAdminWithConfig } from "../commandGuards.js";
import { formatMatchDateTime } from "../../modules/matches/dateTime.js";

/**
 * /create-match — plan section 11 "Match Creation" + section 41.
 *
 * Required fields per the plan, verbatim: "Opponent, Date, Time." The
 * team's configured timezone (plan section 53, set via /setup) is applied
 * automatically — there's no timezone option here on purpose.
 *
 * No setDefaultMemberPermissions() here (unlike /setup): this command
 * must be usable by anyone holding the *configured* admin_role_id, which
 * Discord's native permission system has no concept of. Authorization is
 * entirely handled by requireAdminWithConfig() at runtime (plan section
 * 55, defense against relying on a single gate).
 */
const data = new SlashCommandBuilder()
  .setName("create-match")
  .setDescription("Schedule a new Premier match. Admin only.")
  .setDMPermission(false)
  .addStringOption((opt) =>
    opt.setName("opponent").setDescription("Opponent team name").setRequired(true),
  )
  .addStringOption((opt) =>
    opt.setName("date").setDescription("Match date, DD/MM/YYYY (e.g. 18/09/2026)").setRequired(true),
  )
  .addStringOption((opt) =>
    opt.setName("time").setDescription("Match time, 24h HH:mm (e.g. 19:00)").setRequired(true),
  );

const createMatchCommand: Command = {
  data,
  async execute(interaction, ctx) {
    const guard = await requireAdminWithConfig(interaction, ctx);
    if (!guard) return;

    const opponent = interaction.options.getString("opponent", true);
    const date = interaction.options.getString("date", true);
    const time = interaction.options.getString("time", true);

    const result = await ctx.services.matches.createMatch({
      guildId: guard.guildId,
      opponent,
      dateStr: date,
      timeStr: time,
    });

    if (!result.ok) {
      await interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
      return;
    }

    const match = result.value;
    ctx.logger.info(
      { event: "match.created", guildId: guard.guildId, matchId: match.id },
      "Match created",
    );

    await interaction.reply({
      content: [
        `✅ **Match #${match.id} created.**`,
        `Opponent: ${match.opponent}`,
        `When: ${formatMatchDateTime(match.scheduledAt, match.timezone)} (${match.timezone})`,
        `Status: ${match.status}`,
      ].join("\n"),
      ephemeral: true,
    });
  },
};

export default createMatchCommand;
