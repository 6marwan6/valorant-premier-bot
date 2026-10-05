import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, escapeMarkdown } from "discord.js";
import type { AgentPickRow, CustomAgentRow, ScheduleSlotRow } from "../../database/schema/schedules.js";
import { formatSlotDay, formatSlotTime } from "../schedules/scheduleLogic.js";
import {
  AGENTS,
  ROLE_BLURB,
  ROLE_GLYPH,
  ROLE_LABEL,
  ROLE_ORDER,
  ROLE_SINGULAR,
  agentByKey,
  agentIconUrl,
  compsFor,
  roleIconUrl,
  type AgentRole,
} from "./agentData.js";
import { agentAddId, agentClearId, agentPickId, agentRoleId, agentSwitchId } from "./agentCustomId.js";

/**
 * The "AGENT PICK" panel (2026-10-04, owner's request) — what a player sees
 * after choosing a date, in place of the old text confirmation:
 *
 *  - the match: day/time and the MAP (or "TBD" until the admin sets it);
 *  - one or two SUGGESTED COMPS for that map, each agent marked once taken;
 *  - the squad's picks so far and the viewer's own;
 *  - role tabs (Duelists / Initiators / Controllers / Sentinels), so each
 *    role's agents sit together; the open tab lists its agents as cards with
 *    the in-game portrait — suggested ones first, then the other options —
 *    each saying OPEN, YOUR PICK, or who already picked it;
 *  - buttons to pick, clear, add an agent that isn't listed, or switch slot.
 *
 * Pure: built from rows the caller loaded, no database or Discord. Everything
 * on it is a database fact (plan section 14); the model writes none of it.
 */

export interface AgentPanelInput {
  poll: { id: number; timezone: string };
  slot: ScheduleSlotRow;
  /** Picks for THIS slot only. */
  picks: AgentPickRow[];
  customAgents: CustomAgentRow[];
  viewerId: string;
  tab: AgentRole;
  /** The viewer is in more than one upcoming slot, so a "Switch slot" button is useful. */
  hasOtherSlots: boolean;
  /** One line shown above the panel: what just happened (picked / already taken / agent added). */
  notice?: string;
}

/** A built-in or player-suggested agent, normalized for display. */
export interface PanelAgent {
  key: string;
  name: string;
  role: AgentRole;
  iconUrl: string;
  custom: { suggestedByUserId: string } | null;
}

const COLOR_HEADER = 0xff4655; // Valorant red
const COLOR_SUGGESTED = 0xff4655;
const COLOR_OTHER = 0x2d3a4a; // Valorant's dark slate
const COLOR_TAKEN = 0x4f545c;
const COLOR_MINE = 0xf5c542;

/**
 * The most agent cards (embeds with a portrait) one message can hold next to the header embed: Discord allows 10
 * embeds. A role with more agents than that shows one card fewer, to leave the last embed for a compact "MORE" list.
 * (Duelists are 8 today, so one player-suggested duelist still gets a full card.)
 */
export const MAX_AGENT_CARDS = 9;
/** Buttons: role tabs take row 1, actions the last row, so three rows of five remain for agents. */
export const MAX_AGENT_BUTTONS = 15;
/** The most agents one role can hold (built-in + suggested): what the button rows can show. */
export const MAX_AGENTS_PER_ROLE = MAX_AGENT_BUTTONS;

export function agentsForRole(role: AgentRole, customAgents: readonly CustomAgentRow[]): PanelAgent[] {
  const builtIn = AGENTS.filter((a) => a.role === role).map<PanelAgent>((a) => ({ key: a.key, name: a.name, role, iconUrl: agentIconUrl(a), custom: null }));
  const custom = customAgents
    .filter((c) => c.role === role)
    .map<PanelAgent>((c) => ({ key: c.key, name: c.displayName, role, iconUrl: roleIconUrl(role), custom: { suggestedByUserId: c.suggestedByUserId } }));
  return [...builtIn, ...custom];
}

/** Name of any agent a pick can point at (built-in or suggested), for lineups outside the panel. */
export function agentNameFor(key: string, customAgents: readonly CustomAgentRow[]): string {
  return agentByKey(key)?.name ?? customAgents.find((c) => c.key === key)?.displayName ?? key;
}

const COMP_LETTER = ["A", "B"];

export function buildAgentPanel(input: AgentPanelInput): { content: string; embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  const { poll, slot, picks, customAgents, viewerId, tab } = input;
  const tz = poll.timezone;
  const holderOf = new Map(picks.map((p) => [p.agentKey, p.discordUserId]));
  const mine = picks.find((p) => p.discordUserId === viewerId);
  const { comps, general } = compsFor(slot.map);

  // Which comp(s) suggest each agent.
  const suggestedBy = new Map<string, string[]>();
  comps.forEach((comp, i) => {
    for (const key of comp.agents) suggestedBy.set(key, [...(suggestedBy.get(key) ?? []), `Comp ${COMP_LETTER[i]}`]);
  });

  const nameOf = (key: string) => escapeMarkdown(agentNameFor(key, customAgents));
  const dayTime = `${formatSlotDay(slot.scheduledAt, tz)} · ${formatSlotTime(slot.scheduledAt, tz)}`;
  const at = Math.floor((slot.queueAt ?? slot.scheduledAt).getTime() / 1000);

  // ---- header
  const header = new EmbedBuilder()
    .setColor(COLOR_HEADER)
    .setTitle("◢ AGENT PICK ◣")
    .setDescription(
      [
        `📅 **${dayTime}** · <t:${at}:R>`,
        slot.map ? `🗺️ **MAP: ${slot.map.toUpperCase()}**` : "🗺️ **MAP: TBD** — an admin sets it with `/schedule-slot`",
        "",
        `▸ **${ROLE_LABEL[tab].toUpperCase()}** — ${ROLE_BLURB[tab]}`,
      ].join("\n"),
    );

  comps.forEach((comp, i) => {
    const line = comp.agents
      .map((key) => {
        const a = agentByKey(key);
        const taken = holderOf.has(key) ? " ✅" : "";
        return `${a ? ROLE_GLYPH[a.role] : "▫️"} ${nameOf(key)}${taken}`;
      })
      .join("  ·  ");
    header.addFields({ name: `${i === 0 ? "🅰️" : "🅱️"} SUGGESTED COMP ${COMP_LETTER[i]} — ${comp.name}${general ? " (general)" : ""}`, value: line });
  });

  header.addFields({
    name: "🎯 YOUR PICK",
    value: mine ? `**${nameOf(mine.agentKey)}**` : "_none yet — tap an agent below_",
    inline: true,
  });
  if (picks.length > 0) {
    header.addFields({
      name: `🔒 SQUAD PICKS · ${picks.length}`,
      value: picks.map((p) => `<@${p.discordUserId}> — **${nameOf(p.agentKey)}**`).join("\n").slice(0, 1024),
      inline: true,
    });
  }
  header.setFooter({ text: `PREMIER · Schedule #${poll.id} · slot ${slot.position} · one agent each, no duplicates` });

  // ---- the open tab: suggested agents first, then the other options
  const all = agentsForRole(tab, customAgents);
  const ordered = [...all.filter((a) => suggestedBy.has(a.key)), ...all.filter((a) => !suggestedBy.has(a.key))];
  const cardCount = ordered.length <= MAX_AGENT_CARDS ? ordered.length : MAX_AGENT_CARDS - 1;
  const cards = ordered.slice(0, cardCount).map((a) => {
    const holder = holderOf.get(a.key);
    const isMine = holder === viewerId;
    const tags = [
      suggestedBy.has(a.key) ? `⭐ SUGGESTED · ${suggestedBy.get(a.key)!.join(", ")}` : "OTHER OPTION",
      a.custom ? `➕ ADDED BY <@${a.custom.suggestedByUserId}>` : null,
    ].filter(Boolean);
    const status = isMine ? "✅ **YOUR PICK**" : holder ? `🔒 **PICKED BY** <@${holder}>` : "🟢 **OPEN**";
    return new EmbedBuilder()
      .setColor(isMine ? COLOR_MINE : holder ? COLOR_TAKEN : suggestedBy.has(a.key) ? COLOR_SUGGESTED : COLOR_OTHER)
      .setTitle(`${ROLE_GLYPH[tab]} ${a.name.toUpperCase()}`)
      .setThumbnail(a.iconUrl)
      .setDescription(`${tags.join(" · ")}\n${status}`);
  });
  const overflow = ordered.slice(cardCount);
  if (overflow.length > 0) {
    cards.push(
      new EmbedBuilder().setColor(COLOR_OTHER).setTitle(`MORE ${ROLE_LABEL[tab].toUpperCase()}`).setDescription(
        overflow
          .map((a) => {
            const holder = holderOf.get(a.key);
            return `**${escapeMarkdown(a.name)}** — ${holder === viewerId ? "✅ your pick" : holder ? `🔒 <@${holder}>` : "🟢 open"}${a.custom ? ` (added by <@${a.custom.suggestedByUserId}>)` : ""}`;
          })
          .join("\n"),
      ),
    );
  }

  // ---- buttons
  const rows: ActionRowBuilder<ButtonBuilder>[] = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      ROLE_ORDER.map((r) =>
        new ButtonBuilder()
          .setCustomId(agentRoleId(slot.id, r))
          .setLabel(ROLE_LABEL[r])
          .setEmoji(ROLE_GLYPH[r])
          .setStyle(r === tab ? ButtonStyle.Primary : ButtonStyle.Secondary)
          .setDisabled(r === tab),
      ),
    ),
  ];
  const shown = ordered.slice(0, MAX_AGENT_BUTTONS);
  for (let i = 0; i < shown.length; i += 5) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        shown.slice(i, i + 5).map((a) => {
          const holder = holderOf.get(a.key);
          const isMine = holder === viewerId;
          const takenByOther = Boolean(holder) && !isMine;
          return new ButtonBuilder()
            .setCustomId(agentPickId(slot.id, a.key))
            .setLabel(takenByOther ? `${a.name} 🔒`.slice(0, 80) : a.name.slice(0, 80))
            .setStyle(isMine ? ButtonStyle.Success : suggestedBy.has(a.key) && !takenByOther ? ButtonStyle.Primary : ButtonStyle.Secondary)
            .setDisabled(takenByOther);
        }),
      ),
    );
  }
  const actions = [
    new ButtonBuilder().setCustomId(agentAddId(slot.id, tab)).setLabel("Add an agent").setEmoji("➕").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(agentClearId(slot.id, tab)).setLabel("Clear my pick").setStyle(ButtonStyle.Danger).setDisabled(!mine),
  ];
  if (input.hasOtherSlots) {
    actions.push(new ButtonBuilder().setCustomId(agentSwitchId(slot.id, tab)).setLabel("Switch slot").setEmoji("🗓️").setStyle(ButtonStyle.Secondary));
  }
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(actions));

  const content = [`🎯 **AGENT PICK** — ${dayTime}${slot.map ? ` · ${slot.map}` : ""}`, input.notice].filter(Boolean).join("\n");
  return { content, embeds: [header, ...cards], components: rows };
}

export { ROLE_SINGULAR };
