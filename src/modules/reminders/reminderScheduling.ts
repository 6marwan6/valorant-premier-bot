/**
 * Pure reminder-timing logic — no database, no Discord. Kept standalone
 * specifically so plan section 60's "timezone conversion" /
 * DST-transition unit-test target and section 13's "duplicate prevention"
 * intent can be exercised without a database, the same reasoning
 * matchLifecycle.ts documents for match-state transitions.
 */

export interface ReminderPlanEntry {
  offsetMinutes: number;
  scheduledAt: Date;
}

/**
 * What reminder rows *should* exist for a match right now, given the
 * guild's configured offsets (server_config.reminder_schedule_minutes,
 * plan section 13's example: [180, 60, 15]).
 *
 * `matchScheduledAt` is already an absolute UTC instant (resolved once,
 * correctly, by modules/matches/dateTime.ts at match-creation time) —
 * subtracting a fixed number of minutes from an absolute instant needs no
 * further timezone/DST handling. A match scheduled the evening of a DST
 * transition gets reminders exactly N minutes before it in absolute
 * terms; their *displayed* local time (if ever shown) would correctly
 * reflect the post-transition offset. DST only mattered once, when the
 * admin's wall-clock Date/Time input was resolved to that instant in the
 * first place — see tests/unit/dateTime.test.ts for that coverage.
 *
 * Offsets are de-duplicated and sorted descending (largest offset first
 * = furthest before kickoff = fires soonest chronologically), so
 * `planReminders(...)[0]` is always the reminder that should trigger the
 * match announcement (plan sections 14/61 — "posted... three hours
 * before kickoff").
 */
export function planReminders(matchScheduledAt: Date, offsetsMinutes: readonly number[]): ReminderPlanEntry[] {
  const uniqueOffsets = [...new Set(offsetsMinutes)].filter((m) => Number.isFinite(m) && m > 0);
  return uniqueOffsets
    .sort((a, b) => b - a)
    .map((offsetMinutes) => ({
      offsetMinutes,
      scheduledAt: new Date(matchScheduledAt.getTime() - offsetMinutes * 60_000),
    }));
}

/**
 * Human label for a reminder's offset — used in the nudge message text
 * (reminderMessages.ts). Not stored (see reminders.ts schema doc for why
 * `type` became `offsetMinutes`); computed fresh whenever a reminder is
 * about to be sent.
 */
export function formatOffsetLabel(offsetMinutes: number): string {
  if (offsetMinutes % 60 === 0) {
    const hours = offsetMinutes / 60;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  if (offsetMinutes < 60) {
    return `${offsetMinutes} minutes`;
  }
  const hours = Math.floor(offsetMinutes / 60);
  const mins = offsetMinutes % 60;
  return `${hours}h ${mins}m`;
}
