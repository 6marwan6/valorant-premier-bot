import { SlashCommandBuilder } from "discord.js";
import type { Command } from "./types.js";
import { requireAdminWithConfig } from "../commandGuards.js";

const ENABLED_FIELDS: Array<{ key: "personalReferencesEnabled" | "runningJokesEnabled" | "valorantReferencesEnabled" | "matchHistoryReferencesEnabled" | "memoryUsageEnabled" | "aiFollowUpsEnabled"; label: string }> = [
  { key: "personalReferencesEnabled", label: "Personal references" },
  { key: "runningJokesEnabled", label: "Running jokes" },
  { key: "valorantReferencesEnabled", label: "Valorant references" },
  { key: "matchHistoryReferencesEnabled", label: "Match-history references" },
  { key: "memoryUsageEnabled", label: "Memory usage" },
  { key: "aiFollowUpsEnabled", label: "AI follow-ups" },
];

/**
 * /player — plan section 41 "Admin Commands" lists this alongside /team.
 * Read-only view of one player's stored profile, formatted the way plan
 * sections 8/9 present their own examples ("Role: Duelist", "Roast
 * intensity: 80%", ...) — useful mainly to verify /add-player and
 * /edit-player actually wrote what was intended, since there's no web
 * dashboard (plan section 4: explicitly out of scope for V1).
 */
const data = new SlashCommandBuilder()
  .setName("player")
  .setDescription("View a team member's stored Premier profile. Admin only.")
  .setDMPermission(false)
  .addUserOption((opt) => opt.setName("player").setDescription("The Discord user to look up").setRequired(true));

const playerCommand: Command = {
  data,
  async execute(interaction, ctx) {
    const guard = await requireAdminWithConfig(interaction, ctx);
    if (!guard) return;

    const target = interaction.options.getUser("player", true);
    const player = await ctx.repositories.players.getByDiscordUserId(guard.guildId, target.id);

    if (!player) {
      await interaction.reply({ content: `No profile found for <@${target.id}>.`, ephemeral: true });
      return;
    }

    const lines = [
      `**${player.displayName}**${player.active ? "" : " _(removed from active roster)_"}`,
      `• Role: ${player.role}`,
      `• Agents: ${player.agents.join(", ") || "_none_"}`,
      `• Preferred agent: ${player.preferredAgent ?? "_not set_"}`,
      "",
      `• Roast intensity: ${player.roastIntensity}`,
      ...ENABLED_FIELDS.map((f) => `• ${f.label}: ${player[f.key] ? "enabled" : "disabled"}`),
      "",
      `• Protected topics: ${player.protectedTopics.join(", ") || "_none_"}`,
    ];

    await interaction.reply({ content: lines.join("\n"), ephemeral: true });
  },
};

export default playerCommand;
