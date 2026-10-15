import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, escapeMarkdown } from "discord.js";
import type { AgentPickRow, CustomAgentRow, ScheduleSlotRow } from "../../database/schema/schedules.js";
import { effectiveAt, formatSlotDay, formatSlotTime } from "../schedules/scheduleLogic.js";
import { mainHolders, squadMap, squadOf } from "./squad.js";
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
import { agentAddId, agentClearId, agentPickId, agentRoleId, agentTargetId, type PickTarget } from "./agentCustomId.js";
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
 *    pick-a-second / add-an-agent / clear. One squad per schedule (2026-10-15): a main
 *    agent (one holder each) and an optional second (a backup that may overlap), the
 *    same for every slot — so there is no per-slot state and no "switch slot".
 *
 * Everyone's picks are on the public AGENT SELECT lineup message
 * (agentBoard.ts); this panel is the private place to choose.
 *
 * Pure: built from rows the caller loaded, no database or Discord. Everything
 * on it is a database fact (plan section 14); the model writes none of it.
 */

export interface AgentPanelInput {
  poll: { id: number; timezone: string };
  /** Every slot of the schedule that is still ahead: the squad plays all of them. */
  slots: ScheduleSlotRow[];
  /** Everyone's picks for the whole schedule. */
  picks: AgentPickRow[];
  customAgents: CustomAgentRow[];
  viewerId: string;
  tab: AgentRole;
  /** Which pick the viewer is choosing: their main agent, or the optional second. */
  target: PickTarget;
  /** One line shown above the panel: what just happened (picked / already taken / agent added). */
  notice?: string;
  /** Uploaded agent portrait emojis (discord/agentEmojiCache.ts). Absent or empty = role glyphs. */
  emojis?: AgentEmojiMap;
  now?: Date;
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
  const { poll, slots, picks, customAgents, viewerId, tab, target, emojis } = input;
  const tz = poll.timezone;
  const squad = squadOf(picks);
  const mains = mainHolders(picks);
  const mine = squad.get(viewerId) ?? { main: null, second: null };
  const { map, mixed } = squadMap(slots, input.now ?? new Date());
  const { comps, general } = compsFor(map);

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
  const portraitOf = (key: string) => (emojis?.get(key) ? `${emojiMarkup(emojis.get(key)!)} ` : "");

  // ---- header: one block per idea, a blank line between them
  const slotLines = slots.map((s, i) => `${formatSlotDay(s.scheduledAt, tz)} · ${formatSlotTime(s.queueAt ?? s.scheduledAt, tz)}${i === 0 ? ` · <t:${Math.floor(effectiveAt(s).getTime() / 1000)}:R>` : ""}`);
  const mapLine = map
    ? `🗺️ **MAP: ${map.toUpperCase()}**${mixed ? " _(some slots use another map — see the schedule)_" : ""}`
    : "🗺️ **MAP: TBD** — an admin sets it with `/schedule-slot`";
  const compBlocks = comps.map((comp, i) => {
    const line = comp.agents.map((key) => `${iconOf(key)} ${nameOf(key)}${mains.has(key) ? " ✅" : ""}`).join("  ·  ");
    return `${i === 0 ? "🅰️" : "🅱️"} **COMP ${COMP_LETTER[i]} — ${comp.name}${general ? " (general)" : ""}**\n${line}`;
  });
  const myPicks = [
    `🎯 **YOUR MAIN:** ${mine.main ? `**${nameOf(mine.main)}**` : "_none yet — tap an agent below_"}`,
    `🎒 **YOUR SECOND:** ${mine.second ? `**${nameOf(mine.second)}**` : mine.main ? "_optional — tap **Pick a second agent** if you want a backup_" : "_optional — after you pick a main_"}`,
  ].join("\n");
  const squadMembers = [...squad.entries()].filter(([, e]) => e.main);
  const header = new EmbedBuilder()
    .setColor(COLOR_HEADER)
    .setTitle("◢ AGENT PICK ◣")
    .setDescription(
      [
        `📅 **ONE SQUAD FOR EVERY SLOT**\n${slotLines.join("\n")}\n${mapLine}`,
        myPicks,
        ...compBlocks,
        ...(squadMembers.length > 0
          ? [
              `🔒 **SQUAD · ${squadMembers.length} locked**\n${squadMembers
                .map(([id, e]) => `<@${id}> — ${portraitOf(e.main!)}**${nameOf(e.main!)}**${e.second ? `  ·  2nd ${portraitOf(e.second)}${nameOf(e.second)}` : ""}`)
                .join("\n")}`,
            ]
          : []),
      ].join("\n\n"),
    );
  if (mine.main) {
    const portrait = agentByKey(mine.main);
    if (portrait) header.setThumbnail(agentIconUrl(portrait)); // the selected agent, big — like the centre of the game's select screen
  }

  // ---- the open tab: suggested agents first, then the other options, three across
  const all = agentsForRole(tab, customAgents);
  const ordered = [...all.filter((a) => suggestedBy.has(a.key)), ...all.filter((a) => !suggestedBy.has(a.key))];
  /** What each agent's cell and button say, for the pick being chosen. A main is exclusive; a second may overlap. */
  const stateOf = (key: string): { status: string; selectable: boolean; mineHere: boolean; takenMain: boolean } => {
    const holder = mains.get(key);
    if (target === "MAIN") {
      if (holder === viewerId) return { status: "✅ **YOUR MAIN**", selectable: true, mineHere: true, takenMain: false };
      if (holder) return { status: `🔒 <@${holder}>`, selectable: false, mineHere: false, takenMain: true };
      if (mine.second === key) return { status: "🔁 your second", selectable: true, mineHere: false, takenMain: false };
      return { status: "🟢 Open", selectable: true, mineHere: false, takenMain: false };
    }
    if (mine.main === key) return { status: "⭐ your main", selectable: false, mineHere: false, takenMain: false };
    if (mine.second === key) return { status: "✅ **YOUR 2ND**", selectable: true, mineHere: true, takenMain: false };
    return { status: holder ? `🎯 <@${holder}>'s main` : "🟢 Open", selectable: true, mineHere: false, takenMain: false };
  };
  const cells = ordered.slice(0, MAX_AGENT_BUTTONS).map((a) => {
    const st = stateOf(a.key);
    const tags = suggestedBy.has(a.key) ? `⭐ ${suggestedBy.get(a.key)!.join(", ")}` : a.custom ? `➕ by <@${a.custom.suggestedByUserId}>` : null;
    return {
      name: `${a.custom ? ROLE_GLYPH[tab] : iconOf(a.key)} ${a.name.toUpperCase()}`.slice(0, 256),
      value: tags ? `${st.status}\n${tags}` : st.status,
      inline: true,
    };
  });
  const agents = new EmbedBuilder()
    .setColor(COLOR_AGENTS)
    .setTitle(`${ROLE_GLYPH[tab]} ${ROLE_LABEL[tab].toUpperCase()} — choosing your ${target === "MAIN" ? "MAIN" : "SECOND"}`)
    .setDescription(`_${ROLE_BLURB[tab]}_`)
    .addFields(cells)
    .setFooter({ text: `PREMIER · Schedule #${poll.id} · same pick for every slot · each main is picked once` });

  // ---- buttons
  const rows: ActionRowBuilder<ButtonBuilder>[] = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      ROLE_ORDER.map((r) =>
        new ButtonBuilder()
          .setCustomId(agentRoleId(poll.id, r, target))
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
          const st = stateOf(a.key);
          const button = new ButtonBuilder()
            .setCustomId(agentPickId(poll.id, a.key, target))
            .setLabel(st.takenMain ? `${a.name} 🔒`.slice(0, 80) : a.name.slice(0, 80))
            .setStyle(st.mineHere ? ButtonStyle.Success : suggestedBy.has(a.key) && st.selectable ? ButtonStyle.Primary : ButtonStyle.Secondary)
            .setDisabled(!st.selectable);
          const portrait = a.custom ? undefined : emojis?.get(a.key);
          if (portrait) button.setEmoji({ id: portrait.id, name: portrait.name });
          return button;
        }),
      ),
    );
  }
  const actions = [
    target === "MAIN"
      ? new ButtonBuilder().setCustomId(agentTargetId(poll.id, tab, "SECOND")).setLabel("Pick a second agent").setEmoji("🎒").setStyle(ButtonStyle.Primary).setDisabled(!mine.main)
      : new ButtonBuilder().setCustomId(agentTargetId(poll.id, tab, "MAIN")).setLabel("Back to my main").setEmoji("🎯").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(agentAddId(poll.id, tab, target)).setLabel("Add an agent").setEmoji("➕").setStyle(ButtonStyle.Secondary),
  ];
  if (mine.second) actions.push(new ButtonBuilder().setCustomId(agentClearId(poll.id, tab, "SECOND")).setLabel("Clear second").setStyle(ButtonStyle.Secondary));
  actions.push(new ButtonBuilder().setCustomId(agentClearId(poll.id, tab, "ALL")).setLabel("Clear my picks").setStyle(ButtonStyle.Danger).setDisabled(!mine.main));
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(actions));

  // `content` is always a string: an edit that omits it would leave the previous notice on screen.
  return { content: input.notice ?? "", embeds: [header, agents], components: rows };
}

export { ROLE_SINGULAR };
