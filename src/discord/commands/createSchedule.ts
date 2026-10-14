import { SlashCommandBuilder } from "discord.js";
import type { Command } from "./types.js";
import { requireAdminWithConfig } from "../commandGuards.js";
import { renderSchedule } from "../scheduleSync.js";
import { syncAgentBoard } from "../agentBoardSync.js";
import { MAPS } from "../../modules/agents/agentData.js";

/**
 * /create-schedule — posts the week's Premier slots for the team to vote on.
 * Admin only (plan sections 11/55). A weekly-poll amendment to the plan's
 * single-match flow, requested 2026-10-03: see
 * docs/Plan_Amendment_Weekly_Schedule.md.
 *
 * `slots` is one text option: entries separated by commas, each a date and a
 * time — `sat 7pm, sun 7pm`, `25/06 19:00, 26/06 19:00`. Times are read in
 * the team's configured timezone (plan section 53) automatically.
 *
 * `map` (optional, 2026-10-14) is the map this week's schedule is played on. It is stored on every
 * slot, so it shows on the card, the AGENT SELECT lineup and the reminders and drives the agent-pick
 * panel's suggested comps from the first vote. `/schedule-slot map:` still changes one slot later.
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
  )
  .addStringOption((opt) =>
    opt
      .setName("map")
      .setDescription("The map this schedule is played on (optional — drives the suggested comps)")
      .addChoices(...MAPS.map((m) => ({ name: m, value: m }))),
  );

const createScheduleCommand: Command = {
  data,
  async execute(interaction, ctx) {
    const guard = await requireAdminWithConfig(interaction, ctx);
    if (!guard) return;

    const result = await ctx.services.schedules.create({
      guildId: guard.guildId,
      slotsInput: interaction.options.getString("slots", true),
      mapInput: interaction.options.getString("map") ?? undefined,
    });
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
      // The public AGENT SELECT lineup goes right under the card (best-effort: never fails the command).
      await syncAgentBoard(ctx, view);
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
    const mapLine = result.value.slots[0]?.map ? `\n🗺️ Map: **${result.value.slots[0].map}** (change a slot with \`/schedule-slot map:\`).` : "\n🗺️ Map: not decided yet — set it with `/schedule-slot map:`.";
    await interaction.reply({
      content: `✅ **Schedule #${poll.id} posted** in <#${channelId}> with ${result.value.slots.length} slot${result.value.slots.length === 1 ? "" : "s"}.${mapLine}\nSet a queue time with \`/schedule-slot\`.`,
      ephemeral: true,
    });
  },
};

export default createScheduleCommand;
