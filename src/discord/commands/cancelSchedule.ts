import { SlashCommandBuilder } from "discord.js";
import type { Command } from "./types.js";
import { requireAdminWithConfig } from "../commandGuards.js";
import { syncScheduleMessage } from "../scheduleSync.js";

/** /cancel-schedule — cancels the current weekly schedule: buttons removed, reminders stop. Admin only (plan sections 41/55). */
const data = new SlashCommandBuilder()
  .setName("cancel-schedule")
  .setDescription("Cancel the current weekly schedule. Admin only.")
  .setDMPermission(false);

const cancelScheduleCommand: Command = {
  data,
  async execute(interaction, ctx) {
    const guard = await requireAdminWithConfig(interaction, ctx);
    if (!guard) return;

    const result = await ctx.services.schedules.cancel(guard.guildId);
    if (!result.ok) {
      await interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
      return;
    }
    await syncScheduleMessage(ctx, result.value.view);
    ctx.logger.info({ event: "schedule.cancelled", guildId: guard.guildId, pollId: result.value.view.poll.id }, "Weekly schedule cancelled");
    await interaction.reply({ content: `✅ **Schedule #${result.value.view.poll.id} cancelled.** Reminders for it will not be sent.`, ephemeral: true });
  },
};

export default cancelScheduleCommand;
