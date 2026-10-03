import type { ScheduleRepository, ScheduleView } from "../../database/repositories/scheduleRepository.js";
import type { ServerConfigRepository } from "../../database/repositories/serverConfigRepository.js";
import type { PlayerRepository } from "../../database/repositories/playerRepository.js";
import type { SchedulePollRow, ScheduleSlotRow, ScheduleAiKind, SlotRemindMode } from "../../database/schema/schedules.js";
import { planReminders } from "../reminders/reminderScheduling.js";
import { effectiveAt, MIN_PLAYERS_TO_QUEUE, parseQueueInput, parseSlotsInput } from "./scheduleLogic.js";

export type ScheduleResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface VoteOutcome {
  view: ScheduleView;
  slot: ScheduleSlotRow;
  action: "added" | "removed";
  /** True for exactly one vote per slot: the one that first brought it to MIN_PLAYERS_TO_QUEUE (the caller posts the "squad locked" card). */
  reachedQuorum: boolean;
  /** Positions (1-based) of every slot the voter is now in, for the private confirmation. */
  yourPositions: number[];
}

/**
 * Orchestrates the weekly schedule (owner's request, 2026-10-03; see
 * docs/Plan_Amendment_Weekly_Schedule.md): decides whether an action is
 * allowed and updates the database. Discord calls (posting/editing the card)
 * stay in the command and button handlers, the same split MatchService and
 * AttendanceService use (plan section 7).
 */
export class ScheduleService {
  constructor(
    private readonly schedules: ScheduleRepository,
    private readonly serverConfig: ServerConfigRepository,
    private readonly players: PlayerRepository,
  ) {}

  /**
   * Validates and stores a new weekly poll — admin only (checked by the
   * command, plan section 11/55). Refuses while another poll still has an
   * upcoming slot, so two schedules never fight over the same reminders.
   * The caller posts the card, then records its message id; a failed post
   * must call `discard` so nothing half-created is left behind (plan 48).
   */
  async create(params: { guildId: string; slotsInput: string; now?: Date }): Promise<ScheduleResult<{ poll: SchedulePollRow; slots: ScheduleSlotRow[]; channelId: string }>> {
    const now = params.now ?? new Date();
    const config = await this.serverConfig.getByGuildId(params.guildId);
    if (!config?.matchChannelId) {
      return { ok: false, error: "Run `/setup` with a match_channel before posting a schedule." };
    }
    const parsed = parseSlotsInput(params.slotsInput, config.timezone, now);
    if (!parsed.ok) return { ok: false, error: parsed.error };

    for (const open of await this.schedules.listOpenPolls(params.guildId)) {
      const existing = await this.schedules.getView(open.id);
      if (existing?.slots.some((s) => effectiveAt(s).getTime() > now.getTime())) {
        return { ok: false, error: `Schedule #${open.id} is still open with upcoming slots. Run \`/cancel-schedule\` first, or use that one.` };
      }
    }

    const created = await this.schedules.createPoll({
      guildId: params.guildId,
      timezone: config.timezone,
      channelId: config.matchChannelId,
      slotTimes: parsed.slots,
    });
    return { ok: true, value: { ...created, channelId: config.matchChannelId } };
  }

  /** True exactly once per (poll, player, kind) — gates Mari's schedule reactions so toggling votes never spams the channel. */
  async claimAiReaction(pollId: number, discordUserId: string, kind: ScheduleAiKind): Promise<boolean> {
    return this.schedules.claimAiReaction(pollId, discordUserId, kind);
  }

  async recordMessage(pollId: number, messageId: string): Promise<void> {
    await this.schedules.setMessageId(pollId, messageId);
  }

  async discard(pollId: number): Promise<void> {
    await this.schedules.deletePoll(pollId);
  }

  async getView(pollId: number): Promise<ScheduleView | undefined> {
    return this.schedules.getView(pollId);
  }

  /** Common gate for a click: right server, poll still OPEN, voter is a registered player (once a roster exists). */
  private async gate(guildId: string, pollId: number, discordUserId: string): Promise<ScheduleResult<ScheduleView>> {
    const view = await this.schedules.getView(pollId);
    if (!view || view.poll.guildId !== guildId) return { ok: false, error: "This schedule no longer exists." };
    if (view.poll.status !== "OPEN") return { ok: false, error: "This schedule was cancelled." };
    // Plan section 15 step 2 ("identify the player"). A server MEMBER (2026-10-03) is never a voter, whether or not a roster exists:
    // votes decide whether the Premier team queues, and members aren't on it.
    const profile = await this.players.getByDiscordUserId(guildId, discordUserId);
    if (profile?.active && profile.kind === "MEMBER") {
      return { ok: false, error: "The schedule is for Premier players only — you're registered as a server member." };
    }
    // With a roster in place, only registered Premier players can move the vote count that decides whether we queue.
    const roster = await this.players.listActivePlayersByGuild(guildId);
    if (roster.length > 0 && !roster.some((p) => p.discordUserId === discordUserId)) {
      return { ok: false, error: "Only Premier players can vote — ask an admin to `/add-player` you." };
    }
    return { ok: true, value: view };
  }

  /** Toggles "I can play this slot". Idempotent at the row level (unique per slot+player, plan sections 15/50). */
  async vote(params: { guildId: string; pollId: number; slotId: number; discordUserId: string; displayName: string; now?: Date }): Promise<ScheduleResult<VoteOutcome>> {
    const now = params.now ?? new Date();
    const gate = await this.gate(params.guildId, params.pollId, params.discordUserId);
    if (!gate.ok) return gate;
    const slot = gate.value.slots.find((s) => s.id === params.slotId);
    if (!slot) return { ok: false, error: "That slot isn't part of this schedule." };
    if (effectiveAt(slot).getTime() <= now.getTime()) return { ok: false, error: "That slot has already started." };

    const action = await this.schedules.toggleVote({
      pollId: params.pollId,
      slotId: params.slotId,
      discordUserId: params.discordUserId,
      displayName: params.displayName,
    });
    const view = (await this.schedules.getView(params.pollId))!;
    const count = view.votes.filter((v) => v.slotId === slot.id).length;
    const reachedQuorum = action === "added" && count >= MIN_PLAYERS_TO_QUEUE && (await this.schedules.claimQuorumAnnouncement(slot.id));
    const yourPositions = view.slots.filter((s) => view.votes.some((v) => v.slotId === s.id && v.discordUserId === params.discordUserId)).map((s) => s.position);
    return { ok: true, value: { view, slot, action, reachedQuorum, yourPositions } };
  }

  /** "I can't play any day": clears the player's votes and records it. Pressing it again changes nothing. */
  async decline(params: { guildId: string; pollId: number; discordUserId: string; displayName: string }): Promise<ScheduleResult<{ view: ScheduleView; changed: boolean }>> {
    const gate = await this.gate(params.guildId, params.pollId, params.discordUserId);
    if (!gate.ok) return gate;
    const { changed } = await this.schedules.setDecline({ pollId: params.pollId, discordUserId: params.discordUserId, displayName: params.displayName });
    return { ok: true, value: { view: (await this.schedules.getView(params.pollId))!, changed } };
  }

  /** The admin's controls for one slot of the current poll: its queue time ("we're queuing at 7:30") and whether it gets reminders. */
  async editSlot(params: {
    guildId: string;
    position: number;
    queueInput?: string;
    remindMode?: SlotRemindMode;
    now?: Date;
  }): Promise<ScheduleResult<{ view: ScheduleView; slot: ScheduleSlotRow }>> {
    const now = params.now ?? new Date();
    const poll = await this.schedules.getLatestOpenPoll(params.guildId);
    if (!poll) return { ok: false, error: "There's no open schedule. Post one with `/create-schedule`." };
    const view = (await this.schedules.getView(poll.id))!;
    const slot = view.slots.find((s) => s.position === params.position);
    if (!slot) return { ok: false, error: `Schedule #${poll.id} has no slot ${params.position} (it has 1–${view.slots.length}).` };
    if (params.queueInput === undefined && params.remindMode === undefined) {
      return { ok: false, error: "Nothing to change — give a `queue` time and/or `reminders`." };
    }

    const changes: { queueAt?: Date | null; remindMode?: SlotRemindMode } = {};
    if (params.queueInput !== undefined) {
      const parsed = parseQueueInput(params.queueInput, slot.scheduledAt, poll.timezone, now);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      changes.queueAt = parsed.queueAt;
    }
    if (params.remindMode !== undefined) changes.remindMode = params.remindMode;

    const updated = (await this.schedules.updateSlot(slot.id, changes))!;
    // Apply the new queue time to the not-yet-sent reminders right away instead of waiting for the next cron tick.
    const config = await this.serverConfig.getByGuildId(params.guildId);
    if (config) {
      await this.schedules.reconcileSlotReminders(slot.id, planReminders(effectiveAt(updated), config.reminderScheduleMinutes));
    }
    return { ok: true, value: { view: (await this.schedules.getView(poll.id))!, slot: updated } };
  }

  /** Cancels the current open poll; its pending reminders are skipped by the next cron tick (and never fire: findDue only sees OPEN polls). */
  async cancel(guildId: string): Promise<ScheduleResult<{ view: ScheduleView }>> {
    const poll = await this.schedules.getLatestOpenPoll(guildId);
    if (!poll) return { ok: false, error: "There's no open schedule to cancel." };
    await this.schedules.cancelPoll(poll.id);
    return { ok: true, value: { view: (await this.schedules.getView(poll.id))! } };
  }
}
