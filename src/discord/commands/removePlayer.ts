import { SlashCommandBuilder } from "discord.js";
import type { Command } from "./types.js";
import { requireAdminWithConfig } from "../commandGuards.js";

/**
 * /remove-player — plan section 41 "Admin Commands". Soft-deletes (see
 * schema/players.ts / PlayerRepository.deactivate): the profile, its
 * settings, and its history stay in the database, they just stop
 * counting as part of the active roster — plan section 16's "No
 * response" section and `Confirmed: X/Y` denominator (Phase 5's
 * reconciliation of the Phase 3 debt) both read `active` players only.
 * Re-running `/add-player` for the same person reactivates the same row
 * instead of creating a duplicate.
 */
const data = new SlashCommandBuilder()
  .setName("remove-player")
  .setDescription("Remove a team member from the active roster. Admin only.")
  .setDMPermission(false)
  .addUserOption((opt) => opt.setName("player").setDescription("The Discord user to remove").setRequired(true));

const removePlayerCommand: Command = {
  data,
  async execute(interaction, ctx) {
    const guard = await requireAdminWithConfig(interaction, ctx);
    if (!guard) return;

    const target = interaction.options.getUser("player", true);
    const removed = await ctx.repositories.players.deactivate(guard.guildId, target.id);

    if (!removed) {
      await interaction.reply({
        content: `<@${target.id}> isn't currently on the active roster.`,
        ephemeral: true,
      });
      return;
    }

    ctx.logger.info(
      { event: "player.removed", guildId: guard.guildId, discordUserId: target.id },
      "Player removed from active roster",
    );

    await interaction.reply({
      content: `✅ Removed <@${target.id}> from the active roster. Their profile is kept and can be restored with \`/add-player\`.`,
      ephemeral: true,
    });
  },
};

export default removePlayerCommand;
