import { SlashCommandBuilder } from "discord.js";
import type { Command } from "./types.js";
import { requireAdminWithConfig } from "../commandGuards.js";
import { syncScheduleMessage } from "../scheduleSync.js";
import { formatSlotDay, formatSlotTime } from "../../modules/schedules/scheduleLogic.js";
import type { SlotRemindMode } from "../../database/schema/schedules.js";

/**
 * /schedule-slot — the admin's per-slot controls on the current schedule.
 *
 * `queue` is the "additional time edit": 5 people voted Saturday 7pm but the
 * team is queuing at 7:30 → `/schedule-slot slot:1 queue:19:30`. The 5h /
 * 15min reminders then count back from 19:30 and say so. `queue:clear` goes
 * back to the slot time.
 *
 * `reminders` overrides which slot the reminders are for. Default (auto):
 * the highest-voted slot with at least 5 votes. `always` also reminds a slot
 * that isn't leading (e.g. playing two matches this week), `never` silences one.
 */
const data = new SlashCommandBuilder()
  .setName("schedule-slot")
  .setDescription("Set a slot's queue time or reminder behaviour on the current schedule. Admin only.")
  .setDMPermission(false)
  .addIntegerOption((opt) => opt.setName("slot").setDescription("The slot number shown on the schedule (1, 2, 3 …)").setMinValue(1).setMaxValue(10).setRequired(true))
  .addStringOption((opt) => opt.setName("queue").setDescription('When you actually queue, e.g. "19:30" or "7:30pm" — or "clear"'))
  .addStringOption((opt) =>
    opt
      .setName("reminders")
      .setDescription("Which slot gets the 5h/15min reminders")
      .addChoices(
        { name: "auto — only the top-voted slot with 5+ votes (default)", value: "AUTO" },
        { name: "always — remind this slot too", value: "ALWAYS" },
        { name: "never — no reminders for this slot", value: "NEVER" },
      ),
  );

const scheduleSlotCommand: Command = {
  data,
  async execute(interaction, ctx) {
    const guard = await requireAdminWithConfig(interaction, ctx);
    if (!guard) return;

    const queueInput = interaction.options.getString("queue") ?? undefined;
    const remindMode = (interaction.options.getString("reminders") as SlotRemindMode | null) ?? undefined;
    const result = await ctx.services.schedules.editSlot({
      guildId: guard.guildId,
      position: interaction.options.getInteger("slot", true),
      queueInput,
      remindMode,
    });
    if (!result.ok) {
      await interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
      return;
    }

    const { view, slot } = result.value;
    await syncScheduleMessage(ctx, view);
    const tz = view.poll.timezone;
    const label = `${formatSlotDay(slot.scheduledAt, tz)} ${formatSlotTime(slot.scheduledAt, tz)}`;
    const lines = [`✅ **Slot ${slot.position} (${label}) updated.**`];
    lines.push(slot.queueAt ? `🎮 Queue time: **${formatSlotTime(slot.queueAt, tz)}** — reminders count back from it.` : "🎮 Queue time: the slot time.");
    lines.push(`⏰ Reminders: **${slot.remindMode.toLowerCase()}**`);
    await interaction.reply({ content: lines.join("\n"), ephemeral: true });
  },
};

export default scheduleSlotCommand;
