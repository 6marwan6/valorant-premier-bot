import { SlashCommandBuilder } from "discord.js";
import type { Command } from "./types.js";
import { requireAdminWithConfig } from "../commandGuards.js";
import { formatMatchDateTime } from "../../modules/matches/dateTime.js";

/**
 * /create-match — plan section 11 "Match Creation" + section 41.
 *
 * **Revision, 2026-09-28:** both fields also accept looser forms (see
 * dateTime.ts's own doc comment) — "today"/"tomorrow"/a weekday/"in 3
 * days" for the date, "7pm"/"morning"/"2 hours" for the time — alongside
 * the plan's own exact DD/MM/YYYY + HH:mm example, which still works
 * unchanged.
 *
 * Required fields per the plan, revised 2026-09-27: "Date, Time" — the
 * plan originally also required "Opponent," but Valorant Premier doesn't
 * reveal the opposing team until the match itself starts, so that field
 * never had a real value to hold (see plan section 11's revision note).
 * The team's configured timezone (plan section 53, set via /setup) is
 * applied automatically — there's no timezone option here on purpose.
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
    opt.setName("date").setDescription('Match date: DD/MM/YYYY, or looser — today, tomorrow, a weekday, "in 3 days"').setRequired(true),
  )
  .addStringOption((opt) =>
    opt.setName("time").setDescription('Match time: 24h HH:mm, or looser — 7pm, morning, evening, "2 hours"').setRequired(true),
  );

const createMatchCommand: Command = {
  data,
  async execute(interaction, ctx) {
    const guard = await requireAdminWithConfig(interaction, ctx);
    if (!guard) return;

    const date = interaction.options.getString("date", true);
    const time = interaction.options.getString("time", true);

    const result = await ctx.services.matches.createMatch({
      guildId: guard.guildId,
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
        `When: ${formatMatchDateTime(match.scheduledAt, match.timezone)} (${match.timezone})`,
        `Status: ${match.status}`,
      ].join("\n"),
      ephemeral: true,
    });
  },
};

export default createMatchCommand;
