import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, escapeMarkdown } from "discord.js";
import type { ScheduleView } from "../../database/repositories/scheduleRepository.js";
import type { CustomAgentRow, ScheduleSlotRow } from "../../database/schema/schedules.js";
import { buildAgentsCustomId } from "../schedules/scheduleCustomId.js";
import { MIN_PLAYERS_TO_QUEUE, effectiveAt, formatSlotDay, formatSlotTime } from "../schedules/scheduleLogic.js";
import { agentByKey, ROLE_GLYPH, ROLE_ORDER, type AgentRole } from "./agentData.js";
import { agentIconText, type AgentEmojiMap } from "./agentEmojis.js";
import { agentNameFor } from "./agentPanel.js";
import { squadMap, squadOf } from "./squad.js";

/**
 * The "AGENT SELECT" lineup (2026-10-07, owner's request): ONE public message
 * per schedule, visible to everyone, that shows the agents picked so far and
 * who picked each — the team's version of the lineup bar at the top of
 * Valorant's agent-select screen. It is edited in place whenever a vote or a
 * pick changes (discord/agentBoardSync.ts), and carries the 🎯 PICK AGENT
 * button so it is also a way in.
 *
 * Since 2026-10-15 (owner's request) it is **one squad for the whole schedule**,
 * not one block per slot: every player who is in at least one slot has a main
 * agent and, if they chose one, a second, and the same pair applies to every
 * slot that week. So this is a single card: the map, how many of the squad have
 * locked in, the picks side by side (main agent over player, with the second
 * underneath, three across, ordered Duelists → Initiators → Controllers →
 * Sentinels), then the players who haven't picked a main yet. Which slots each
 * player is in stays on the schedule card.
 *
 * Pure and database-only (plan section 14): no model writes anything here, and
 * it only repeats what the schedule card already shows publicly — who voted and
 * which agent they took. Mentions inside embeds never notify anyone.
 */

export interface AgentBoardMessage {
  content: string;
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
}

const COLOR_RED = 0xff4655;
const COLOR_LOCKED = 0x3bd671;
/**
 * Players shown, tried in order until the message fits Discord's limit of 6000 characters. A real team (6–7 players)
 * fits at the first size; only a guild with no roster yet, where anyone can vote, can need the smaller ones — the
 * rest are summarised as "+N more".
 */
const PLAYERS_SHOWN_STEPS = [22, 12, 8, 5, 3, 2, 1]; // 22 + "and N more" + "still choosing" = 24 fields, under Discord's cap of 25
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

  // The squad: everyone who is in at least one slot that is still ahead (a slot that has started is history).
  const upcoming = view.slots.filter((s) => effectiveAt(s).getTime() > now.getTime());
  const upcomingIds = new Set(upcoming.map((s) => s.id));
  const squadIds = [...new Set(view.votes.filter((v) => upcomingIds.has(v.slotId)).map((v) => v.discordUserId))];
  const picks = squadOf(view.picks);
  const locked = squadIds.filter((id) => picks.get(id)?.main);
  const choosing = squadIds.filter((id) => !picks.get(id)?.main);

  function squadEmbed(maxShown: number): EmbedBuilder {
    // Valorant's lineup order: by role, then by name.
    const lineup = locked
      .map((userId) => ({ userId, main: picks.get(userId)!.main!, second: picks.get(userId)!.second }))
      .sort((a, b) => {
        const ra = ROLE_ORDER.indexOf(roleOf(a.main) ?? "SENTINEL");
        const rb = ROLE_ORDER.indexOf(roleOf(b.main) ?? "SENTINEL");
        return ra - rb || agentNameFor(a.main, customAgents).localeCompare(agentNameFor(b.main, customAgents));
      });
    const { map, mixed } = squadMap(upcoming, now);
    const embed = new EmbedBuilder()
      .setColor(locked.length >= MIN_PLAYERS_TO_QUEUE ? COLOR_LOCKED : COLOR_RED)
      .setTitle("◢ THE SQUAD ◣")
      .setDescription(describeSquad(upcoming, map, mixed, tz, locked.length, squadIds.length));

    embed.addFields(
      lineup.slice(0, maxShown).map((l) => ({
        name: `${iconOf(l.main)} ${agentNameFor(l.main, customAgents).toUpperCase()}`.slice(0, 256),
        value: `<@${l.userId}>${l.second ? `\n↳ 2nd: ${iconOf(l.second)} ${escapeMarkdown(agentNameFor(l.second, customAgents))}` : ""}`,
        inline: true,
      })),
    );
    if (lineup.length > maxShown) embed.addFields({ name: "…", value: `and ${lineup.length - maxShown} more`, inline: true });
    if (choosing.length > 0) {
      const shown = choosing.slice(0, maxShown).map((id) => `<@${id}>`).join("  ·  ");
      embed.addFields({ name: "⏳ STILL CHOOSING", value: choosing.length > maxShown ? `${shown}  ·  +${choosing.length - maxShown} more` : shown });
    }
    return embed;
  }

  // Discord caps all embeds together at 6000 characters: show fewer players until it fits.
  let embeds: EmbedBuilder[] = [];
  if (squadIds.length > 0) {
    for (const shown of PLAYERS_SHOWN_STEPS) {
      embeds = [squadEmbed(shown)];
      if (JSON.stringify(embeds[0]!.toJSON()).length <= EMBED_BUDGET) break;
    }
    embeds[0]!.setFooter({ text: `PREMIER · Schedule #${poll.id} · updates live` });
  }

  const content = [
    "# 🎯 AGENT SELECT",
    "-# PREMIER · ONE SQUAD FOR EVERY SLOT · a main each (no duplicates) + an optional second",
    ...(embeds.length === 0 ? ["", "Nobody has locked in a slot yet. Vote on the schedule, then tap **PICK AGENT**."] : []),
  ].join("\n");

  const components = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(buildAgentsCustomId(poll.id)).setLabel("PICK AGENT").setEmoji("🎯").setStyle(ButtonStyle.Primary),
    ),
  ];
  return { content, embeds, components };
}

function describeSquad(upcoming: readonly ScheduleSlotRow[], map: string | null, mixed: boolean, tz: string, locked: number, squadSize: number): string {
  const slots = upcoming.map((s) => `${formatSlotDay(s.scheduledAt, tz)} ${formatSlotTime(s.scheduledAt, tz)}`).join("  ·  ");
  const parts = [map ? `🗺️ **${escapeMarkdown(map.toUpperCase())}**${mixed ? " (+ others)" : ""}` : "🗺️ **MAP TBD**", `🔒 **${locked}/${squadSize}** locked in`];
  return [`📅 ${slots}`, parts.join("  ·  ")].join("\n");
}
