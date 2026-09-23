import { SlashCommandBuilder } from "discord.js";
import type { Command } from "./types.js";
import { requireAdminWithConfig } from "../commandGuards.js";
import { formatMatchDateTime } from "../../modules/matches/dateTime.js";

const STATUS_EMOJI: Record<string, string> = {
  SCHEDULED: "🗓️",
  CONFIRMATION_OPEN: "🟢",
  IN_PROGRESS: "🔴",
  COMPLETED: "🏆",
  CANCELLED: "🚫",
};

/** /list-matches — plan section 41. Soonest-first, all statuses shown. */
const data = new SlashCommandBuilder()
  .setName("list-matches")
  .setDescription("List Premier matches for this server. Admin only.")
  .setDMPermission(false);

const listMatchesCommand: Command = {
  data,
  async execute(interaction, ctx) {
    const guard = await requireAdminWithConfig(interaction, ctx);
    if (!guard) return;

    const matchList = await ctx.services.matches.listMatches(guard.guildId);

    if (matchList.length === 0) {
      await interaction.reply({ content: "No matches scheduled yet. Use `/create-match` to add one.", ephemeral: true });
      return;
    }

    const lines = matchList.map((m) => {
      const emoji = STATUS_EMOJI[m.status] ?? "•";
      return `${emoji} **#${m.id}** ${m.opponent} — ${formatMatchDateTime(m.scheduledAt, m.timezone)} _(${m.status})_`;
    });

    await interaction.reply({ content: lines.join("\n"), ephemeral: true });
  },
};

export default listMatchesCommand;
