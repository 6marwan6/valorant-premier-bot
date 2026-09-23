import { and, eq, inArray, lte } from "drizzle-orm";
import type { Database } from "../client.js";
import { reminders, type ReminderRow } from "../schema/reminders.js";
import { matches, type MatchRow } from "../schema/matches.js";
import type { ReminderPlanEntry } from "../../modules/reminders/reminderScheduling.js";

export interface DueReminder {
  reminder: ReminderRow;
  match: MatchRow;
}

/**
 * Repository for the `reminders` table — plan section 13. Thin, like its
 * siblings (MatchRepository, AttendanceRepository): the actual
 * reconcile/claim/send orchestration lives in
 * services/scheduling/reminderCronJob.ts, this just exposes typed,
 * individually-idempotent operations on the table.
 */
export class ReminderRepository {
  constructor(private readonly db: Database) {}

  /**
   * Reconciles one match's reminder rows against its current plan
   * (modules/reminders/reminderScheduling.ts#planReminders).
   *
   * Per plan entry:
   *  - no row yet for this (match_id, offset_minutes) -> insert PENDING
   *  - a PENDING row exists -> refresh scheduled_at (the match may have
   *    been edited since the row was created — plan section 11's
   *    /edit-match)
   *  - a CLAIMED/SENT/SKIPPED row exists -> left untouched. Once a
   *    reminder has been claimed, sent, or explicitly skipped it's
   *    history (plan section 50: a retry — here, a later cron tick —
   *    must not re-send something already handled).
   *
   * Idempotent by construction: running this twice with the same match +
   * offsets is a no-op the second time. No explicit "does it already
   * exist" check is needed up front — each entry is its own
   * insert-or-conditionally-update.
   */
  async reconcileMatch(matchId: number, plan: ReminderPlanEntry[]): Promise<void> {
    for (const entry of plan) {
      await this.db
        .insert(reminders)
        .values({ matchId, offsetMinutes: entry.offsetMinutes, scheduledAt: entry.scheduledAt })
        .onConflictDoUpdate({
          target: [reminders.matchId, reminders.offsetMinutes],
          set: { scheduledAt: entry.scheduledAt, updatedAt: new Date() },
          // Postgres ON CONFLICT ... DO UPDATE ... WHERE: only overwrite
          // scheduled_at while the row is still PENDING. A CLAIMED/SENT/
          // SKIPPED row keeps its original scheduled_at as a historical
          // record of when it actually fired (or was claimed/skipped).
          setWhere: eq(reminders.status, "PENDING"),
        });
    }
  }

  /**
   * Plan section 15/50-style cleanup for the reminder side: once a match
   * is CANCELLED or COMPLETED, any reminder still PENDING for it will
   * never fire — mark it SKIPPED rather than leaving it to be picked up
   * (and rejected downstream) by the due-reminder query forever.
   * Returns the number of rows skipped, for cron-run logging.
   */
  async skipPendingForTerminalMatches(): Promise<number> {
    const result = await this.db
      .update(reminders)
      .set({ status: "SKIPPED", updatedAt: new Date() })
      .where(
        and(
          eq(reminders.status, "PENDING"),
          inArray(
            reminders.matchId,
            this.db.select({ id: matches.id }).from(matches).where(inArray(matches.status, ["CANCELLED", "COMPLETED"])),
          ),
        ),
      )
      .returning({ id: reminders.id });
    return result.length;
  }

  /** Every PENDING reminder whose time has come, for a match still eligible to receive it, earliest-due first. */
  async findDue(now: Date): Promise<DueReminder[]> {
    const rows = await this.db
      .select({ reminder: reminders, match: matches })
      .from(reminders)
      .innerJoin(matches, eq(reminders.matchId, matches.id))
      .where(
        and(
          eq(reminders.status, "PENDING"),
          lte(reminders.scheduledAt, now),
          inArray(matches.status, ["SCHEDULED", "CONFIRMATION_OPEN"]),
        ),
      )
      .orderBy(reminders.scheduledAt);
    return rows;
  }

  /**
   * Atomically claims a PENDING reminder before attempting to send it —
   * plan section 50: "A retry must not result in... duplicate reminder."
   * A single UPDATE...WHERE status='PENDING' means at most one concurrent
   * cron invocation can ever win this row; a second, overlapping
   * invocation (or a retried external-cron call) gets `undefined` back
   * and skips it. See reminderCronJob.ts for how the caller uses this.
   */
  async claim(id: number): Promise<ReminderRow | undefined> {
    const [row] = await this.db
      .update(reminders)
      .set({ status: "CLAIMED", updatedAt: new Date() })
      .where(and(eq(reminders.id, id), eq(reminders.status, "PENDING")))
      .returning();
    return row;
  }

  /** Commits a successful send. Only moves a CLAIMED row (see claim()) — never re-marks an already-SENT one. */
  async markSent(id: number, channelId: string, messageId: string): Promise<void> {
    await this.db
      .update(reminders)
      .set({ status: "SENT", sentAt: new Date(), discordChannelId: channelId, discordMessageId: messageId, updatedAt: new Date() })
      .where(and(eq(reminders.id, id), eq(reminders.status, "CLAIMED")));
  }

  /**
   * Reverts a failed send back to PENDING so the next cron tick retries
   * it — plan section 48's fail-safe posture ("AI request fails -> log
   * error -> do not modify state") applied to the reminder side: a
   * Discord-call failure after claiming must not silently drop the
   * reminder.
   */
  async revertToPending(id: number): Promise<void> {
    await this.db
      .update(reminders)
      .set({ status: "PENDING", updatedAt: new Date() })
      .where(and(eq(reminders.id, id), eq(reminders.status, "CLAIMED")));
  }

  /** Test/inspection helper — every reminder row for a match, in plan order. */
  async listByMatch(matchId: number): Promise<ReminderRow[]> {
    return this.db.select().from(reminders).where(eq(reminders.matchId, matchId)).orderBy(reminders.scheduledAt);
  }
}

export type { ReminderRow };
