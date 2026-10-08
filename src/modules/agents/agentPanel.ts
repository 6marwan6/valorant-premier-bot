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
import { agentIconText, emojiMarkup, type AgentEmojiMap } from "./agentEmojis.js";

/**
 * The "AGENT PICK" panel (2026-10-04, owner's request) — what a player sees
 * after choosing a date. Re-laid-out 2026-10-07 ("so crowded", "make the agent
 * cards horizontal like Valorant"):
 *
 *  - ONE header embed with room to breathe: when, the map, your pick, the
 *    suggested comps (a blank line between each block);
 *  - ONE agents embed for the open role tab. The agents sit side by side — three
 *    across, like the agent-select screen — instead of one tall card each. Each
 *    cell is the agent's portrait + name over its status (OPEN / YOUR PICK /
 *    PICKED BY @someone). The portrait is an application emoji when the team
 *    has run `npm run sync-agent-emojis`, otherwise the role glyph;
 *  - role tabs, the agent buttons (also in rows, with the same portrait), and
 *    pick / clear / add-an-agent / switch-slot.
 *
 * Everyone's picks are on the public AGENT SELECT lineup message
 * (agentBoard.ts); this panel is the private place to choose.
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
  /** Uploaded agent portrait emojis (discord/agentEmojiCache.ts). Absent or empty = role glyphs. */
  emojis?: AgentEmojiMap;
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
const COLOR_AGENTS = 0x2d3a4a; // Valorant's dark slate

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
  const { poll, slot, picks, customAgents, viewerId, tab, emojis } = input;
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
  const iconOf = (key: string) => {
    const a = agentByKey(key);
    return agentIconText(key, a ? ROLE_GLYPH[a.role] : "▫️", emojis);
  };
  const dayTime = `${formatSlotDay(slot.scheduledAt, tz)} · ${formatSlotTime(slot.scheduledAt, tz)}`;
  const at = Math.floor((slot.queueAt ?? slot.scheduledAt).getTime() / 1000);

  // ---- header: one block per idea, a blank line between them
  const compBlocks = comps.map((comp, i) => {
    const line = comp.agents.map((key) => `${iconOf(key)} ${nameOf(key)}${holderOf.has(key) ? " ✅" : ""}`).join("  ·  ");
    return `${i === 0 ? "🅰️" : "🅱️"} **COMP ${COMP_LETTER[i]} — ${comp.name}${general ? " (general)" : ""}**\n${line}`;
  });
  const header = new EmbedBuilder()
    .setColor(COLOR_HEADER)
    .setTitle("◢ AGENT PICK ◣")
    .setDescription(
      [
        `📅 **${dayTime}** · <t:${at}:R>\n${slot.map ? `🗺️ **MAP: ${slot.map.toUpperCase()}**` : "🗺️ **MAP: TBD** — an admin sets it with `/schedule-slot`"}`,
        `🎯 **YOUR PICK:** ${mine ? `**${nameOf(mine.agentKey)}**` : "_none yet — tap an agent below_"}`,
        ...compBlocks,
        ...(picks.length > 0 ? [`🔒 **SQUAD · ${picks.length} locked**\n${picks.map((p) => `<@${p.discordUserId}> — ${emojis?.get(p.agentKey) ? `${emojiMarkup(emojis.get(p.agentKey)!)} ` : ""}**${nameOf(p.agentKey)}**`).join("\n")}`] : []),
      ].join("\n\n"),
    );
  if (mine) {
    const portrait = agentByKey(mine.agentKey);
    if (portrait) header.setThumbnail(agentIconUrl(portrait)); // the selected agent, big — like the centre of the game's select screen
  }

  // ---- the open tab: suggested agents first, then the other options, three across
  const all = agentsForRole(tab, customAgents);
  const ordered = [...all.filter((a) => suggestedBy.has(a.key)), ...all.filter((a) => !suggestedBy.has(a.key))];
  const cells = ordered.slice(0, MAX_AGENT_BUTTONS).map((a) => {
    const holder = holderOf.get(a.key);
    const isMine = holder === viewerId;
    const status = isMine ? "✅ **YOU**" : holder ? `🔒 <@${holder}>` : "🟢 Open";
    const tags = suggestedBy.has(a.key) ? `⭐ ${suggestedBy.get(a.key)!.join(", ")}` : a.custom ? `➕ by <@${a.custom.suggestedByUserId}>` : null;
    return {
      name: `${a.custom ? ROLE_GLYPH[tab] : iconOf(a.key)} ${a.name.toUpperCase()}`.slice(0, 256),
      value: tags ? `${status}\n${tags}` : status,
      inline: true,
    };
  });
  const agents = new EmbedBuilder()
    .setColor(COLOR_AGENTS)
    .setTitle(`${ROLE_GLYPH[tab]} ${ROLE_LABEL[tab].toUpperCase()}`)
    .setDescription(`_${ROLE_BLURB[tab]}_`)
    .addFields(cells)
    .setFooter({ text: `PREMIER · Schedule #${poll.id} · slot ${slot.position} · one agent each, no duplicates` });

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
          const button = new ButtonBuilder()
            .setCustomId(agentPickId(slot.id, a.key))
            .setLabel(takenByOther ? `${a.name} 🔒`.slice(0, 80) : a.name.slice(0, 80))
            .setStyle(isMine ? ButtonStyle.Success : suggestedBy.has(a.key) && !takenByOther ? ButtonStyle.Primary : ButtonStyle.Secondary)
            .setDisabled(takenByOther);
          const portrait = a.custom ? undefined : emojis?.get(a.key);
          if (portrait) button.setEmoji({ id: portrait.id, name: portrait.name });
          return button;
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

  // `content` is always a string: an edit that omits it would leave the previous notice on screen.
  return { content: input.notice ?? "", embeds: [header, agents], components: rows };
}

export { ROLE_SINGULAR };
