import { SlashCommandBuilder } from "discord.js";
import type { Command } from "./types.js";
import { requireAdminWithConfig } from "../commandGuards.js";
import { PLAYER_ROLE_CHOICES, parseCommaSeparatedList, validatePreferredAgent } from "../../modules/players/playerValidation.js";
import type { PlayerRow } from "../../database/schema/players.js";

/**
 * /add-player — plan section 41 "Admin Commands" / section 8 "Player
 * System" / section 9 "Player AI Configuration" (Phase 5).
 *
 * AI settings (personal references, running jokes, etc. — section 9) are
 * NOT options here: every new player starts with them all enabled and no
 * protected topics, matching section 9's own example ("Personal
 * references: enabled", "Running jokes: enabled", ...). Fine-tuning a
 * specific player's settings — including turning any of these off, or
 * adding protected topics — is /edit-player's job (a single command with
 * ~11 optional fields reads far better than an /add-player with the same
 * ~11 options, most of which every admin would leave at the default
 * anyway).
 */
const data = new SlashCommandBuilder()
  .setName("add-player")
  .setDescription("Register a team member's Premier profile. Admin only.")
  .setDMPermission(false)
  .addUserOption((opt) => opt.setName("player").setDescription("The Discord user to register").setRequired(true))
  .addStringOption((opt) =>
    opt
      .setName("role")
      .setDescription("Their Valorant role")
      .setRequired(true)
      .addChoices(...PLAYER_ROLE_CHOICES.map((c) => ({ name: c.name, value: c.value }))),
  )
  .addStringOption((opt) =>
    opt
      .setName("agents")
      .setDescription('Agents they play, comma-separated (e.g. "Jett, Raze, Neon")')
      .setRequired(true),
  )
  .addStringOption((opt) =>
    opt.setName("preferred_agent").setDescription("Their main pick from the agents list above").setRequired(false),
  )
  .addIntegerOption((opt) =>
    opt
      .setName("roast_intensity")
      .setDescription("0-100, defaults to this server's configured default")
      .setMinValue(0)
      .setMaxValue(100)
      .setRequired(false),
  );

const addPlayerCommand: Command = {
  data,
  async execute(interaction, ctx) {
    const guard = await requireAdminWithConfig(interaction, ctx);
    if (!guard) return;

    const target = interaction.options.getUser("player", true);
    const role = interaction.options.getString("role", true) as PlayerRow["role"];
    const agentsRaw = interaction.options.getString("agents", true);
    const preferredAgentRaw = interaction.options.getString("preferred_agent");
    const roastIntensity = interaction.options.getInteger("roast_intensity") ?? guard.config.defaultRoastIntensity;

    const parsedAgents = parseCommaSeparatedList(agentsRaw, "agent");
    if (!parsedAgents.ok) {
      await interaction.reply({ content: `❌ ${parsedAgents.error}`, ephemeral: true });
      return;
    }

    let preferredAgent: string | null = null;
    if (preferredAgentRaw) {
      const error = validatePreferredAgent(preferredAgentRaw, parsedAgents.values);
      if (error) {
        await interaction.reply({ content: `❌ ${error}`, ephemeral: true });
        return;
      }
      preferredAgent = preferredAgentRaw.trim();
    }

    const { player, created } = await ctx.repositories.players.upsertByDiscordUserId(guard.guildId, target.id, {
      displayName: target.displayName,
      role,
      agents: parsedAgents.values,
      preferredAgent,
      roastIntensity,
      // New/re-added players start fully opted in with no protected
      // topics — plan section 9's own example, and see this file's doc
      // comment for why that's not an option here.
      personalReferencesEnabled: true,
      runningJokesEnabled: true,
      valorantReferencesEnabled: true,
      matchHistoryReferencesEnabled: true,
      memoryUsageEnabled: true,
      aiFollowUpsEnabled: true,
      protectedTopics: [],
    });

    ctx.logger.info(
      { event: created ? "player.added" : "player.reAdded", guildId: guard.guildId, discordUserId: target.id },
      created ? "Player added" : "Player re-added (profile already existed)",
    );

    const verb = created ? "✅ **Added**" : "✅ **Updated & reactivated**";
    const lines = [
      `${verb} <@${target.id}> to the roster.`,
      `• Role: ${player.role}`,
      `• Agents: ${player.agents.join(", ")}`,
      `• Preferred agent: ${player.preferredAgent ?? "_not set_"}`,
      `• Roast intensity: ${player.roastIntensity}`,
    ];
    await interaction.reply({ content: lines.join("\n"), ephemeral: true });
  },
};

export default addPlayerCommand;
