import type { ScheduleRepository } from "../../database/repositories/scheduleRepository.js";
import type { PlayerRepository } from "../../database/repositories/playerRepository.js";
import type { AgentPickRow, CustomAgentRow, SchedulePollRow, ScheduleSlotRow } from "../../database/schema/schedules.js";
import { effectiveAt } from "../schedules/scheduleLogic.js";
import { escapeMarkdown } from "discord.js";
import { AGENTS, ROLE_LABEL, ROLE_SINGULAR, agentByKey, agentKeyOf, findAgentByName, type AgentRole } from "./agentData.js";
import { MAX_AGENTS_PER_ROLE, agentNameFor } from "./agentPanel.js";
import type { PickTarget } from "./agentCustomId.js";
import type { ScheduleResult } from "../schedules/scheduleService.js";

/** Everything the panel needs to render, loaded fresh on every click so it never shows a stale pick. */
export interface PanelState {
  poll: SchedulePollRow;
  /** Every slot of the schedule that is still ahead, earliest first — the squad plays all of them. */
  slots: ScheduleSlotRow[];
  /** The viewer's own upcoming slots (always at least one: that is what lets them pick). */
  mySlots: ScheduleSlotRow[];
  /** Everyone's picks for the whole schedule. */
  picks: AgentPickRow[];
  customAgents: CustomAgentRow[];
}

export interface PanelOutcome {
  state: PanelState;
  /** What just happened, shown above the panel. */
  notice?: string;
  /** The role tab to show next (an agent was just added to it). */
  focusRole?: AgentRole;
  /** Which pick the panel should be choosing next, when the action decides it (e.g. "Pick a second"). */
  target?: PickTarget;
  /** The pick set changed, so the public schedule card should be refreshed. */
  changed?: boolean;
  /** A MAIN agent was just set, so the player has locked in (Mari's "LOCKED IN" card is claimed once per player per schedule). */
  pickedMain?: boolean;
}

export const MAX_SUGGESTIONS_PER_PLAYER = 5;
const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} .'/-]*$/u;
const MIN_NAME = 2;
const MAX_NAME = 20;

/**
 * The agent-pick rules. Since 2026-10-15 (owner's request) there is **one squad
 * per schedule**: each player who is in at least one slot picks a MAIN agent and,
 * optionally, a SECOND, and the same pair applies to every slot that week.
 * Who may pick (a Premier player who is in at least one upcoming slot), that a
 * main agent has one holder (a second may overlap — it is a backup), and the
 * "add an agent that's not there" flow are decided here, with the database as
 * the source of truth (plan principle #2); Discord rendering is the panel's and
 * the handlers' job, the same split ScheduleService uses.
 */
export class AgentPickService {
  constructor(
    private readonly schedules: ScheduleRepository,
    private readonly players: PlayerRepository,
  ) {}

  /**
   * Loads the panel state, refusing anyone who shouldn't be there: a server member (never Premier), a player
   * outside the roster once one exists, someone who isn't in any slot, a cancelled schedule, a week that is over.
   */
  async load(params: { guildId: string; pollId: number; discordUserId: string; now?: Date }): Promise<ScheduleResult<PanelState>> {
    const now = params.now ?? new Date();
    const view = await this.schedules.getView(params.pollId);
    if (!view || view.poll.guildId !== params.guildId) return { ok: false, error: "This schedule no longer exists." };
    if (view.poll.status !== "OPEN") return { ok: false, error: "This schedule was cancelled." };

    const profile = await this.players.getByDiscordUserId(params.guildId, params.discordUserId);
    if (profile?.active && profile.kind === "MEMBER") {
      return { ok: false, error: "Agent picks are for Premier players only — you're registered as a server member." };
    }
    const roster = await this.players.listActivePlayersByGuild(params.guildId);
    if (roster.length > 0 && !roster.some((p) => p.discordUserId === params.discordUserId)) {
      return { ok: false, error: "Only Premier players can pick agents — ask an admin to `/add-player` you." };
    }

    const slots = view.slots.filter((s) => effectiveAt(s).getTime() > now.getTime());
    if (slots.length === 0) return { ok: false, error: "Every slot of this schedule has already started." };
    const myVotedSlotIds = new Set(view.votes.filter((v) => v.discordUserId === params.discordUserId).map((v) => v.slotId));
    const mySlots = slots.filter((s) => myVotedSlotIds.has(s.id));
    if (mySlots.length === 0) {
      return { ok: false, error: myVotedSlotIds.size > 0 ? "The slots you voted for have already started." : "Vote for a slot first, then pick your agent." };
    }

    return {
      ok: true,
      value: { poll: view.poll, slots, mySlots, picks: view.picks, customAgents: await this.schedules.listCustomAgents(params.guildId) },
    };
  }

  /** Sets the viewer's MAIN or SECOND agent for the whole schedule. */
  async pick(params: { guildId: string; pollId: number; discordUserId: string; agentKey: string; target: PickTarget; now?: Date }): Promise<ScheduleResult<PanelOutcome>> {
    const state = await this.load(params);
    if (!state.ok) return state;
    const builtIn = agentByKey(params.agentKey);
    const custom = state.value.customAgents.find((c) => c.key === params.agentKey);
    const name = builtIn?.name ?? custom?.displayName;
    if (!name) return { ok: false, error: "That agent isn't in the list anymore." };
    const shown = escapeMarkdown(name);

    const result = await this.schedules.pickAgent({ pollId: params.pollId, discordUserId: params.discordUserId, agentKey: params.agentKey, kind: params.target });
    const fresh = await this.load(params);
    if (!fresh.ok) return fresh;
    const outcome = (notice: string, extra: Partial<PanelOutcome> = {}): ScheduleResult<PanelOutcome> => ({ ok: true, value: { state: fresh.value, notice, ...extra } });

    if (!result.ok) {
      switch (result.reason) {
        case "TAKEN":
          return outcome(`🔒 **${shown}** is already <@${result.takenBy}>'s main. Pick someone else — or take it as your second.`);
        case "NEEDS_MAIN":
          return outcome("Pick your **main** agent first — the second is an extra on top of it.", { target: "MAIN" });
        case "SAME_AS_MAIN":
          return outcome(`**${shown}** is already your main. Pick a different agent as your second.`);
      }
    }
    if (params.target === "SECOND") {
      return outcome(result.changed ? `✅ **${shown}** is your second agent — for every slot this week.` : `✅ **${shown}** is already your second agent.`, { changed: result.changed });
    }
    const swapped = result.swappedWith ? ` **${escapeMarkdown(agentNameFor(result.swappedWith, fresh.value.customAgents))}** moved to your second.` : "";
    return outcome(
      result.changed ? `✅ **${shown}** is your main — for every slot this week.${swapped}` : `✅ **${shown}** is already your main.`,
      { changed: result.changed, pickedMain: result.changed },
    );
  }

  /** `ALL` clears both picks (a second can't outlive its main); `SECOND` clears only the backup. */
  async clear(params: { guildId: string; pollId: number; discordUserId: string; scope: "ALL" | "SECOND"; now?: Date }): Promise<ScheduleResult<PanelOutcome>> {
    const state = await this.load(params);
    if (!state.ok) return state;
    const cleared = await this.schedules.clearPicks(params.pollId, params.discordUserId, params.scope);
    const fresh = await this.load(params);
    if (!fresh.ok) return fresh;
    const notice = cleared ? (params.scope === "ALL" ? "↩️ Picks cleared." : "↩️ Second agent cleared.") : "You hadn't picked anything to clear.";
    return { ok: true, value: { state: fresh.value, notice, changed: cleared, target: params.scope === "ALL" ? "MAIN" : "SECOND" } };
  }

  /**
   * "Add an agent that isn't listed" (the ➕ popup). Validates the name, refuses duplicates of built-in or earlier
   * suggestions (saying who added those), keeps the lists button-sized, and records who suggested it so the panel
   * can say so. Idempotent: a double-submitted popup adds one.
   */
  async suggest(params: { guildId: string; pollId: number; discordUserId: string; displayName: string; name: string; role: AgentRole; now?: Date }): Promise<ScheduleResult<PanelOutcome>> {
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
