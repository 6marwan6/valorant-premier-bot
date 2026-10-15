import { ComponentType, InteractionResponseType, TextInputStyle, type APIModalInteractionResponseCallbackData, type APIModalSubmitInteraction } from "discord-api-types/v10";
import type { ButtonInteraction } from "discord.js";
import type { AppContext } from "../../appContext.js";
import type { ReplyPayload } from "../discordRest.js";
import { agentByKey, ROLE_SINGULAR, type AgentRole } from "../../modules/agents/agentData.js";
import { agentNameFor } from "../../modules/agents/agentPanel.js";
import { reactWithMari } from "../scheduleReaction.js";
import { agentModalId, parseAgentCustomId, parseAgentModalCustomId, type PickTarget } from "../../modules/agents/agentCustomId.js";
import { buildAgentPanel } from "../../modules/agents/agentPanel.js";
import type { PanelOutcome, PanelState } from "../../modules/agents/agentPickService.js";
import type { PlayerRow } from "../../database/schema/players.js";
import { syncScheduleMessage } from "../scheduleSync.js";
import { squadOf } from "../../modules/agents/squad.js";
import { loadAgentEmojis } from "../agentEmojiCache.js";
import type { AgentEmojiMap } from "../../modules/agents/agentEmojis.js";

/**
 * The agent-pick panel's interactions (2026-10-04, owner's request): the
 * ephemeral panel a player gets after choosing a date, and everything they can
 * press on it. The rules live in AgentPickService; the look in agentPanel.ts.
 * This file is the Discord glue, with the same guarantees as the other
 * handlers: a failure is a private "try again", never a corrupted vote, and a
 * pick change refreshes the public schedule card best-effort (the database is
 * already right — plan principle #2).
 */

export const AGENT_NAME_FIELD_ID = "agent_name";
const AGENT_NAME_MAX = 20;

/** The role tab to open on: the player's own Valorant role when they have one, else Duelists. */
export function defaultTab(player: PlayerRow | undefined): AgentRole {
  return player?.kind === "PLAYER" && player.role ? player.role : "DUELIST";
}

export function renderPanel(state: PanelState, viewerId: string, tab: AgentRole, target: PickTarget, notice?: string, emojis?: AgentEmojiMap): ReplyPayload {
  const panel = buildAgentPanel({
    poll: state.poll,
    slots: state.slots,
    picks: state.picks,
    customAgents: state.customAgents,
    viewerId,
    tab,
    target,
    notice,
    emojis,
  });
  return { content: panel.content, embeds: panel.embeds, components: panel.components };
}

/** Which tab to show after an outcome: the one the action asked for, else the picked agent's role, else where the viewer already was. */
function tabAfter(outcome: PanelOutcome, fallback: AgentRole, agentKey?: string): AgentRole {
  if (outcome.focusRole) return outcome.focusRole;
  if (agentKey) {
    const role = agentByKey(agentKey)?.role ?? outcome.state.customAgents.find((c) => c.key === agentKey)?.role;
    if (role) return role;
  }
  return fallback;
}

/** The popup behind "➕ Add an agent". It has to be the interaction's first response, so the HTTP router answers with it directly. */
export function buildAddAgentModal(pollId: number, role: AgentRole, target: PickTarget): { type: InteractionResponseType.Modal; data: APIModalInteractionResponseCallbackData } {
  return {
    type: InteractionResponseType.Modal,
    data: {
      custom_id: agentModalId(pollId, role, target),
      title: `Add a ${ROLE_SINGULAR[role]}`.slice(0, 45),
      components: [
        {
          type: ComponentType.Label,
          label: "Agent name",
          component: {
            type: ComponentType.TextInput,
            custom_id: AGENT_NAME_FIELD_ID,
            style: TextInputStyle.Short,
            min_length: 2,
            max_length: AGENT_NAME_MAX,
            required: true,
            placeholder: "An agent that isn't in the list",
          },
        },
      ],
    },
  };
}

function extractAgentName(raw: Pick<APIModalSubmitInteraction, "data">): string {
  for (const row of raw.data.components as unknown as Array<Record<string, unknown>>) {
    const fields: Array<Record<string, unknown>> = [];
    if (row.component && typeof row.component === "object") fields.push(row.component as Record<string, unknown>);
    if (Array.isArray(row.components)) fields.push(...(row.components as Array<Record<string, unknown>>));
    for (const field of fields) {
      if (field.custom_id === AGENT_NAME_FIELD_ID && typeof field.value === "string") return field.value;
    }
  }
  return "";
}

/**
 * A press on the panel (role tab, an agent, main/second, clear). The panel is
 * an ephemeral message, so `update` redraws it in place. "Add an agent" is not
 * here: it opens a popup, which the router answers before any of this runs.
 */
export async function dispatchAgentButton(interaction: ButtonInteraction, ctx: AppContext): Promise<void> {
  const action = parseAgentCustomId(interaction.customId);
  const guildId = interaction.guildId;
  if (!action || action.kind === "add" || !guildId) {
    await interaction.reply({ content: "This button isn't recognized anymore.", ephemeral: true });
    return;
  }
  const discordUserId = interaction.user.id;
  const startedAt = Date.now();
  try {
    const service = ctx.services.agentPicks;
    const common = { guildId, pollId: action.pollId, discordUserId };
    let outcome: { ok: true; value: PanelOutcome } | { ok: false; error: string };
    let tab: AgentRole;
    let target: PickTarget;

    switch (action.kind) {
      case "role":
      case "target": {
        const state = await service.load(common);
        outcome = state.ok ? { ok: true, value: { state: state.value } } : state;
        tab = action.role;
        target = action.target;
        break;
      }
      case "pick": {
        outcome = await service.pick({ ...common, agentKey: action.agentKey, target: action.target });
        tab = outcome.ok ? tabAfter(outcome.value, "DUELIST", action.agentKey) : "DUELIST";
        target = outcome.ok ? (outcome.value.target ?? action.target) : action.target;
        break;
      }
      case "clear": {
        outcome = await service.clear({ ...common, scope: action.scope });
        tab = action.role;
        target = outcome.ok ? (outcome.value.target ?? "MAIN") : "MAIN";
        break;
      }
    }

    if (!outcome.ok) {
      await interaction.reply({ content: `❌ ${outcome.error}`, ephemeral: true });
      return;
    }
    const emojis = await loadAgentEmojis(ctx.discord, ctx.logger);
    await interaction.update(renderPanel(outcome.value.state, discordUserId, tab, target, outcome.value.notice, emojis));
    ctx.logger.info(
      { event: "agent.panel", op: action.kind, guildId, pollId: action.pollId, discordUserId, changed: outcome.value.changed ?? false, latencyMs: Date.now() - startedAt },
      "Agent panel interaction",
    );

    if (outcome.value.changed) {
      const view = await ctx.services.schedules.getView(outcome.value.state.poll.id);
      if (view) await syncScheduleMessage(ctx, view);

      // Mari's public "LOCKED IN" card is sent once the player has picked a main agent (2026-10-08), so it shows that agent.
      // It is claimed once per player per schedule, so changing a pick afterwards stays silent. Never throws.
      if (outcome.value.pickedMain) {
        const { state } = outcome.value;
        const mine = squadOf(state.picks).get(discordUserId);
        const role = mine?.main ? (agentByKey(mine.main)?.role ?? state.customAgents.find((c) => c.key === mine.main)?.role) : undefined;
        if (mine?.main && role) {
          await reactWithMari(interaction, ctx, {
            guildId,
            pollId: state.poll.id,
            channelId: state.poll.channelId,
            timezone: state.poll.timezone,
            kind: "VOTE",
            slots: state.mySlots,
            slotCount: view?.slots.length ?? 1,
            agent: { key: mine.main, name: agentNameFor(mine.main, state.customAgents), role },
          });
        }
      }
    }
  } catch (err) {
    ctx.logger.error(
      { event: "agent.panel.failed", op: action.kind, guildId, pollId: action.pollId, latencyMs: Date.now() - startedAt, err: err instanceof Error ? err.message : String(err) },
      "Agent panel handler threw",
    );
    await interaction.reply({ content: "Something went wrong. Please try again.", ephemeral: true }).catch(() => undefined);
  }
}

/**
 * The "Add an agent" popup, submitted (already acknowledged with a deferred
 * message update by the router, so the panel it was opened from can be edited
 * in place). A problem is shown as the panel's notice line; a hard failure is a
 * private message — nothing here can touch a vote or an attendance.
 */
export async function handleAgentAddModal(raw: APIModalSubmitInteraction, ctx: AppContext): Promise<void> {
  const parsed = parseAgentModalCustomId(raw.data.custom_id);
  const sender = (raw.member?.user ?? raw.user)!;
  const guildId = raw.guild_id;
  const startedAt = Date.now();
  if (!parsed || !guildId) {
    ctx.logger.warn({ event: "agent.modalUnrecognized" }, "Received an unrecognized agent modal submit");
    return;
  }
  try {
    const outcome = await ctx.services.agentPicks.suggest({
      guildId,
      pollId: parsed.pollId,
      discordUserId: sender.id,
      displayName: raw.member?.nick ?? sender.global_name ?? sender.username,
      name: extractAgentName(raw),
      role: parsed.role,
    });
    if (!outcome.ok) {
      await ctx.discord.sendInteractionFollowup(raw.token, { content: `❌ ${outcome.error}`, ephemeral: true });
      return;
    }
    const tab = outcome.value.focusRole ?? parsed.role;
    const emojis = await loadAgentEmojis(ctx.discord, ctx.logger);
    await ctx.discord.editOriginalInteractionResponse(raw.token, renderPanel(outcome.value.state, sender.id, tab, parsed.target, outcome.value.notice, emojis));
    ctx.logger.info({ event: "agent.suggested", guildId, pollId: parsed.pollId, discordUserId: sender.id, latencyMs: Date.now() - startedAt }, "Agent suggestion handled");
  } catch (err) {
    ctx.logger.error(
      { event: "agent.suggest.failed", guildId, pollId: parsed.pollId, latencyMs: Date.now() - startedAt, err: err instanceof Error ? err.message : String(err) },
      "Agent suggestion threw",
    );
    await ctx.discord.sendInteractionFollowup(raw.token, { content: "Something went wrong adding that agent. Please try again.", ephemeral: true }).catch(() => undefined);
  }
}
