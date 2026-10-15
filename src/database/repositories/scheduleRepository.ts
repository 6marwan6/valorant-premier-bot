import { and, asc, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import {
  agentPicks,
  customAgents,
  scheduleAiReactions,
  scheduleDeclines,
  schedulePolls,
  scheduleVoteNudges,
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
  type VoteNudgeKind,
  type AgentPickKind,
} from "../schema/schedules.js";
import type { PlayerRow } from "../schema/players.js";
import type { ReminderPlanEntry } from "../../modules/reminders/reminderScheduling.js";

/** A poll with everything the card and the rules need: its slots in display order, and who voted / declined. */
export interface ScheduleView {
  poll: SchedulePollRow;
  slots: ScheduleSlotRow[];
  votes: ScheduleVoteRow[];
  declines: ScheduleDeclineRow[];
  /** Each player's MAIN and optional SECOND agent for the whole schedule (see schema/schedules.ts agentPicks). */
  picks: AgentPickRow[];
}

/** Outcome of ScheduleRepository.pickAgent. */
export type PickResult =
  | { ok: true; changed: boolean; /** MAIN only: the old main that moved to SECOND when the player picked their own second as main. */ swappedWith?: string }
  | { ok: false; reason: "TAKEN"; takenBy: string }
  | { ok: false; reason: "NEEDS_MAIN" | "SAME_AS_MAIN" };

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

  /**
   * Inserts a poll and its slots (earliest first, positions 1..n) atomically. `slotTimes` must already be sorted and distinct.
   * `map` (already canonical, from findMap) is stored on every slot; null/omitted = not decided yet.
   */
  async createPoll(params: { guildId: string; timezone: string; channelId: string; slotTimes: Date[]; map?: string | null }): Promise<{ poll: SchedulePollRow; slots: ScheduleSlotRow[] }> {
    return this.db.transaction(async (tx) => {
      const [poll] = await tx
        .insert(schedulePolls)
        .values({ guildId: params.guildId, timezone: params.timezone, channelId: params.channelId })
        .returning();
      const slots = await tx
        .insert(scheduleSlots)
        .values(params.slotTimes.map((scheduledAt, i) => ({ pollId: poll!.id, position: i + 1, scheduledAt, map: params.map ?? null })))
        .returning();
      return { poll: poll!, slots: slots.sort((a, b) => a.position - b.position) };
    });
  }

  async setMessageId(pollId: number, messageId: string): Promise<void> {
    await this.db.update(schedulePolls).set({ messageId, updatedAt: new Date() }).where(eq(schedulePolls.id, pollId));
  }

  /**
   * Takes the right to post the poll's AGENT SELECT lineup. One `UPDATE ... WHERE` so only one of several racing
   * callers wins; a claim older than `staleAfterMs` (a poster that crashed between claiming and posting) can be retaken.
   * Never wins once a message id is recorded.
   */
  async claimAgentBoardPost(pollId: number, now: Date = new Date(), staleAfterMs = 60_000): Promise<boolean> {
    const rows = await this.db
      .update(schedulePolls)
      .set({ agentBoardClaimedAt: now })
      .where(
        and(
          eq(schedulePolls.id, pollId),
          isNull(schedulePolls.agentBoardMessageId),
          sql`(${schedulePolls.agentBoardClaimedAt} IS NULL OR ${schedulePolls.agentBoardClaimedAt} < ${new Date(now.getTime() - staleAfterMs)})`,
        ),
      )
      .returning({ id: schedulePolls.id });
    return rows.length > 0;
  }

  /** Records the posted lineup message (clearing the claim), or forgets it (`null`) when someone deleted it in Discord. */
  async setAgentBoardMessageId(pollId: number, messageId: string | null): Promise<void> {
    await this.db.update(schedulePolls).set({ agentBoardMessageId: messageId, agentBoardClaimedAt: null }).where(eq(schedulePolls.id, pollId));
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
      this.db.select().from(agentPicks).where(eq(agentPicks.pollId, pollId)).orderBy(asc(agentPicks.id)),
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
        // The squad is per schedule, so picks go only when the player's *last* vote does: a pick exists for someone
        // who is in at least one slot.
        const [stillIn] = await tx
          .select({ id: scheduleVotes.id })
          .from(scheduleVotes)
          .where(and(eq(scheduleVotes.pollId, params.pollId), eq(scheduleVotes.discordUserId, params.discordUserId)))
          .limit(1);
        if (!stillIn) await tx.delete(agentPicks).where(and(eq(agentPicks.pollId, params.pollId), eq(agentPicks.discordUserId, params.discordUserId)));
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
      await tx.delete(agentPicks).where(and(eq(agentPicks.pollId, params.pollId), eq(agentPicks.discordUserId, params.discordUserId)));
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

  /** Claims one "you haven't voted" DM (of `kind`) for (poll, player). True only for the single caller that won it (plan section 50). */
  async claimVoteNudge(pollId: number, discordUserId: string, kind: VoteNudgeKind): Promise<boolean> {
    const rows = await this.db.insert(scheduleVoteNudges).values({ pollId, discordUserId, kind }).onConflictDoNothing().returning({ id: scheduleVoteNudges.id });
    return rows.length > 0;
  }

  async markVoteNudgeSent(pollId: number, discordUserId: string, kind: VoteNudgeKind): Promise<void> {
    await this.db
      .update(scheduleVoteNudges)
      .set({ sentAt: new Date() })
      .where(and(eq(scheduleVoteNudges.pollId, pollId), eq(scheduleVoteNudges.discordUserId, discordUserId), eq(scheduleVoteNudges.kind, kind)));
  }

  /** Gives the claim back after a *transient* failure so the next cron tick retries. (Closed DMs keep their claim — never retried.) */
  async releaseVoteNudge(pollId: number, discordUserId: string, kind: VoteNudgeKind): Promise<void> {
    await this.db
      .delete(scheduleVoteNudges)
      .where(and(eq(scheduleVoteNudges.pollId, pollId), eq(scheduleVoteNudges.discordUserId, discordUserId), eq(scheduleVoteNudges.kind, kind)));
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
   * Sets a player's MAIN or SECOND agent for the whole schedule (2026-10-15: one squad per schedule).
   *
   * - MAIN: one holder per agent per schedule (Valorant has no duplicate agents on a team) — if someone else has it
   *   nothing changes and the holder is returned. Choosing your own SECOND as your main swaps them: the old main
   *   becomes your second. Two players grabbing the same agent at once is settled by the unique index, never by luck.
   * - SECOND: a backup, so it may overlap with anyone's; it needs a MAIN first and can't be the same agent as it.
   */
  async pickAgent(params: { pollId: number; discordUserId: string; agentKey: string; kind: AgentPickKind }): Promise<PickResult> {
    const { pollId, discordUserId, agentKey, kind } = params;
    const mainHolder = async (client: Pick<Database, "select">) => {
      const [row] = await client.select().from(agentPicks).where(and(eq(agentPicks.pollId, pollId), eq(agentPicks.agentKey, agentKey), eq(agentPicks.kind, "MAIN"))).limit(1);
      return row;
    };
    try {
      return await this.db.transaction(async (tx): Promise<PickResult> => {
        const mine = await tx.select().from(agentPicks).where(and(eq(agentPicks.pollId, pollId), eq(agentPicks.discordUserId, discordUserId)));
        const myMain = mine.find((p) => p.kind === "MAIN");
        const mySecond = mine.find((p) => p.kind === "SECOND");

        if (kind === "SECOND") {
          if (!myMain) return { ok: false, reason: "NEEDS_MAIN" };
          if (myMain.agentKey === agentKey) return { ok: false, reason: "SAME_AS_MAIN" };
          if (mySecond?.agentKey === agentKey) return { ok: true, changed: false };
          if (mySecond) await tx.delete(agentPicks).where(eq(agentPicks.id, mySecond.id));
          await tx.insert(agentPicks).values({ pollId, discordUserId, agentKey, kind: "SECOND" });
          return { ok: true, changed: true };
        }

        const held = await mainHolder(tx);
        if (held) return held.discordUserId === discordUserId ? { ok: true, changed: false } : { ok: false, reason: "TAKEN", takenBy: held.discordUserId };
        // The pair the player ends up with: the new main, and a backup that is kept unless it is the agent that just
        // became the main (then the old main takes its place — a swap).
        const swapped = mySecond?.agentKey === agentKey && myMain ? myMain.agentKey : null;
        const keptSecond = swapped ?? (mySecond && mySecond.agentKey !== agentKey ? mySecond.agentKey : null);
        await tx.delete(agentPicks).where(and(eq(agentPicks.pollId, pollId), eq(agentPicks.discordUserId, discordUserId)));
        await tx.insert(agentPicks).values({ pollId, discordUserId, agentKey, kind: "MAIN" });
        if (keptSecond) await tx.insert(agentPicks).values({ pollId, discordUserId, agentKey: keptSecond, kind: "SECOND" });
        return { ok: true, changed: true, swappedWith: swapped ?? undefined };
      });
    } catch (err) {
      const code = (err as { code?: string; cause?: { code?: string } })?.cause?.code ?? (err as { code?: string })?.code;
      if (code !== "23505") throw err;
      // Lost a race on a unique index: someone else got the main agent first (or a double-delivered click already did this).
      if (kind === "MAIN") {
        const holder = await mainHolder(this.db);
        if (holder && holder.discordUserId !== discordUserId) return { ok: false, reason: "TAKEN", takenBy: holder.discordUserId };
      }
      return { ok: true, changed: false };
    }
  }

  /**
   * Clears a player's picks: `ALL` removes both (a SECOND can't outlive its MAIN), `SECOND` removes only the backup.
   * True when something was removed.
   */
  async clearPicks(pollId: number, discordUserId: string, scope: "ALL" | "SECOND"): Promise<boolean> {
    const rows = await this.db
      .delete(agentPicks)
      .where(and(eq(agentPicks.pollId, pollId), eq(agentPicks.discordUserId, discordUserId), scope === "SECOND" ? eq(agentPicks.kind, "SECOND") : undefined))
      .returning({ id: agentPicks.id });
    return rows.length > 0;
  }

  async listPicksByPoll(pollId: number): Promise<AgentPickRow[]> {
    return this.db.select().from(agentPicks).where(eq(agentPicks.pollId, pollId)).orderBy(asc(agentPicks.id));
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
