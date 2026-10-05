import type { AppContext } from "../../appContext.js";
import type { ServerConfigRow } from "../../database/schema/serverConfig.js";
import type { DueSlotReminder } from "../../database/repositories/scheduleRepository.js";
import { planReminders } from "../../modules/reminders/reminderScheduling.js";
import { effectiveAt, pickLeadingSlot, shouldRemind } from "../../modules/schedules/scheduleLogic.js";
import { buildSlotReminderMessage } from "../../modules/schedules/scheduleMessage.js";

export interface ScheduleReminderSummary {
  slotRemindersSent: number;
  slotRemindersSkipped: number;
  slotRemindersFailed: number;
}

/**
 * The weekly schedule's reminders — run by every reminder cron tick (see
 * reminderCronJob.ts). Same three phases and the same claim-before-send
 * idempotency as the single-match reminders (plan sections 13 and 50):
 *
 * 1. Reconcile: every upcoming slot of every OPEN poll gets its reminder rows
 *    (offsets from server_config.reminder_schedule_minutes — 5h and 15min by
 *    default — counted back from the slot's *queue* time when the admin set
 *    one, else its time). Idempotent; a queue-time edit just moves the
 *    PENDING rows.
 * 2. Skip what can never apply: pending reminders of cancelled polls.
 * 3. Send what's due. For each due reminder, in order:
 *      - the slot already started                    -> SKIPPED
 *      - a *later* reminder for the same slot is also due (the poll was made
 *        late, or the cron was down) -> the earlier one is SKIPPED, so the team
 *        gets one accurate "15 MINUTES" instead of a stale "5 HOURS"
 *      - the slot isn't the one we're playing (not the highest-voted slot with
 *        5+ votes, and not forced ALWAYS)         -> SKIPPED
 *      - nobody voted for it                       -> SKIPPED
 *      - otherwise post the reminder, pinging the slot's voters.
 *    A Discord failure reverts the reminder to PENDING so the next tick
 *    retries (plan section 48), exactly like the match reminders.
 *
 * "Is this slot the one?" is decided at send time from the live votes, so a
 * slot that lost its squad after the poll was posted doesn't get a reminder.
 */
export async function runScheduleReminders(ctx: AppContext, configs: ServerConfigRow[], now: Date): Promise<ScheduleReminderSummary> {
  const repo = ctx.repositories.schedules;
  const summary: ScheduleReminderSummary = { slotRemindersSent: 0, slotRemindersSkipped: 0, slotRemindersFailed: 0 };

  for (const config of configs) {
    for (const poll of await repo.listOpenPolls(config.guildId)) {
      const view = await repo.getView(poll.id);
      if (!view) continue;
      for (const slot of view.slots) {
        if (effectiveAt(slot).getTime() <= now.getTime()) continue;
        await repo.reconcileSlotReminders(slot.id, planReminders(effectiveAt(slot), config.reminderScheduleMinutes));
      }
    }
  }
  summary.slotRemindersSkipped += await repo.skipPendingForCancelledPolls();

  const due = await repo.findDueSlotReminders(now);
  // Per slot, the closest-to-start reminder that is due right now is the only one worth sending.
  const smallestDueOffset = new Map<number, number>();
  for (const d of due) {
    smallestDueOffset.set(d.slot.id, Math.min(smallestDueOffset.get(d.slot.id) ?? Infinity, d.reminder.offsetMinutes));
  }

  const viewCache = new Map<number, Awaited<ReturnType<typeof repo.getView>>>();
  const rosterCache = new Map<string, Awaited<ReturnType<typeof ctx.repositories.players.listActivePlayersByGuild>>>();

  const process = async ({ reminder, slot, poll }: DueSlotReminder) => {
    const claimed = await repo.claimReminder(reminder.id);
    if (!claimed) return; // another invocation won it

    try {
      const stale = effectiveAt(slot).getTime() <= now.getTime();
      const superseded = reminder.offsetMinutes > (smallestDueOffset.get(slot.id) ?? reminder.offsetMinutes);
      if (stale || superseded) {
        await repo.markReminderSkipped(claimed.id);
        summary.slotRemindersSkipped++;
        return;
      }

      if (!viewCache.has(poll.id)) viewCache.set(poll.id, await repo.getView(poll.id));
      const view = viewCache.get(poll.id);
      if (!view) {
        await repo.markReminderSkipped(claimed.id);
        summary.slotRemindersSkipped++;
        return;
      }
      const counts = new Map<number, number>();
      for (const v of view.votes) counts.set(v.slotId, (counts.get(v.slotId) ?? 0) + 1);
      const liveSlot = view.slots.find((s) => s.id === slot.id) ?? slot;
      const leader = pickLeadingSlot(view.slots, counts, now);
      const voters = view.votes.filter((v) => v.slotId === slot.id);

      if (!shouldRemind(liveSlot, leader?.id ?? null) || voters.length === 0) {
        await repo.markReminderSkipped(claimed.id);
        summary.slotRemindersSkipped++;
        ctx.logger.info(
          { event: "schedule.reminderSkipped", pollId: poll.id, slotId: slot.id, offsetMinutes: reminder.offsetMinutes, votes: voters.length, leader: leader?.id ?? null },
          "Slot reminder skipped — not the match we're playing",
        );
        return;
      }

      if (!rosterCache.has(poll.guildId)) rosterCache.set(poll.guildId, await ctx.repositories.players.listActivePlayersByGuild(poll.guildId));
      const customAgents = await repo.listCustomAgents(poll.guildId);
      const message = buildSlotReminderMessage(liveSlot, voters, rosterCache.get(poll.guildId)!, poll.timezone, reminder.offsetMinutes, poll.id, view.picks, customAgents);
      const sent = await ctx.discord.sendChannelMessage(poll.channelId, {
        content: message.content,
        embeds: message.embeds,
        suppressMentions: true,
        mentionUserIds: message.mentionUserIds,
      });
      await repo.markReminderSent(claimed.id, poll.channelId, sent.id);
      summary.slotRemindersSent++;
      ctx.logger.info({ event: "schedule.reminderSent", pollId: poll.id, slotId: slot.id, offsetMinutes: reminder.offsetMinutes, voters: voters.length }, "Slot reminder sent");
    } catch (err) {
      summary.slotRemindersFailed++;
      await repo.revertReminderToPending(claimed.id);
      ctx.logger.error(
        { event: "schedule.reminderFailed", pollId: poll.id, slotId: slot.id, offsetMinutes: reminder.offsetMinutes, err: err instanceof Error ? err.message : String(err) },
        "Slot reminder failed — reverted to PENDING for retry",
      );
    }
  };

  for (const d of due) await process(d);
  return summary;
}
