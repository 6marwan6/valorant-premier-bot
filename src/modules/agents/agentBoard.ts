import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, escapeMarkdown } from "discord.js";
import type { ScheduleView } from "../../database/repositories/scheduleRepository.js";
import type { CustomAgentRow, ScheduleSlotRow } from "../../database/schema/schedules.js";
import { buildAgentsCustomId } from "../schedules/scheduleCustomId.js";
import { MIN_PLAYERS_TO_QUEUE, effectiveAt, formatSlotDay, formatSlotTime } from "../schedules/scheduleLogic.js";
import { agentByKey, ROLE_GLYPH, ROLE_ORDER, type AgentRole } from "./agentData.js";
import { agentIconText, type AgentEmojiMap } from "./agentEmojis.js";
import { agentNameFor } from "./agentPanel.js";

/**
 * The "AGENT SELECT" lineup (2026-10-07, owner's request): ONE public message
 * per schedule, visible to everyone, that shows the agents picked so far and
 * who picked each — the team's version of the lineup bar at the top of
 * Valorant's agent-select screen. It is edited in place whenever a vote or a
 * pick changes (discord/agentBoardSync.ts), and carries the 🎯 PICK AGENT
 * button so it is also a way in.
 *
 * Per slot that has votes: the map, how many of the voters have locked in, then
 * the picks side by side (agent over player, three across, ordered Duelists →
 * Initiators → Controllers → Sentinels), then the voters who haven't picked yet.
 *
 * Pure and database-only (plan section 14): no model writes anything here, and
 * it only repeats what the schedule card already shows publicly — who voted for
 * a slot and which agent they took. Mentions inside embeds never notify anyone.
 */

export interface AgentBoardMessage {
  content: string;
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
}

const COLOR_RED = 0xff4655;
const COLOR_LOCKED = 0x3bd671;
/**
 * Players shown per slot, tried in order until the whole message fits Discord's limit of 6000 characters across all
 * embeds. A real team (6–7 players, a few slots) fits at the first size; only a guild with no roster yet, where anyone
 * can vote, can need the smaller ones — the rest are summarised as "+N more".
 */
const PLAYERS_SHOWN_STEPS = [12, 8, 5, 3, 2, 1];
const EMBED_BUDGET = 5800;

export function buildAgentBoard(view: ScheduleView, customAgents: readonly CustomAgentRow[] = [], emojis?: AgentEmojiMap, now: Date = new Date()): AgentBoardMessage {
  const { poll } = view;
  if (poll.status === "CANCELLED") {
    return { content: "# 🎯 AGENT SELECT\n-# PREMIER · this schedule was cancelled", embeds: [], components: [] };
  }
  const tz = poll.timezone;

  const roleOf = (key: string): AgentRole | undefined => agentByKey(key)?.role ?? customAgents.find((c) => c.key === key)?.role;
  const iconOf = (key: string) => {
    const role = roleOf(key);
    return agentIconText(key, role ? ROLE_GLYPH[role] : "▫️", emojis);
  };

  function slotEmbeds(maxShown: number): EmbedBuilder[] {
    const embeds: EmbedBuilder[] = [];
    for (const slot of view.slots) {
      if (effectiveAt(slot).getTime() <= now.getTime()) continue; // a slot that has started is history
      const voters = view.votes.filter((v) => v.slotId === slot.id);
      if (voters.length === 0) continue;

      const pickOf = new Map(view.picks.filter((p) => p.slotId === slot.id).map((p) => [p.discordUserId, p.agentKey]));
      const locked = voters.filter((v) => pickOf.has(v.discordUserId));
      const choosing = voters.filter((v) => !pickOf.has(v.discordUserId));

      // Valorant's lineup order: by role, then by name.
      const lineup = locked
        .map((v) => ({ userId: v.discordUserId, key: pickOf.get(v.discordUserId)! }))
        .sort((a, b) => {
          const ra = ROLE_ORDER.indexOf(roleOf(a.key) ?? "SENTINEL");
          const rb = ROLE_ORDER.indexOf(roleOf(b.key) ?? "SENTINEL");
          return ra - rb || agentNameFor(a.key, customAgents).localeCompare(agentNameFor(b.key, customAgents));
        });

      const embed = new EmbedBuilder()
        .setColor(voters.length >= MIN_PLAYERS_TO_QUEUE ? COLOR_LOCKED : COLOR_RED)
        .setTitle(`◢ ${formatSlotDay(slot.scheduledAt, tz)} · ${formatSlotTime(slot.scheduledAt, tz)} ◣`)
        .setDescription(describeSlot(slot, tz, locked.length, voters.length));

      embed.addFields(
        lineup.slice(0, maxShown).map((l) => ({
          name: `${iconOf(l.key)} ${agentNameFor(l.key, customAgents).toUpperCase()}`.slice(0, 256),
          value: `<@${l.userId}>`,
          inline: true,
        })),
      );
      if (lineup.length > maxShown) embed.addFields({ name: "…", value: `and ${lineup.length - maxShown} more`, inline: true });
      if (choosing.length > 0) {
        const shown = choosing.slice(0, maxShown).map((v) => `<@${v.discordUserId}>`).join("  ·  ");
        embed.addFields({ name: "⏳ STILL CHOOSING", value: choosing.length > maxShown ? `${shown}  ·  +${choosing.length - maxShown} more` : shown });
      }
      embeds.push(embed);
    }
    return embeds;
  }

  // Discord caps all embeds together at 6000 characters: show fewer players per slot until it fits.
  const total = (list: EmbedBuilder[]) => list.reduce((n, e) => n + JSON.stringify(e.toJSON()).length, 0);
  let embeds: EmbedBuilder[] = [];
  for (const shown of PLAYERS_SHOWN_STEPS) {
    embeds = slotEmbeds(shown);
    if (total(embeds) <= EMBED_BUDGET) break;
  }

  if (embeds.length > 0) embeds[embeds.length - 1]!.setFooter({ text: `PREMIER · Schedule #${poll.id} · updates live` });

  const content = [
    "# 🎯 AGENT SELECT",
    "-# PREMIER · THE LINEUP SO FAR · one agent each, no duplicates",
    ...(embeds.length === 0 ? ["", "Nobody has locked in a slot yet. Vote on the schedule, then tap **PICK AGENT**."] : []),
  ].join("\n");

  const components = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(buildAgentsCustomId(poll.id)).setLabel("PICK AGENT").setEmoji("🎯").setStyle(ButtonStyle.Primary),
    ),
  ];
  return { content, embeds, components };
}

function describeSlot(slot: ScheduleSlotRow, tz: string, locked: number, voters: number): string {
  const parts = [slot.map ? `🗺️ **${escapeMarkdown(slot.map.toUpperCase())}**` : "🗺️ **MAP TBD**"];
  if (slot.queueAt) parts.push(`🎮 queue **${formatSlotTime(slot.queueAt, tz)}**`);
  parts.push(`🔒 **${locked}/${voters}** locked in`);
  return parts.join("  ·  ");
}
