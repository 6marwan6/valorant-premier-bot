import { and, asc, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import {
  agentPicks,
  customAgents,
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
  type AgentPickRow,
  type CustomAgentRow,
} from "../schema/schedules.js";
import type { PlayerRow } from "../schema/players.js";
import type { ReminderPlanEntry } from "../../modules/reminders/reminderScheduling.js";

/** A poll with everything the card and the rules need: its slots in display order, and who voted / declined. */
export interface ScheduleView {
  poll: SchedulePollRow;
  slots: ScheduleSlotRow[];
  votes: ScheduleVoteRow[];
  declines: ScheduleDeclineRow[];
  /** Who plays which agent in which slot (see schema/schedules.ts agentPicks). */
  picks: AgentPickRow[];
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
    const [slots, votes, declines, picks] = await Promise.all([
      this.db.select().from(scheduleSlots).where(eq(scheduleSlots.pollId, pollId)).orderBy(asc(scheduleSlots.position)),
      this.db.select().from(scheduleVotes).where(eq(scheduleVotes.pollId, pollId)).orderBy(asc(scheduleVotes.createdAt), asc(scheduleVotes.id)),
      this.db.select().from(scheduleDeclines).where(eq(scheduleDeclines.pollId, pollId)).orderBy(asc(scheduleDeclines.createdAt), asc(scheduleDeclines.id)),
      this.db
        .select({ pick: agentPicks })
        .from(agentPicks)
        .innerJoin(scheduleSlots, eq(agentPicks.slotId, scheduleSlots.id))
        .where(eq(scheduleSlots.pollId, pollId))
        .orderBy(asc(agentPicks.id))
        .then((rows) => rows.map((r) => r.pick)),
    ]);
    return { poll, slots, votes, declines, picks };
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
      if (removed.length > 0) {
        // Taking back your vote gives the agent back: a pick only exists for someone who is in the slot.
        await tx.delete(agentPicks).where(and(eq(agentPicks.slotId, params.slotId), eq(agentPicks.discordUserId, params.discordUserId)));
        return "removed";
      }

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
      await tx
        .delete(agentPicks)
        .where(
          and(
            eq(agentPicks.discordUserId, params.discordUserId),
            inArray(agentPicks.slotId, tx.select({ id: scheduleSlots.id }).from(scheduleSlots).where(eq(scheduleSlots.pollId, params.pollId))),
          ),
        );
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

  async updateSlot(slotId: number, changes: { queueAt?: Date | null; remindMode?: SlotRemindMode; map?: string | null }): Promise<ScheduleSlotRow | undefined> {
    const set: Partial<typeof scheduleSlots.$inferInsert> = {};
    if (changes.queueAt !== undefined) set.queueAt = changes.queueAt;
    if (changes.remindMode !== undefined) set.remindMode = changes.remindMode;
    if (changes.map !== undefined) set.map = changes.map;
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

  // ---- agent picks and custom agents (2026-10-04) ----

  async getSlot(slotId: number): Promise<ScheduleSlotRow | undefined> {
    const [row] = await this.db.select().from(scheduleSlots).where(eq(scheduleSlots.id, slotId)).limit(1);
    return row;
  }

  /**
   * Gives `discordUserId` the agent for this slot, replacing whatever they held. An agent can be held by one player
   * per slot (Valorant has no duplicate agents on a team): if someone else has it nothing changes and the holder is
   * returned. Two players grabbing the same agent at once is settled by the unique index, never by luck.
   */
  async pickAgent(params: { slotId: number; discordUserId: string; agentKey: string }): Promise<{ ok: true; changed: boolean } | { ok: false; takenBy: string }> {
    const holderOf = async () => {
      const [row] = await this.db.select().from(agentPicks).where(and(eq(agentPicks.slotId, params.slotId), eq(agentPicks.agentKey, params.agentKey))).limit(1);
      return row;
    };
    try {
      return await this.db.transaction(async (tx) => {
        const [held] = await tx.select().from(agentPicks).where(and(eq(agentPicks.slotId, params.slotId), eq(agentPicks.agentKey, params.agentKey))).limit(1);
        if (held) return held.discordUserId === params.discordUserId ? { ok: true as const, changed: false } : { ok: false as const, takenBy: held.discordUserId };
        await tx.delete(agentPicks).where(and(eq(agentPicks.slotId, params.slotId), eq(agentPicks.discordUserId, params.discordUserId)));
        await tx.insert(agentPicks).values({ slotId: params.slotId, discordUserId: params.discordUserId, agentKey: params.agentKey });
        return { ok: true as const, changed: true };
      });
    } catch (err) {
      const code = (err as { code?: string; cause?: { code?: string } })?.cause?.code ?? (err as { code?: string })?.code;
      if (code !== "23505") throw err;
      // Lost a race on the unique index: someone else got there first.
      const holder = await holderOf();
      if (holder && holder.discordUserId !== params.discordUserId) return { ok: false, takenBy: holder.discordUserId };
      return { ok: true, changed: false };
    }
  }

  async clearPick(slotId: number, discordUserId: string): Promise<boolean> {
    const rows = await this.db
      .delete(agentPicks)
      .where(and(eq(agentPicks.slotId, slotId), eq(agentPicks.discordUserId, discordUserId)))
      .returning({ id: agentPicks.id });
    return rows.length > 0;
  }

  async listPicksBySlot(slotId: number): Promise<AgentPickRow[]> {
    return this.db.select().from(agentPicks).where(eq(agentPicks.slotId, slotId)).orderBy(asc(agentPicks.id));
  }

  async listCustomAgents(guildId: string): Promise<CustomAgentRow[]> {
    return this.db.select().from(customAgents).where(eq(customAgents.guildId, guildId)).orderBy(asc(customAgents.id));
  }

  /** Inserts a player-suggested agent; undefined when that key already exists in this server (idempotent: a double-submitted modal adds one). */
  async createCustomAgent(row: Pick<CustomAgentRow, "guildId" | "key" | "displayName" | "role" | "suggestedByUserId" | "suggestedByName">): Promise<CustomAgentRow | undefined> {
    const [created] = await this.db.insert(customAgents).values(row).onConflictDoNothing().returning();
    return created;
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
