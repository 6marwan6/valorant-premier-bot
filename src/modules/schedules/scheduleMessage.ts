import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, escapeMarkdown } from "discord.js";
import { DateTime } from "luxon";
import type { ScheduleView } from "../../database/repositories/scheduleRepository.js";
import type { ScheduleSlotRow, ScheduleVoteRow } from "../../database/schema/schedules.js";
import { buildDeclineCustomId, buildVoteCustomId } from "./scheduleCustomId.js";
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

const NUMBER_EMOJI = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
const ROLE_GLYPH = { DUELIST: "⚔️", INITIATOR: "🔎", CONTROLLER: "☁️", SENTINEL: "🛡️" } as const;
const FIELD_LIMIT = 1024;

function unix(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

function cap(text: string): string {
  return text.length <= FIELD_LIMIT ? text : `${text.slice(0, FIELD_LIMIT - 1)}…`;
}

/** `⚔️ **Ahmed**` (role glyph from the profile when the voter is on the roster). */
function nameOf(userId: string, displayName: string, profiles: Map<string, SchedulePlayer>): string {
  const p = profiles.get(userId);
  const glyph = p?.role ? `${ROLE_GLYPH[p.role]} ` : "";
  return `${glyph}**${escapeMarkdown(p?.displayName ?? displayName)}**`;
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
  const lines = [` #  ${"DAY".padEnd(9)}  ${"TIME".padEnd(timeWidth)}  SQUAD`];
  for (const s of view.slots) {
    const n = counts.get(s.id) ?? 0;
    const past = effectiveAt(s).getTime() <= now.getTime();
    const marker = past ? "  · done" : s.id === leaderId ? "  ★ ON" : n >= MIN_PLAYERS_TO_QUEUE ? "  ✔" : "";
    lines.push(`${String(s.position).padStart(2)}  ${formatSlotDay(s.scheduledAt, tz)}  ${timeCell(s).padEnd(timeWidth)}  ${voteBar(n)} ${n}/${MIN_PLAYERS_TO_QUEUE}${marker}`);
  }
  return "```\n" + lines.join("\n") + "\n```";
}

/**
 * The weekly schedule card. `roster` (active players) is optional: with it
 * the card also lists who hasn't voted yet; without it (a guild that hasn't
 * run /add-player) that section is simply omitted rather than invented.
 */
export function buildScheduleMessage(view: ScheduleView, roster: SchedulePlayer[] = [], now: Date = new Date()): ScheduleMessage {
  const { poll, slots } = view;
  const tz = poll.timezone;
  const cancelled = poll.status === "CANCELLED";
  const profiles = new Map(roster.map((p) => [p.discordUserId, p]));
  const bySlot = votesBySlot(view.votes);
  const counts = new Map(slots.map((s) => [s.id, bySlot.get(s.id)?.length ?? 0]));
  const leader = cancelled ? null : pickLeadingSlot(slots, counts, now);

  const content = `# ◢◤ VALORANT PREMIER ◥◣\n-# WEEKLY SCHEDULE · ${cancelled ? "CANCELLED" : "VOTE YOUR AVAILABILITY"}`;

  const embed = new EmbedBuilder()
    .setColor(cancelled ? COLOR_CANCELLED : leader ? COLOR_LOCKED : COLOR_RED)
    .setTitle(cancelled ? `~~PREMIER WEEK · ${dateRange(slots, tz)}~~` : `◢ PREMIER WEEK · ${dateRange(slots, tz)} ◣`);

  const description: string[] = [];
  if (cancelled) {
    description.push("🚫 **This schedule was cancelled.**");
  } else {
    description.push(`**Need ${MIN_PLAYERS_TO_QUEUE} to queue.** Tap every slot you can play — tap again to take it back.`);
    description.push(buildBoard(view, counts, leader?.id ?? null, now));
    if (leader) {
      const at = unix(effectiveAt(leader));
      const queue = leader.queueAt ? ` · **queue ${formatSlotTime(leader.queueAt, tz)}**` : "";
      description.push(`🔥 **MATCH ON → ${formatSlotDay(leader.scheduledAt, tz)} · ${formatSlotTime(leader.scheduledAt, tz)}**${queue} · <t:${at}:R>`);
    } else {
      const open = slots.filter((s) => effectiveAt(s).getTime() > now.getTime() && s.remindMode !== "NEVER");
      const best = open.reduce<ScheduleSlotRow | null>((b, s) => (b === null || (counts.get(s.id) ?? 0) > (counts.get(b.id) ?? 0) ? s : b), null);
      if (best) {
        const missing = MIN_PLAYERS_TO_QUEUE - (counts.get(best.id) ?? 0);
        description.push(`⏳ No squad yet — **${formatSlotDay(best.scheduledAt, tz)} ${formatSlotTime(best.scheduledAt, tz)}** needs **${missing}** more.`);
      } else {
        description.push("⏳ Every slot has passed.");
      }
    }
  }
  embed.setDescription(description.join("\n"));

  // Who voted for what, slot by slot.
  for (const s of slots) {
    const voters = bySlot.get(s.id) ?? [];
    const label = `${NUMBER_EMOJI[s.position - 1] ?? s.position}  ${formatSlotDay(s.scheduledAt, tz)} · ${formatSlotTime(s.scheduledAt, tz)}`;
    embed.addFields({
      name: `${label}  —  ${voters.length}/${MIN_PLAYERS_TO_QUEUE}`,
      value: voters.length ? cap(voters.map((v) => nameOf(v.discordUserId, v.discordDisplayName, profiles)).join("  ·  ")) : "_no votes yet_",
    });
  }
  if (view.declines.length > 0) {
    embed.addFields({
      name: `🚫 Can't play any day · ${view.declines.length}`,
      value: cap(view.declines.map((d) => nameOf(d.discordUserId, d.discordDisplayName, profiles)).join("  ·  ")),
    });
  }
  if (roster.length > 0 && !cancelled) {
    const answered = new Set([...view.votes.map((v) => v.discordUserId), ...view.declines.map((d) => d.discordUserId)]);
    const waiting = roster.filter((p) => !answered.has(p.discordUserId));
    if (waiting.length > 0) {
      embed.addFields({ name: `⚪ No vote yet · ${waiting.length}`, value: cap(waiting.map((p) => nameOf(p.discordUserId, p.displayName, profiles)).join("  ·  ")) });
    }
  }
  embed.setFooter({ text: cancelled ? `Schedule #${poll.id} · cancelled` : `PREMIER · Schedule #${poll.id} · reminders 5h and 15min before queue` });

  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  if (!cancelled) {
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
      ),
    );
  }
  return { content, embeds: [embed], components };
}

/** One line per person for lineups: `⚔️ **Ahmed** · Jett`. */
function lineupLine(userId: string, displayName: string, profiles: Map<string, SchedulePlayer>): string {
  const p = profiles.get(userId);
  const agent = p?.preferredAgent ? ` · ${escapeMarkdown(p.preferredAgent)}` : "";
  return `${nameOf(userId, displayName, profiles)}${agent}`;
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
): { content: string; embeds: EmbedBuilder[]; mentionUserIds: string[] } {
  const profiles = new Map(roster.map((p) => [p.discordUserId, p]));
  const ids = voters.map((v) => v.discordUserId);
  const at = unix(effectiveAt(slot));
  const lines = [
    `${"🟩".repeat(Math.min(voters.length, 10))}  **${voters.length}/${MIN_PLAYERS_TO_QUEUE}**`,
    "",
    ...voters.map((v) => lineupLine(v.discordUserId, v.discordDisplayName, profiles)),
    "",
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
): { content: string; embeds: EmbedBuilder[]; mentionUserIds: string[] } {
  const profiles = new Map(roster.map((p) => [p.discordUserId, p]));
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
  description.push("", ...voters.map((v) => lineupLine(v.discordUserId, v.discordDisplayName, profiles)));

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
