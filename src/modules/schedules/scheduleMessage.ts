import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, escapeMarkdown } from "discord.js";
import { DateTime } from "luxon";
import type { ScheduleView } from "../../database/repositories/scheduleRepository.js";
import type { AgentPickRow, ScheduleSlotRow, ScheduleVoteRow } from "../../database/schema/schedules.js";
import { buildAgentsCustomId, buildDeclineCustomId, buildVoteCustomId } from "./scheduleCustomId.js";
import { agentNameFor } from "../agents/agentPanel.js";
import type { CustomAgentRow } from "../../database/schema/schedules.js";
import { effectiveAt, formatSlotDay, formatSlotTime, MIN_PLAYERS_TO_QUEUE, pickLeadingSlot, voteBar } from "./scheduleLogic.js";
import { formatOffsetLabel } from "../reminders/reminderScheduling.js";

/**
 * Everything the weekly schedule shows: the poll card (its own message,
 * edited in place), the one-time "squad locked" card and the 5h / 15min
 * reminders. All of it is built from the database by the app — no LLM touches
 * a fact on these messages (plan section 14, principle #9).
 *
 * Look: Valorant's own red (#FF4655) on near-black, angular `◢ ◣` brackets,
 * ALL-CAPS headers and a monospaced board — the "Premier" look, within what a
 * Discord embed can do.
 */

export interface SchedulePlayer {
  discordUserId: string;
  displayName: string;
  role?: "DUELIST" | "INITIATOR" | "CONTROLLER" | "SENTINEL" | null;
  preferredAgent?: string | null;
}

export interface ScheduleMessage {
  content: string;
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
}

const COLOR_RED = 0xff4655; // Valorant red: open / waiting for a squad
const COLOR_LOCKED = 0x3bd671; // a slot has its squad
const COLOR_AMBER = 0xf5a623;
const COLOR_CANCELLED = 0x4f545c;
const COLOR_DARK = 0x2d3a4a; // Valorant's dark slate — the quieter second card

const NUMBER_EMOJI = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
const ROLE_GLYPH = { DUELIST: "⚔️", INITIATOR: "🔎", CONTROLLER: "☁️", SENTINEL: "🛡️" } as const;

function unix(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/**
 * `⚔️ <@id>` — a real @mention (2026-10-04): it renders as the person's name
 * and is clickable. Mentions inside an embed never notify anyone; the pings
 * come from the message text (see `rosterPings`), once, when the schedule is
 * posted. Role glyph from the profile when the person is on the roster.
 */
function nameOf(userId: string, profiles: Map<string, SchedulePlayer>): string {
  const p = profiles.get(userId);
  const glyph = p?.role ? `${ROLE_GLYPH[p.role]} ` : "";
  return `${glyph}<@${userId}>`;
}

/** `⚔️ <@id> · **Jett**` — a person with the agent they picked for this slot. */
function withPick(userId: string, profiles: Map<string, SchedulePlayer>, picks: Map<string, string>): string {
  const pick = picks.get(userId);
  return `${nameOf(userId, profiles)}${pick ? ` · **${escapeMarkdown(pick)}**` : ""}`;
}

/** slot id -> (user id -> agent display name). */
function picksBySlot(picks: readonly AgentPickRow[], customAgents: readonly CustomAgentRow[]): Map<number, Map<string, string>> {
  const out = new Map<number, Map<string, string>>();
  for (const p of picks) {
    const inner = out.get(p.slotId) ?? new Map<string, string>();
    inner.set(p.discordUserId, agentNameFor(p.agentKey, customAgents));
    out.set(p.slotId, inner);
  }
  return out;
}

/** The notification line: every Premier player on the roster, @mentioned, so posting the schedule pings the team. */
export function rosterPings(roster: readonly SchedulePlayer[]): string {
  return roster.map((p) => `<@${p.discordUserId}>`).join(" ");
}

function votesBySlot(votes: readonly ScheduleVoteRow[]): Map<number, ScheduleVoteRow[]> {
  const map = new Map<number, ScheduleVoteRow[]>();
  for (const v of votes) map.set(v.slotId, [...(map.get(v.slotId) ?? []), v]);
  return map;
}

function dateRange(slots: readonly ScheduleSlotRow[], tz: string): string {
  const first = DateTime.fromJSDate(slots[0]!.scheduledAt, { zone: tz });
  const last = DateTime.fromJSDate(slots[slots.length - 1]!.scheduledAt, { zone: tz });
  const f = (d: DateTime) => d.toFormat("dd LLL").toUpperCase();
  return first.hasSame(last, "day") ? f(first) : `${f(first)} – ${f(last)}`;
}

/** The monospaced schedule board. One row per slot, aligned, with the vote bar and a marker for the leader. */
function buildBoard(view: ScheduleView, counts: Map<number, number>, leaderId: number | null, now: Date): string {
  const tz = view.poll.timezone;
  const timeCell = (s: ScheduleSlotRow) => {
    const t = formatSlotTime(s.scheduledAt, tz);
    return s.queueAt ? `${t}▸${formatSlotTime(s.queueAt, tz)}` : t;
  };
  const timeWidth = Math.max(4, ...view.slots.map((s) => timeCell(s).length));
  // A MAP column only once someone has set a map, so an unplanned week doesn't carry a column of dashes.
  const showMap = view.slots.some((s) => s.map);
  const mapWidth = Math.max(3, ...view.slots.map((s) => (s.map ?? "—").length));
  const mapHead = showMap ? `${"MAP".padEnd(mapWidth)}  ` : "";
  const lines = [` #  ${"DAY".padEnd(9)}  ${"TIME".padEnd(timeWidth)}  ${mapHead}SQUAD`];
  for (const s of view.slots) {
    const n = counts.get(s.id) ?? 0;
    const past = effectiveAt(s).getTime() <= now.getTime();
    const marker = past ? "  · done" : s.id === leaderId ? "  ★ ON" : n >= MIN_PLAYERS_TO_QUEUE ? "  ✔" : "";
    const mapCell = showMap ? `${(s.map ?? "—").padEnd(mapWidth)}  ` : "";
    lines.push(`${String(s.position).padStart(2)}  ${formatSlotDay(s.scheduledAt, tz)}  ${timeCell(s).padEnd(timeWidth)}  ${mapCell}${voteBar(n)} ${n}/${MIN_PLAYERS_TO_QUEUE}${marker}`);
  }
  return "```\n" + lines.join("\n") + "\n```";
}

const DESCRIPTION_LIMIT = 4096;
/** Discord caps all embeds of one message at 6000 characters together; this leaves room for titles and footers. */
const EMBED_TOTAL_BUDGET = 5800;

function capDescription(text: string, limit: number = DESCRIPTION_LIMIT): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(limit - 1, 0))}…`;
}

/**
 * The weekly schedule card. `roster` (active players) is optional: with it
 * the card also lists who hasn't voted yet; without it (a guild that hasn't
 * run /add-player) that section is simply omitted rather than invented.
 *
 * Layout (re-spaced 2026-10-07, "so crowded"): two embeds instead of one packed
 * one. The first is the status — what's needed, the board, whether a match is
 * on. The second is "who's in": one block per slot with a blank line between
 * blocks, then the people who can't play and who hasn't voted. Written as
 * description text rather than a stack of fields so the gaps are real gaps.
 */
export function buildScheduleMessage(view: ScheduleView, roster: SchedulePlayer[] = [], now: Date = new Date(), customAgents: CustomAgentRow[] = []): ScheduleMessage {
  const { poll, slots } = view;
  const tz = poll.timezone;
  const cancelled = poll.status === "CANCELLED";
  const profiles = new Map(roster.map((p) => [p.discordUserId, p]));
  const bySlot = votesBySlot(view.votes);
  const counts = new Map(slots.map((s) => [s.id, bySlot.get(s.id)?.length ?? 0]));
  const leader = cancelled ? null : pickLeadingSlot(slots, counts, now);
  const picksFor = picksBySlot(view.picks ?? [], customAgents);

  // The roster is @mentioned in the message text, so posting the schedule notifies the team (the card itself is an embed, and an embed never pings). Edits don't re-notify: they are sent with mentions suppressed.
  const pings = !cancelled && roster.length > 0 ? `\n${rosterPings(roster)}` : "";
  const content = `# ◢◤ VALORANT PREMIER ◥◣\n-# WEEKLY SCHEDULE · ${cancelled ? "CANCELLED" : "VOTE YOUR AVAILABILITY"}${pings}`;

  const status = new EmbedBuilder()
    .setColor(cancelled ? COLOR_CANCELLED : leader ? COLOR_LOCKED : COLOR_RED)
    .setTitle(cancelled ? `~~PREMIER WEEK · ${dateRange(slots, tz)}~~` : `◢ PREMIER WEEK · ${dateRange(slots, tz)} ◣`);

  if (cancelled) {
    status.setDescription("🚫 **This schedule was cancelled.**");
    status.setFooter({ text: `Schedule #${poll.id} · cancelled` });
    return { content, embeds: [status], components: [] };
  }

  const verdict: string[] = [];
  if (leader) {
    const at = unix(effectiveAt(leader));
    const queue = leader.queueAt ? ` · **queue ${formatSlotTime(leader.queueAt, tz)}**` : "";
    verdict.push(`🔥 **MATCH ON → ${formatSlotDay(leader.scheduledAt, tz)} · ${formatSlotTime(leader.scheduledAt, tz)}**${queue} · <t:${at}:R>`);
  } else {
    const open = slots.filter((s) => effectiveAt(s).getTime() > now.getTime() && s.remindMode !== "NEVER");
    const best = open.reduce<ScheduleSlotRow | null>((b, s) => (b === null || (counts.get(s.id) ?? 0) > (counts.get(b.id) ?? 0) ? s : b), null);
    if (best) {
      const missing = MIN_PLAYERS_TO_QUEUE - (counts.get(best.id) ?? 0);
      verdict.push(`⏳ No squad yet — **${formatSlotDay(best.scheduledAt, tz)} ${formatSlotTime(best.scheduledAt, tz)}** needs **${missing}** more.`);
    } else {
      verdict.push("⏳ Every slot has passed.");
    }
  }
  status.setDescription(
    [`**Need ${MIN_PLAYERS_TO_QUEUE} to queue.** Tap every slot you can play — tap again to take it back.`, buildBoard(view, counts, leader?.id ?? null, now), ...verdict].join("\n\n"),
  );

  // ---- who's in: a block per slot, blank line between blocks
  const blocks: string[] = slots.map((s) => {
    const voters = bySlot.get(s.id) ?? [];
    const heading = `${NUMBER_EMOJI[s.position - 1] ?? s.position}  **${formatSlotDay(s.scheduledAt, tz)} · ${formatSlotTime(s.scheduledAt, tz)}**${s.map ? ` · 🗺️ ${s.map.toUpperCase()}` : ""}  —  **${voters.length}/${MIN_PLAYERS_TO_QUEUE}**`;
    const slotPicks = picksFor.get(s.id) ?? new Map<string, string>();
    const people = voters.length ? voters.map((v) => withPick(v.discordUserId, profiles, slotPicks)).join(slotPicks.size > 0 ? "\n" : "  ·  ") : "_no votes yet_";
    return `${heading}\n${people}`;
  });
  const out: string[] = [];
  if (view.declines.length > 0) {
    out.push(`🚫 **Can't play any day** · ${view.declines.length}\n${view.declines.map((d) => nameOf(d.discordUserId, profiles)).join("  ·  ")}`);
  }
  if (roster.length > 0) {
    const answered = new Set([...view.votes.map((v) => v.discordUserId), ...view.declines.map((d) => d.discordUserId)]);
    const waiting = roster.filter((p) => !answered.has(p.discordUserId));
    if (waiting.length > 0) out.push(`⚪ **No vote yet** · ${waiting.length}\n${waiting.map((p) => nameOf(p.discordUserId, profiles)).join("  ·  ")}`);
  }
  const whoIsIn = new EmbedBuilder()
    .setColor(COLOR_DARK)
    .setTitle("WHO'S IN")
    .setFooter({ text: `PREMIER · Schedule #${poll.id} · reminders 5h and 15min before queue` });
  // The "who's in" text gets whatever the status embed leaves of the 6000-character message budget.
  const room = Math.min(DESCRIPTION_LIMIT, EMBED_TOTAL_BUDGET - JSON.stringify(status.toJSON()).length - JSON.stringify(whoIsIn.toJSON()).length);
  whoIsIn.setDescription(capDescription([...blocks, ...out].join("\n\n"), room));

  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < slots.length; i += 5) {
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        slots.slice(i, i + 5).map((s) =>
          new ButtonBuilder()
            .setCustomId(buildVoteCustomId(poll.id, s.id))
            .setLabel(`${formatSlotDay(s.scheduledAt, tz).slice(0, 3)} ${formatSlotTime(s.scheduledAt, tz)}`)
            .setEmoji(NUMBER_EMOJI[s.position - 1] ?? "🗓️")
            .setStyle(counts.get(s.id)! >= MIN_PLAYERS_TO_QUEUE ? ButtonStyle.Success : ButtonStyle.Secondary)
            .setDisabled(effectiveAt(s).getTime() <= now.getTime()),
        ),
      ),
    );
  }
  components.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(buildDeclineCustomId(poll.id)).setLabel("CAN'T PLAY ANY DAY").setEmoji("🚫").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(buildAgentsCustomId(poll.id)).setLabel("PICK AGENT").setEmoji("🎯").setStyle(ButtonStyle.Primary),
    ),
  );
  return { content, embeds: [status, whoIsIn], components };
}

/** One line per person for lineups: `⚔️ <@id> · **Jett**` — the agent they picked for this slot, else their profile's preferred agent. */
function lineupLine(userId: string, profiles: Map<string, SchedulePlayer>, picks: Map<string, string>): string {
  const picked = picks.get(userId);
  const preferred = profiles.get(userId)?.preferredAgent;
  const agent = picked ? ` · **${escapeMarkdown(picked)}**` : preferred ? ` · ${escapeMarkdown(preferred)}` : "";
  return `${nameOf(userId, profiles)}${agent}`;
}

function mentions(userIds: string[]): string {
  return userIds.map((id) => `<@${id}>`).join(" ");
}

/** The one-time "we have a squad" card, posted by the vote that first brings a slot to quorum. Pings the voters. */
export function buildQuorumMessage(
  slot: ScheduleSlotRow,
  voters: ScheduleVoteRow[],
  roster: SchedulePlayer[],
  timezone: string,
  picks: readonly AgentPickRow[] = [],
  customAgents: readonly CustomAgentRow[] = [],
): { content: string; embeds: EmbedBuilder[]; mentionUserIds: string[] } {
  const profiles = new Map(roster.map((p) => [p.discordUserId, p]));
  const slotPicks = picksBySlot(picks.filter((p) => p.slotId === slot.id), customAgents).get(slot.id) ?? new Map<string, string>();
  const ids = voters.map((v) => v.discordUserId);
  const at = unix(effectiveAt(slot));
  const lines = [
    `${"🟩".repeat(Math.min(voters.length, 10))}  **${voters.length}/${MIN_PLAYERS_TO_QUEUE}**`,
    "",
    ...voters.map((v) => lineupLine(v.discordUserId, profiles, slotPicks)),
    "",
    ...(slot.map ? [`🗺️ **Map: ${slot.map}**`] : []),
    slot.queueAt
      ? `🎮 **Queue ${formatSlotTime(slot.queueAt, timezone)}** (slot ${formatSlotTime(slot.scheduledAt, timezone)}) · <t:${at}:R>`
      : `🎮 **Queue ${formatSlotTime(slot.scheduledAt, timezone)}** · <t:${at}:R>`,
    "⏰ Reminders land **5 hours** and **15 minutes** before.",
  ];
  const embed = new EmbedBuilder()
    .setColor(COLOR_LOCKED)
    .setTitle(`◢ SQUAD LOCKED · ${formatSlotDay(slot.scheduledAt, timezone)} ${formatSlotTime(slot.scheduledAt, timezone)} ◣`)
    .setDescription(lines.join("\n"))
    .setFooter({ text: "PREMIER · MATCH ON" });
  return { content: `# 🔥 WE HAVE A SQUAD\n${mentions(ids)}`, embeds: [embed], mentionUserIds: ids };
}

/**
 * The 5h / 15min reminder. Counted back from the *queue* time when the admin
 * set one — "we're queuing at 7:30" — and says so plainly. Pings the voters
 * for this slot (an embed alone never notifies anyone).
 */
export function buildSlotReminderMessage(
  slot: ScheduleSlotRow,
  voters: ScheduleVoteRow[],
  roster: SchedulePlayer[],
  timezone: string,
  offsetMinutes: number,
  pollId: number,
  picks: readonly AgentPickRow[] = [],
  customAgents: readonly CustomAgentRow[] = [],
): { content: string; embeds: EmbedBuilder[]; mentionUserIds: string[] } {
  const profiles = new Map(roster.map((p) => [p.discordUserId, p]));
  const slotPicks = picksBySlot(picks.filter((p) => p.slotId === slot.id), customAgents).get(slot.id) ?? new Map<string, string>();
  const ids = voters.map((v) => v.discordUserId);
  const imminent = offsetMinutes <= 20;
  const at = unix(effectiveAt(slot));
  const dayTime = `${formatSlotDay(slot.scheduledAt, timezone)} · ${formatSlotTime(slot.scheduledAt, timezone)}`;

  const description = [`**${dayTime}**`];
  if (slot.queueAt) {
    description.push(`🎮 **QUEUE AT ${formatSlotTime(slot.queueAt, timezone)}** · <t:${at}:R>`, `_(slot time ${formatSlotTime(slot.scheduledAt, timezone)} — we're queuing later)_`);
  } else {
    description.push(`🎮 **QUEUE AT ${formatSlotTime(slot.scheduledAt, timezone)}** · <t:${at}:R>`);
  }
  if (slot.map) description.push(`🗺️ **Map: ${slot.map}**`);
  description.push("", ...voters.map((v) => lineupLine(v.discordUserId, profiles, slotPicks)));

  const label = formatOffsetLabel(offsetMinutes).toUpperCase();
  const embed = new EmbedBuilder()
    .setColor(imminent ? COLOR_RED : COLOR_AMBER)
    .setTitle(imminent ? `🚨 ${label} — GET IN THE LOBBY` : `⏰ ${label} TO PREMIER`)
    .setDescription(description.join("\n"))
    .setFooter({ text: `PREMIER · Schedule #${pollId} · slot ${slot.position}` });
  return { content: `${imminent ? "# 🚨 PREMIER IN " : "# ⏰ PREMIER IN "}${label}\n${mentions(ids)}`, embeds: [embed], mentionUserIds: ids };
}

/**
 * Mari's public reaction to a schedule vote: the model's one line inside a
 * card, with everything else (headline, colour, the player's role/agent, the
 * slot) from the database — same look as the attendance reaction card. Posted
 * with an @mention by the caller; an embed alone never pings.
 */
export function buildScheduleReactionCard(params: {
  player: SchedulePlayer;
  kind: "VOTE" | "DECLINE";
  text: string;
  pollId: number;
  /** The slot voted for (VOTE only). */
  slot?: ScheduleSlotRow;
  timezone: string;
  avatarUrl?: string | null;
}): { embeds: EmbedBuilder[] } {
  const { player, kind } = params;
  const embed = new EmbedBuilder()
    .setColor(kind === "VOTE" ? COLOR_LOCKED : COLOR_RED)
    .setTitle(kind === "VOTE" ? "🟢  LOCKED IN" : "🚫  OUT THIS WEEK")
    .setDescription(params.text.slice(0, 4000))
    .setAuthor({ name: player.displayName.slice(0, 256), ...(params.avatarUrl ? { iconURL: params.avatarUrl } : {}) });
  if (params.avatarUrl) embed.setThumbnail(params.avatarUrl);

  const fields: Array<{ name: string; value: string; inline: boolean }> = [];
  if (kind === "VOTE" && params.slot) {
    fields.push({ name: "Slot", value: `${formatSlotDay(params.slot.scheduledAt, params.timezone)} · ${formatSlotTime(params.slot.scheduledAt, params.timezone)}`, inline: true });
  }
  if (player.role) fields.push({ name: "Role", value: `${ROLE_GLYPH[player.role]} ${player.role.charAt(0)}${player.role.slice(1).toLowerCase()}`, inline: true });
  if (player.preferredAgent) fields.push({ name: "Agent", value: escapeMarkdown(player.preferredAgent), inline: true });
  if (fields.length > 0) embed.addFields(fields);
  return { embeds: [embed.setFooter({ text: `PREMIER · Schedule #${params.pollId}` })] };
}
