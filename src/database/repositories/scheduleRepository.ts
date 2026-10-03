import { and, asc, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import {
  scheduleAiReactions,
  scheduleDeclines,
  schedulePolls,
  scheduleSlots,
  scheduleVotes,
  slotReminders,
  type ScheduleDeclineRow,
  type SchedulePollRow,
  type ScheduleSlotRow,
  type ScheduleVoteRow,
  type SlotReminderRow,
  type SlotRemindMode,
  type ScheduleAiKind,
} from "../schema/schedules.js";
import type { ReminderPlanEntry } from "../../modules/reminders/reminderScheduling.js";

/** A poll with everything the card and the rules need: its slots in display order, and who voted / declined. */
export interface ScheduleView {
  poll: SchedulePollRow;
  slots: ScheduleSlotRow[];
  votes: ScheduleVoteRow[];
  declines: ScheduleDeclineRow[];
}

export interface DueSlotReminder {
  reminder: SlotReminderRow;
  slot: ScheduleSlotRow;
  poll: SchedulePollRow;
}

/**
 * Repository for the weekly schedule tables (schema/schedules.ts). Thin, like
 * its siblings: every method is one individually-idempotent operation; the
 * rules (who may vote, when, what a vote means) live in ScheduleService, and
 * the reminder orchestration in services/scheduling/scheduleReminderJob.ts.
 */
export class ScheduleRepository {
  constructor(private readonly db: Database) {}

  /** Inserts a poll and its slots (earliest first, positions 1..n) atomically. `slotTimes` must already be sorted and distinct. */
  async createPoll(params: { guildId: string; timezone: string; channelId: string; slotTimes: Date[] }): Promise<{ poll: SchedulePollRow; slots: ScheduleSlotRow[] }> {
    return this.db.transaction(async (tx) => {
      const [poll] = await tx
        .insert(schedulePolls)
        .values({ guildId: params.guildId, timezone: params.timezone, channelId: params.channelId })
        .returning();
      const slots = await tx
        .insert(scheduleSlots)
        .values(params.slotTimes.map((scheduledAt, i) => ({ pollId: poll!.id, position: i + 1, scheduledAt })))
        .returning();
      return { poll: poll!, slots: slots.sort((a, b) => a.position - b.position) };
    });
  }

  async setMessageId(pollId: number, messageId: string): Promise<void> {
    await this.db.update(schedulePolls).set({ messageId, updatedAt: new Date() }).where(eq(schedulePolls.id, pollId));
  }

  /** Removes a poll that never got its message (the post to Discord failed) so a retry starts clean. */
  async deletePoll(pollId: number): Promise<void> {
    await this.db.delete(schedulePolls).where(eq(schedulePolls.id, pollId));
  }

  async getPoll(pollId: number): Promise<SchedulePollRow | undefined> {
    const [row] = await this.db.select().from(schedulePolls).where(eq(schedulePolls.id, pollId)).limit(1);
    return row;
  }

  /** The newest OPEN poll — what /schedule-slot and /cancel-schedule act on. */
  async getLatestOpenPoll(guildId: string): Promise<SchedulePollRow | undefined> {
    const [row] = await this.db
      .select()
      .from(schedulePolls)
      .where(and(eq(schedulePolls.guildId, guildId), eq(schedulePolls.status, "OPEN")))
      .orderBy(desc(schedulePolls.id))
      .limit(1);
    return row;
  }

  async listOpenPolls(guildId: string): Promise<SchedulePollRow[]> {
    return this.db
      .select()
      .from(schedulePolls)
      .where(and(eq(schedulePolls.guildId, guildId), eq(schedulePolls.status, "OPEN")))
      .orderBy(asc(schedulePolls.id));
  }

  async getView(pollId: number): Promise<ScheduleView | undefined> {
    const poll = await this.getPoll(pollId);
    if (!poll) return undefined;
    const [slots, votes, declines] = await Promise.all([
      this.db.select().from(scheduleSlots).where(eq(scheduleSlots.pollId, pollId)).orderBy(asc(scheduleSlots.position)),
      this.db.select().from(scheduleVotes).where(eq(scheduleVotes.pollId, pollId)).orderBy(asc(scheduleVotes.createdAt), asc(scheduleVotes.id)),
      this.db.select().from(scheduleDeclines).where(eq(scheduleDeclines.pollId, pollId)).orderBy(asc(scheduleDeclines.createdAt), asc(scheduleDeclines.id)),
    ]);
    return { poll, slots, votes, declines };
  }

  /**
   * Toggles one player's vote for one slot. Removing is a single DELETE ...
   * RETURNING and adding is an INSERT ... ON CONFLICT DO NOTHING against the
   * (slot, player) unique index, so two racing clicks can never leave two
   * rows (plan sections 15/50). Voting for a slot also clears the player's
   * "can't play any day" mark — they just said they can play.
   */
  async toggleVote(params: { pollId: number; slotId: number; discordUserId: string; displayName: string }): Promise<"added" | "removed"> {
    return this.db.transaction(async (tx) => {
      const removed = await tx
        .delete(scheduleVotes)
        .where(and(eq(scheduleVotes.slotId, params.slotId), eq(scheduleVotes.discordUserId, params.discordUserId)))
        .returning({ id: scheduleVotes.id });
      if (removed.length > 0) return "removed";

      await tx
        .delete(scheduleDeclines)
        .where(and(eq(scheduleDeclines.pollId, params.pollId), eq(scheduleDeclines.discordUserId, params.discordUserId)));
      await tx
        .insert(scheduleVotes)
        .values({ pollId: params.pollId, slotId: params.slotId, discordUserId: params.discordUserId, discordDisplayName: params.displayName })
        .onConflictDoNothing();
      return "added";
    });
  }

  /**
   * Marks a player as unable to play any day: drops all their slot votes for
   * the poll and records the decline. A set, not a toggle — pressing it twice
   * is a no-op (`changed: false`); voting a slot is how they take it back.
   */
  async setDecline(params: { pollId: number; discordUserId: string; displayName: string }): Promise<{ changed: boolean }> {
    return this.db.transaction(async (tx) => {
      const removedVotes = await tx
        .delete(scheduleVotes)
        .where(and(eq(scheduleVotes.pollId, params.pollId), eq(scheduleVotes.discordUserId, params.discordUserId)))
        .returning({ id: scheduleVotes.id });
      const inserted = await tx
        .insert(scheduleDeclines)
        .values({ pollId: params.pollId, discordUserId: params.discordUserId, discordDisplayName: params.displayName })
        .onConflictDoNothing()
        .returning({ id: scheduleDeclines.id });
      return { changed: removedVotes.length > 0 || inserted.length > 0 };
    });
  }

  /**
   * Claims Mari's one reaction of this kind for this player in this poll.
   * True only for the caller that inserted the row — everyone else (a repeat
   * tap, a duplicate delivery) gets false and stays silent (plan section 50).
   */
  async claimAiReaction(pollId: number, discordUserId: string, kind: ScheduleAiKind): Promise<boolean> {
    const rows = await this.db
      .insert(scheduleAiReactions)
      .values({ pollId, discordUserId, kind })
      .onConflictDoNothing()
      .returning({ id: scheduleAiReactions.id });
    return rows.length > 0;
  }

  /** Atomically stamps the slot's first-quorum moment; true only for the one caller that won it (so the "MATCH ON" card posts once). */
  async claimQuorumAnnouncement(slotId: number): Promise<boolean> {
    const rows = await this.db
      .update(scheduleSlots)
      .set({ quorumAnnouncedAt: new Date() })
      .where(and(eq(scheduleSlots.id, slotId), isNull(scheduleSlots.quorumAnnouncedAt)))
      .returning({ id: scheduleSlots.id });
    return rows.length > 0;
  }

  async updateSlot(slotId: number, changes: { queueAt?: Date | null; remindMode?: SlotRemindMode }): Promise<ScheduleSlotRow | undefined> {
    const set: Partial<typeof scheduleSlots.$inferInsert> = {};
    if (changes.queueAt !== undefined) set.queueAt = changes.queueAt;
    if (changes.remindMode !== undefined) set.remindMode = changes.remindMode;
    if (Object.keys(set).length === 0) {
      const [row] = await this.db.select().from(scheduleSlots).where(eq(scheduleSlots.id, slotId)).limit(1);
      return row;
    }
    const [row] = await this.db.update(scheduleSlots).set(set).where(eq(scheduleSlots.id, slotId)).returning();
    return row;
  }

  async cancelPoll(pollId: number): Promise<void> {
    await this.db.update(schedulePolls).set({ status: "CANCELLED", updatedAt: new Date() }).where(eq(schedulePolls.id, pollId));
  }

  // ---- slot reminders (same reconcile / claim / send pattern as ReminderRepository, plan sections 13 & 50) ----

  /** Makes a slot's reminder rows match its plan; refreshes PENDING times (a queue-time edit moves them), leaves CLAIMED/SENT/SKIPPED rows alone. */
  async reconcileSlotReminders(slotId: number, plan: ReminderPlanEntry[]): Promise<void> {
    for (const entry of plan) {
      await this.db
        .insert(slotReminders)
        .values({ slotId, offsetMinutes: entry.offsetMinutes, scheduledAt: entry.scheduledAt })
        .onConflictDoUpdate({
          target: [slotReminders.slotId, slotReminders.offsetMinutes],
          set: { scheduledAt: entry.scheduledAt, updatedAt: new Date() },
          setWhere: eq(slotReminders.status, "PENDING"),
        });
    }
  }

  /** Pending reminders of a cancelled poll will never fire — mark them SKIPPED. */
  async skipPendingForCancelledPolls(): Promise<number> {
    const rows = await this.db
      .update(slotReminders)
      .set({ status: "SKIPPED", updatedAt: new Date() })
      .where(
        and(
          eq(slotReminders.status, "PENDING"),
          inArray(
            slotReminders.slotId,
            this.db
              .select({ id: scheduleSlots.id })
              .from(scheduleSlots)
              .innerJoin(schedulePolls, eq(scheduleSlots.pollId, schedulePolls.id))
              .where(eq(schedulePolls.status, "CANCELLED")),
          ),
        ),
      )
      .returning({ id: slotReminders.id });
    return rows.length;
  }

  async findDueSlotReminders(now: Date): Promise<DueSlotReminder[]> {
    return this.db
      .select({ reminder: slotReminders, slot: scheduleSlots, poll: schedulePolls })
      .from(slotReminders)
      .innerJoin(scheduleSlots, eq(slotReminders.slotId, scheduleSlots.id))
      .innerJoin(schedulePolls, eq(scheduleSlots.pollId, schedulePolls.id))
      .where(and(eq(slotReminders.status, "PENDING"), lte(slotReminders.scheduledAt, now), eq(schedulePolls.status, "OPEN")))
      .orderBy(asc(slotReminders.scheduledAt));
  }

  async claimReminder(id: number): Promise<SlotReminderRow | undefined> {
    const [row] = await this.db
      .update(slotReminders)
      .set({ status: "CLAIMED", updatedAt: new Date() })
      .where(and(eq(slotReminders.id, id), eq(slotReminders.status, "PENDING")))
      .returning();
    return row;
  }

  async markReminderSent(id: number, channelId: string, messageId: string): Promise<void> {
    await this.db
      .update(slotReminders)
      .set({ status: "SENT", sentAt: new Date(), discordChannelId: channelId, discordMessageId: messageId, updatedAt: new Date() })
      .where(and(eq(slotReminders.id, id), eq(slotReminders.status, "CLAIMED")));
  }

  /** A claimed reminder that turned out not to apply (slot isn't the leader, too stale, no voters) — history, not retried. */
  async markReminderSkipped(id: number): Promise<void> {
    await this.db
      .update(slotReminders)
      .set({ status: "SKIPPED", updatedAt: new Date() })
      .where(and(eq(slotReminders.id, id), eq(slotReminders.status, "CLAIMED")));
  }

  async revertReminderToPending(id: number): Promise<void> {
    await this.db
      .update(slotReminders)
      .set({ status: "PENDING", updatedAt: new Date() })
      .where(and(eq(slotReminders.id, id), eq(slotReminders.status, "CLAIMED")));
  }

  async listRemindersBySlot(slotId: number): Promise<SlotReminderRow[]> {
    return this.db.select().from(slotReminders).where(eq(slotReminders.slotId, slotId)).orderBy(asc(slotReminders.scheduledAt));
  }

  /** Vote count per slot for one poll, for callers that don't need the voter names. */
  async countVotesBySlot(pollId: number): Promise<Map<number, number>> {
    const rows = await this.db
      .select({ slotId: scheduleVotes.slotId, n: sql<number>`count(*)::int` })
      .from(scheduleVotes)
      .where(eq(scheduleVotes.pollId, pollId))
      .groupBy(scheduleVotes.slotId);
    return new Map(rows.map((r) => [r.slotId, r.n]));
  }
}
