import { SlashCommandBuilder } from "discord.js";
import type { Command } from "./types.js";
import { requireAdminWithConfig } from "../commandGuards.js";
import { renderSchedule } from "../scheduleSync.js";

/**
 * /create-schedule — posts the week's Premier slots for the team to vote on.
 * Admin only (plan sections 11/55). A weekly-poll amendment to the plan's
 * single-match flow, requested 2026-10-03: see
 * docs/Plan_Amendment_Weekly_Schedule.md.
 *
 * `slots` is one text option: entries separated by commas, each a date and a
 * time — `sat 7pm, sun 7pm`, `25/06 19:00, 26/06 19:00`. Times are read in
 * the team's configured timezone (plan section 53) automatically.
 */
const data = new SlashCommandBuilder()
  .setName("create-schedule")
  .setDescription("Post the weekly Premier schedule for the team to vote on. Admin only.")
  .setDMPermission(false)
  .addStringOption((opt) =>
    opt
      .setName("slots")
      .setDescription('Slots, comma-separated: "sat 7pm, sun 7pm" or "25/06 19:00, 26/06 19:00" (max 10)')
      .setRequired(true),
  );

const createScheduleCommand: Command = {
  data,
  async execute(interaction, ctx) {
    const guard = await requireAdminWithConfig(interaction, ctx);
    if (!guard) return;

    const result = await ctx.services.schedules.create({ guildId: guard.guildId, slotsInput: interaction.options.getString("slots", true) });
    if (!result.ok) {
      await interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
      return;
    }
    const { poll, channelId } = result.value;

    // Post first, record the message id second: a Discord failure must not
    // leave a poll with no card (plan section 48) — discard it and say so.
    try {
      const view = (await ctx.services.schedules.getView(poll.id))!;
      const { content, embeds, components, suppressMentions, rosterIds } = await renderSchedule(ctx, view);
      // The roster is @mentioned in the text; this first post is the one that notifies them (and only them — nothing else in
      // the message can ping). Every later edit of the card suppresses mentions.
      const sent = await ctx.discord.sendChannelMessage(channelId, { content, embeds, components, suppressMentions, mentionUserIds: rosterIds });
      await ctx.services.schedules.recordMessage(poll.id, sent.id);
    } catch (err) {
      await ctx.services.schedules.discard(poll.id);
      ctx.logger.error(
        { event: "schedule.postFailed", guildId: guard.guildId, pollId: poll.id, err: err instanceof Error ? err.message : String(err) },
        "Posting the schedule failed — poll discarded",
      );
      await interaction.reply({ content: "❌ I couldn't post the schedule in the match channel. Check my permissions there and try again.", ephemeral: true });
      return;
    }

    ctx.logger.info({ event: "schedule.created", guildId: guard.guildId, pollId: poll.id, slots: result.value.slots.length }, "Weekly schedule posted");
    await interaction.reply({
      content: `✅ **Schedule #${poll.id} posted** in <#${channelId}> with ${result.value.slots.length} slot${result.value.slots.length === 1 ? "" : "s"}.\nSet a queue time with \`/schedule-slot\`.`,
      ephemeral: true,
    });
  },
};

export default createScheduleCommand;
