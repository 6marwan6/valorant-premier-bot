import { SlashCommandBuilder } from "discord.js";
import type { Command } from "./types.js";
import { requireAdminWithConfig } from "../commandGuards.js";
import type { MemoryRow } from "../../database/schema/memories.js";
import { MAX_MEMORY_CONTENT_LENGTH } from "../../modules/ai/aiOutput.js";

/** Plan section 22's exact nine, in the same order /memories groups them by. */
const MEMORY_TYPE_CHOICES: Array<{ name: string; value: MemoryRow["type"] }> = [
  { name: "Running joke", value: "RUNNING_JOKE" },
  { name: "Team joke", value: "TEAM_JOKE" },
  { name: "Valorant preference", value: "VALORANT_PREFERENCE" },
  { name: "Player preference", value: "PLAYER_PREFERENCE" },
  { name: "Personality trait", value: "PERSONALITY_TRAIT" },
  { name: "Habit", value: "HABIT" },
  { name: "Match event", value: "MATCH_EVENT" },
  { name: "Achievement", value: "ACHIEVEMENT" },
  { name: "Team history", value: "TEAM_HISTORY" },
];

/** Plan section 24, in the plan's own order. */
const VISIBILITY_CHOICES: Array<{ name: string; value: MemoryRow["visibility"] }> = [
  { name: "Public (default)", value: "PUBLIC" },
  { name: "Team", value: "TEAM" },
  { name: "Private", value: "PRIVATE" },
  { name: "Protected (never given to the AI)", value: "PROTECTED" },
];

/**
 * /add-memory — manual starter facts about players (2026-09-28), an admin
 * tool extending plan section 21's memory system to onboarding: seeding
 * lore the team already has (an existing running joke, a known
 * preference) instead of waiting for it to resurface in a conversation
 * Mari happens to be part of. See memoryService.ts's `createFromAdminEntry`
 * for the evidence/confidence/privacy reasoning — everything from there on
 * (retrieval, ranking, forbidden-topic filtering, /memories, the player's
 * own delete control) treats a memory created here exactly like any other.
 *
 * `visibility` defaults to PUBLIC when omitted (revised 2026-09-29 — plan
 * section 24's note): admin-entered lore exists so Mari can use it when she
 * talks to the person in the server, and a PRIVATE memory is never used
 * there. The admin can still narrow it explicitly (TEAM / PRIVATE /
 * PROTECTED) for anything sensitive.
 */
const data = new SlashCommandBuilder()
  .setName("add-memory")
  .setDescription("Add a manual starter fact about a player. Admin only.")
  .setDMPermission(false)
  .addUserOption((opt) => opt.setName("player").setDescription("The player this fact is about").setRequired(true))
  .addStringOption((opt) =>
    opt
      .setName("type")
      .setDescription("Which of the nine memory categories this fits")
      .setRequired(true)
      .addChoices(...MEMORY_TYPE_CHOICES),
  )
  .addStringOption((opt) =>
    opt
      .setName("content")
      .setDescription('The fact itself, third person (e.g. "Ahmed mains Jett and hates Cypher")')
      .setRequired(true)
      .setMaxLength(MAX_MEMORY_CONTENT_LENGTH),
  )
  .addStringOption((opt) =>
    opt
      .setName("visibility")
      .setDescription("Who/what this can be used with. Defaults to Public.")
      .setRequired(false)
      .addChoices(...VISIBILITY_CHOICES),
  );

const addMemoryCommand: Command = {
  data,
  async execute(interaction, ctx) {
    const guard = await requireAdminWithConfig(interaction, ctx);
    if (!guard) return;

    const target = interaction.options.getUser("player", true);
    const type = interaction.options.getString("type", true) as MemoryRow["type"];
    const content = interaction.options.getString("content", true).trim();
    const visibility = (interaction.options.getString("visibility") ?? "PUBLIC") as MemoryRow["visibility"];

    if (content.length === 0) {
      await interaction.reply({ content: "❌ The fact can't be empty.", ephemeral: true });
      return;
    }

    const player = await ctx.repositories.players.getByDiscordUserId(guard.guildId, target.id);
    if (!player) {
      await interaction.reply({
        content: `❌ ${target.username} isn't registered. Use \`/add-member\` (or \`/add-player\` for a Premier player) first.`,
        ephemeral: true,
      });
      return;
    }

    const memory = await ctx.services.memories.createFromAdminEntry({
      playerId: player.id,
      type,
      content,
      visibility,
      adminDiscordUserId: interaction.user.id,
    });

    ctx.logger.info(
      { event: "memory.adminEntry", playerId: player.id, memoryId: memory.id, type, visibility },
      "Admin-entered memory created",
    );

    await interaction.reply({
      content: `✅ Added a **${MEMORY_TYPE_CHOICES.find((c) => c.value === type)?.name ?? type}** memory for **${player.displayName}** (visibility: ${visibility}).`,
      ephemeral: true,
    });
  },
};

export default addMemoryCommand;
