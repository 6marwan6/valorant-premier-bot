import type { ScheduleRepository } from "../../database/repositories/scheduleRepository.js";
import type { PlayerRepository } from "../../database/repositories/playerRepository.js";
import type { AgentPickRow, CustomAgentRow, SchedulePollRow, ScheduleSlotRow } from "../../database/schema/schedules.js";
import { effectiveAt } from "../schedules/scheduleLogic.js";
import { escapeMarkdown } from "discord.js";
import { AGENTS, ROLE_LABEL, ROLE_SINGULAR, agentByKey, agentKeyOf, findAgentByName, type AgentRole } from "./agentData.js";
import { MAX_AGENTS_PER_ROLE } from "./agentPanel.js";
import type { ScheduleResult } from "../schedules/scheduleService.js";

/** Everything the panel needs to render, loaded fresh on every click so it never shows a stale pick. */
export interface PanelState {
  poll: SchedulePollRow;
  slot: ScheduleSlotRow;
  /** Picks for this slot. */
  picks: AgentPickRow[];
  customAgents: CustomAgentRow[];
  /** The viewer's upcoming slots in this poll, earliest first (always includes `slot`). */
  mySlots: ScheduleSlotRow[];
}

export interface PanelOutcome {
  state: PanelState;
  /** What just happened, shown above the panel. */
  notice?: string;
  /** The role tab to show next (an agent was just added to it). */
  focusRole?: AgentRole;
  /** The pick set changed, so the public schedule card should be refreshed. */
  changed?: boolean;
}

export const MAX_SUGGESTIONS_PER_PLAYER = 5;
const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} .'/-]*$/u;
const MIN_NAME = 2;
const MAX_NAME = 20;

/**
 * The agent-pick rules (2026-10-04, owner's request). Who may pick (a Premier
 * player who is in that slot), that an agent has one holder per slot, and the
 * "add an agent that's not there" flow — decided here, with the database as
 * the source of truth (plan principle #2); Discord rendering is the panel's
 * and the handlers' job, the same split ScheduleService uses.
 */
export class AgentPickService {
  constructor(
    private readonly schedules: ScheduleRepository,
    private readonly players: PlayerRepository,
  ) {}

  /**
   * Loads the panel state, refusing anyone who shouldn't be there: a server member (never Premier), a player
   * outside the roster once one exists, someone who hasn't voted for this slot, a cancelled schedule, a slot
   * that has started.
   */
  async load(params: { guildId: string; slotId: number; discordUserId: string; now?: Date }): Promise<ScheduleResult<PanelState>> {
    const now = params.now ?? new Date();
    const slot = await this.schedules.getSlot(params.slotId);
    const poll = slot ? await this.schedules.getPoll(slot.pollId) : undefined;
    if (!slot || !poll || poll.guildId !== params.guildId) return { ok: false, error: "That slot no longer exists." };
    if (poll.status !== "OPEN") return { ok: false, error: "This schedule was cancelled." };

    const profile = await this.players.getByDiscordUserId(params.guildId, params.discordUserId);
    if (profile?.active && profile.kind === "MEMBER") {
      return { ok: false, error: "Agent picks are for Premier players only — you're registered as a server member." };
    }
    const roster = await this.players.listActivePlayersByGuild(params.guildId);
    if (roster.length > 0 && !roster.some((p) => p.discordUserId === params.discordUserId)) {
      return { ok: false, error: "Only Premier players can pick agents — ask an admin to `/add-player` you." };
    }
    if (effectiveAt(slot).getTime() <= now.getTime()) return { ok: false, error: "That slot has already started." };

    const view = (await this.schedules.getView(poll.id))!;
    const myVotedSlotIds = new Set(view.votes.filter((v) => v.discordUserId === params.discordUserId).map((v) => v.slotId));
    if (!myVotedSlotIds.has(slot.id)) return { ok: false, error: "Vote for this slot first, then pick your agent." };

    const mySlots = view.slots.filter((s) => myVotedSlotIds.has(s.id) && effectiveAt(s).getTime() > now.getTime());
    return {
      ok: true,
      value: {
        poll,
        slot,
        picks: view.picks.filter((p) => p.slotId === slot.id),
        customAgents: await this.schedules.listCustomAgents(params.guildId),
        mySlots,
      },
    };
  }

  /** Opens the panel for the viewer's first upcoming slot in the newest open poll — the "🎯 AGENT PICK" button on the schedule card. */
  async openFirst(params: { guildId: string; pollId: number; discordUserId: string; now?: Date }): Promise<ScheduleResult<PanelState>> {
    const now = params.now ?? new Date();
    const view = await this.schedules.getView(params.pollId);
    if (!view || view.poll.guildId !== params.guildId) return { ok: false, error: "This schedule no longer exists." };
    const mine = view.slots.find((s) => effectiveAt(s).getTime() > now.getTime() && view.votes.some((v) => v.slotId === s.id && v.discordUserId === params.discordUserId));
    if (!mine) return { ok: false, error: "Vote for a slot first, then pick your agent." };
    return this.load({ guildId: params.guildId, slotId: mine.id, discordUserId: params.discordUserId, now });
  }

  async pick(params: { guildId: string; slotId: number; discordUserId: string; agentKey: string; now?: Date }): Promise<ScheduleResult<PanelOutcome>> {
    const state = await this.load(params);
    if (!state.ok) return state;
    const builtIn = agentByKey(params.agentKey);
    const custom = state.value.customAgents.find((c) => c.key === params.agentKey);
    const name = builtIn?.name ?? custom?.displayName;
    if (!name) return { ok: false, error: "That agent isn't in the list anymore." };

    const result = await this.schedules.pickAgent({ slotId: params.slotId, discordUserId: params.discordUserId, agentKey: params.agentKey });
    const fresh = await this.load(params);
    if (!fresh.ok) return fresh;
    if (!result.ok) {
      return { ok: true, value: { state: fresh.value, notice: `🔒 **${escapeMarkdown(name)}** is already picked by <@${result.takenBy}>. Pick someone else.` } };
    }
    return {
      ok: true,
      value: { state: fresh.value, notice: result.changed ? `✅ You're playing **${escapeMarkdown(name)}**.` : `✅ **${escapeMarkdown(name)}** is already your pick.`, changed: result.changed },
    };
  }

  async clear(params: { guildId: string; slotId: number; discordUserId: string; now?: Date }): Promise<ScheduleResult<PanelOutcome>> {
    const state = await this.load(params);
    if (!state.ok) return state;
    const cleared = await this.schedules.clearPick(params.slotId, params.discordUserId);
    const fresh = await this.load(params);
    if (!fresh.ok) return fresh;
    return { ok: true, value: { state: fresh.value, notice: cleared ? "↩️ Pick cleared." : "You hadn't picked an agent yet.", changed: cleared } };
  }

  /** The viewer's next upcoming slot after this one (wrapping), for "Switch slot". */
  async nextSlot(params: { guildId: string; slotId: number; discordUserId: string; now?: Date }): Promise<ScheduleResult<PanelOutcome>> {
    const state = await this.load(params);
    if (!state.ok) return state;
    const { mySlots, slot } = state.value;
    const next = mySlots[(mySlots.findIndex((s) => s.id === slot.id) + 1) % mySlots.length]!;
    if (next.id === slot.id) return { ok: true, value: { state: state.value } };
    const loaded = await this.load({ ...params, slotId: next.id });
    return loaded.ok ? { ok: true, value: { state: loaded.value } } : loaded;
  }

  /**
   * "Add an agent that isn't listed" (the ➕ popup). Validates the name, refuses duplicates of built-in or earlier
   * suggestions (saying who added those), keeps the lists button-sized, and records who suggested it so the panel
   * can say so. Idempotent: a double-submitted popup adds one.
   */
  async suggest(params: { guildId: string; slotId: number; discordUserId: string; displayName: string; name: string; role: AgentRole; now?: Date }): Promise<ScheduleResult<PanelOutcome>> {
    const state = await this.load(params);
    if (!state.ok) return state;

    const name = params.name.replace(/\s+/g, " ").trim();
    const reply = (notice: string, focusRole?: AgentRole): ScheduleResult<PanelOutcome> => ({ ok: true, value: { state: state.value, notice, focusRole } });

    if (name.length < MIN_NAME || name.length > MAX_NAME || !NAME_PATTERN.test(name)) {
      return reply(`❌ Agent names are ${MIN_NAME}–${MAX_NAME} characters: letters, numbers, spaces and . ' / - only.`);
    }
    const key = agentKeyOf(name);
    if (key.length < 2 || key.length > 24) return reply("❌ That name isn't usable. Try the agent's plain name.");

    const known = findAgentByName(name);
    if (known) return reply(`**${escapeMarkdown(known.name)}** is already in the list under ${ROLE_LABEL[known.role]}.`, known.role);
    const existing = state.value.customAgents.find((c) => c.key === key);
    if (existing) return reply(`**${escapeMarkdown(existing.displayName)}** was already added by <@${existing.suggestedByUserId}> (${ROLE_LABEL[existing.role]}).`, existing.role);

    const inRole = AGENTS.filter((a) => a.role === params.role).length + state.value.customAgents.filter((c) => c.role === params.role).length;
    if (inRole >= MAX_AGENTS_PER_ROLE) return reply(`❌ ${ROLE_LABEL[params.role]} is full (${MAX_AGENTS_PER_ROLE} agents).`);
    if (state.value.customAgents.filter((c) => c.suggestedByUserId === params.discordUserId).length >= MAX_SUGGESTIONS_PER_PLAYER) {
      return reply(`❌ You've already added ${MAX_SUGGESTIONS_PER_PLAYER} agents — ask an admin if one more is needed.`);
    }

    await this.schedules.createCustomAgent({
      guildId: params.guildId,
      key,
      displayName: name,
      role: params.role,
      suggestedByUserId: params.discordUserId,
      suggestedByName: params.displayName,
    });
    const fresh = await this.load(params);
    if (!fresh.ok) return fresh;
    return {
      ok: true,
      value: {
        state: fresh.value,
        notice: `➕ **${escapeMarkdown(name)}** added to ${ROLE_LABEL[params.role]} — suggested by <@${params.discordUserId}>. Tap it to pick it.`,
        focusRole: params.role,
      },
    };
  }
}

export { ROLE_SINGULAR };
