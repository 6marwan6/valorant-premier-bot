import type { AppContext } from "../../appContext.js";
import { planReminders } from "../../modules/reminders/reminderScheduling.js";
import { buildReminderNudgeMessage } from "../../modules/reminders/reminderMessages.js";
import { buildRosterMessage } from "../../modules/attendance/rosterMessage.js";

export interface ReminderCronSummary {
  guildsProcessed: number;
  matchesReconciled: number;
  remindersSkippedTerminal: number;
  remindersSent: number;
  remindersFailed: number;
}

/**
 * One full cron tick — plan section 13 "Reminder System" + section 59
 * Phase 4. Three phases, run in this order every invocation:
 *
 * 1. **Reconcile**: for every match still eligible (SCHEDULED or
 *    CONFIRMATION_OPEN) in every configured guild, make sure its
 *    reminder rows match its current plan (offsets from
 *    server_config.reminder_schedule_minutes against its current
 *    scheduled_at). Cheap and idempotent (ReminderRepository.
 *    reconcileMatch) — this is what makes the whole system self-healing:
 *    if a previous tick crashed mid-way, or a match was edited, the very
 *    next tick just fixes it, no special-case recovery code needed.
 * 2. **Clean up terminal matches**: a match CANCELLED or COMPLETED since
 *    the last tick may still have PENDING reminders that will never fire
 *    correctly — mark them SKIPPED.
 * 3. **Send what's due**: claim (plan section 50 idempotency — see
 *    ReminderRepository.claim) and send every PENDING reminder whose time
 *    has passed. The earliest-due reminder for a SCHEDULED match is the
 *    one that opens it for confirmation (absorbing what /post-match used
 *    to do manually — see that command's doc comment); every later
 *    reminder for the same match is a short nudge instead.
 *
 * This function has no Discord/HTTP awareness of its own — api/cron/
 * reminders.ts is the thin Vercel entry point that authenticates the
 * request and calls this.
 */
export async function runReminderCronJob(ctx: AppContext, now: Date = new Date()): Promise<ReminderCronSummary> {
  const configs = await ctx.repositories.serverConfig.listAll();

  let matchesReconciled = 0;
  for (const config of configs) {
    const activeMatches = await ctx.repositories.matches.listByGuildAndStatuses(config.guildId, [
      "SCHEDULED",
      "CONFIRMATION_OPEN",
    ]);
    for (const match of activeMatches) {
      const plan = planReminders(match.scheduledAt, config.reminderScheduleMinutes);
      await ctx.repositories.reminders.reconcileMatch(match.id, plan);
      matchesReconciled++;
    }
  }

  const remindersSkippedTerminal = await ctx.repositories.reminders.skipPendingForTerminalMatches();

  const due = await ctx.repositories.reminders.findDue(now);
  let remindersSent = 0;
  let remindersFailed = 0;
  // Tracks matches opened by an announcement reminder earlier in *this*
  // tick, keyed to the channel/message that announcement actually landed
  // in — needed because `match` in `due` is a snapshot taken once before
  // the loop starts, so a later reminder for the same match in the same
  // tick would otherwise still see the pre-announcement
  // announcementChannelId (null) even though the DB row was just updated
  // moments ago (plan section 60: "late match creation" can leave several
  // offsets simultaneously due in one tick).
  const openedThisTick = new Map<number, { channelId: string; messageId: string }>();

  for (const { reminder, match } of due) {
    const claimed = await ctx.repositories.reminders.claim(reminder.id);
    if (!claimed) continue; // another invocation already won this reminder

    const openedNow = openedThisTick.get(match.id);
    const alreadyOpen = Boolean(openedNow) || match.status === "CONFIRMATION_OPEN";

    try {
      if (!alreadyOpen) {
        const prepared = await ctx.services.attendance.prepareAnnouncement(match.guildId, match.id);
        if (!prepared.ok) throw new Error(prepared.error);

        const { content, components } = buildRosterMessage({ ...match, status: "CONFIRMATION_OPEN" }, []);
        const sent = await ctx.discord.sendChannelMessage(prepared.value.channelId, { content, components });
        await ctx.services.attendance.recordAnnouncement(match.id, prepared.value.channelId, sent.id);
        await ctx.repositories.reminders.markSent(claimed.id, prepared.value.channelId, sent.id);
        openedThisTick.set(match.id, { channelId: prepared.value.channelId, messageId: sent.id });

        ctx.logger.info(
          { event: "reminder.announcementSent", matchId: match.id, reminderId: reminder.id, offsetMinutes: reminder.offsetMinutes },
          "Reminder opened match for confirmation",
        );
      } else {
        const channelId = openedNow?.channelId ?? match.announcementChannelId;
        if (!channelId) throw new Error("Match is open but has no announcement channel on record");

        const attendanceRows = await ctx.repositories.attendance.listByMatch(match.id);
        const content = buildReminderNudgeMessage(match, attendanceRows, reminder.offsetMinutes);
        const sent = await ctx.discord.sendChannelMessage(channelId, { content });
        await ctx.repositories.reminders.markSent(claimed.id, channelId, sent.id);

        ctx.logger.info(
          { event: "reminder.nudgeSent", matchId: match.id, reminderId: reminder.id, offsetMinutes: reminder.offsetMinutes },
          "Reminder nudge sent",
        );
      }
      remindersSent++;
    } catch (err) {
      remindersFailed++;
      // Plan section 48's fail-safe posture, applied to the reminder
      // side: never leave a claimed-but-unsent reminder stuck — put it
      // back so the next tick retries. If the underlying cause (e.g. no
      // match_channel configured) isn't fixed by then, this just repeats
      // — self-healing once an admin fixes it, visible in logs until
      // they do, never silently dropped.
      await ctx.repositories.reminders.revertToPending(claimed.id);
      ctx.logger.error(
        {
          event: "reminder.failed",
          matchId: match.id,
          reminderId: reminder.id,
          offsetMinutes: reminder.offsetMinutes,
          err: err instanceof Error ? err.message : String(err),
        },
        "Reminder send failed — reverted to PENDING for retry",
      );
    }
  }

  return {
    guildsProcessed: configs.length,
    matchesReconciled,
    remindersSkippedTerminal,
    remindersSent,
    remindersFailed,
  };
}
