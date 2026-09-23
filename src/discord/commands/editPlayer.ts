import { SlashCommandBuilder } from "discord.js";
import type { Command } from "./types.js";
import { requireAdminWithConfig } from "../commandGuards.js";
import { PLAYER_ROLE_CHOICES, parseCommaSeparatedList, validatePreferredAgent } from "../../modules/players/playerValidation.js";
import type { PlayerProfileFields } from "../../database/repositories/playerRepository.js";
import type { PlayerRow } from "../../database/schema/players.js";

/**
 * /edit-player — plan section 41 / section 9 "Player AI Configuration" /
 * section 10 "Protected Topics" (Phase 5).
 *
 * Every field is optional and, like /setup, only the ones explicitly
 * passed are changed (PlayerRepository.update's partial-update contract)
 * — this is the single command that tunes an individual player's whole
 * AI relationship (roast intensity, which reference categories are on,
 * protected topics) without re-supplying the rest of their profile.
 *
 * `agents` and `protected_topics` both REPLACE the existing list when
 * passed (matching how /setup's options replace, not merge, a single
 * field) rather than appending — see each option's description. To clear
 * protected topics entirely, pass the literal word "none".
 */
const data = new SlashCommandBuilder()
  .setName("edit-player")
  .setDescription("Update a team member's Premier profile or AI settings. Admin only.")
  .setDMPermission(false)
  .addUserOption((opt) => opt.setName("player").setDescription("The Discord user to edit").setRequired(true))
  .addStringOption((opt) =>
    opt
      .setName("role")
      .setDescription("Their Valorant role")
      .setRequired(false)
      .addChoices(...PLAYER_ROLE_CHOICES.map((c) => ({ name: c.name, value: c.value }))),
  )
  .addStringOption((opt) =>
    opt
      .setName("agents")
      .setDescription("Replaces their full agent list, comma-separated")
      .setRequired(false),
  )
  .addStringOption((opt) =>
    opt.setName("preferred_agent").setDescription("Must be one of their (new or existing) agents").setRequired(false),
  )
  .addIntegerOption((opt) =>
    opt.setName("roast_intensity").setDescription("0-100").setMinValue(0).setMaxValue(100).setRequired(false),
  )
  .addBooleanOption((opt) => opt.setName("personal_references").setDescription("Allow personal-reference jokes?").setRequired(false))
  .addBooleanOption((opt) => opt.setName("running_jokes").setDescription("Allow running jokes?").setRequired(false))
  .addBooleanOption((opt) => opt.setName("valorant_references").setDescription("Allow Valorant references?").setRequired(false))
  .addBooleanOption((opt) =>
    opt.setName("match_history_references").setDescription("Allow match-history callbacks?").setRequired(false),
  )
  .addBooleanOption((opt) => opt.setName("memory_usage").setDescription("Allow retrieved memories in their AI context?").setRequired(false))
  .addBooleanOption((opt) => opt.setName("ai_followups").setDescription("Allow the AI to ask follow-up questions?").setRequired(false))
  .addStringOption((opt) =>
    opt
      .setName("protected_topics")
      .setDescription('Replaces their full protected-topics list, comma-separated (or "none" to clear)')
      .setRequired(false),
  );

const editPlayerCommand: Command = {
  data,
  async execute(interaction, ctx) {
    const guard = await requireAdminWithConfig(interaction, ctx);
    if (!guard) return;

    const target = interaction.options.getUser("player", true);
    const existing = await ctx.repositories.players.getByDiscordUserId(guard.guildId, target.id);
    if (!existing) {
      await interaction.reply({
        content: `<@${target.id}> doesn't have a profile yet — use \`/add-player\` first.`,
        ephemeral: true,
      });
      return;
    }

    const role = interaction.options.getString("role") as PlayerRow["role"] | null;
    const agentsRaw = interaction.options.getString("agents");
    const preferredAgentRaw = interaction.options.getString("preferred_agent");
    const roastIntensity = interaction.options.getInteger("roast_intensity");
    const protectedTopicsRaw = interaction.options.getString("protected_topics");
    const personalReferences = interaction.options.getBoolean("personal_references");
    const runningJokes = interaction.options.getBoolean("running_jokes");
    const valorantReferences = interaction.options.getBoolean("valorant_references");
    const matchHistoryReferences = interaction.options.getBoolean("match_history_references");
    const memoryUsage = interaction.options.getBoolean("memory_usage");
    const aiFollowups = interaction.options.getBoolean("ai_followups");

    const updates: Partial<PlayerProfileFields> = {};

    let effectiveAgents = existing.agents;
    if (agentsRaw !== null) {
      const parsedAgents = parseCommaSeparatedList(agentsRaw, "agent");
      if (!parsedAgents.ok) {
        await interaction.reply({ content: `❌ ${parsedAgents.error}`, ephemeral: true });
        return;
      }
      effectiveAgents = parsedAgents.values;
      updates.agents = parsedAgents.values;
    }

    if (preferredAgentRaw !== null) {
      const error = validatePreferredAgent(preferredAgentRaw, effectiveAgents);
      if (error) {
        await interaction.reply({ content: `❌ ${error}`, ephemeral: true });
        return;
      }
      updates.preferredAgent = preferredAgentRaw.trim();
    }

    if (protectedTopicsRaw !== null) {
      if (protectedTopicsRaw.trim().toLowerCase() === "none") {
        updates.protectedTopics = [];
      } else {
        const parsedTopics = parseCommaSeparatedList(protectedTopicsRaw, "protected topic");
        if (!parsedTopics.ok) {
          await interaction.reply({ content: `❌ ${parsedTopics.error}`, ephemeral: true });
          return;
        }
        updates.protectedTopics = parsedTopics.values;
      }
    }

    if (role !== null) updates.role = role;
    if (roastIntensity !== null) updates.roastIntensity = roastIntensity;
    if (personalReferences !== null) updates.personalReferencesEnabled = personalReferences;
    if (runningJokes !== null) updates.runningJokesEnabled = runningJokes;
    if (valorantReferences !== null) updates.valorantReferencesEnabled = valorantReferences;
    if (matchHistoryReferences !== null) updates.matchHistoryReferencesEnabled = matchHistoryReferences;
    if (memoryUsage !== null) updates.memoryUsageEnabled = memoryUsage;
    if (aiFollowups !== null) updates.aiFollowUpsEnabled = aiFollowups;

    if (Object.keys(updates).length === 0) {
      await interaction.reply({ content: "Nothing to change — pass at least one field to update.", ephemeral: true });
      return;
    }

    const updated = await ctx.repositories.players.update(guard.guildId, target.id, updates);
    if (!updated) {
      await interaction.reply({ content: "Something went wrong updating that profile. Please try again.", ephemeral: true });
      return;
    }

    ctx.logger.info(
      { event: "player.edited", guildId: guard.guildId, discordUserId: target.id, fields: Object.keys(updates) },
      "Player profile updated",
    );

    await interaction.reply({
      content: `✅ Updated <@${target.id}>'s profile (${Object.keys(updates).length} field${Object.keys(updates).length === 1 ? "" : "s"} changed).`,
      ephemeral: true,
    });
  },
};

export default editPlayerCommand;
