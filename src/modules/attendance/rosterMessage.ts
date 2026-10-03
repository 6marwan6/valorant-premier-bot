import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, escapeMarkdown } from "discord.js";
import type { MatchRow } from "../../database/schema/matches.js";
import type { AttendanceRow } from "../../database/schema/attendance.js";
import { formatMatchDateTime } from "../matches/dateTime.js";
import { buildAttendanceCustomId } from "./customId.js";

export interface RosterMessage {
  /** A one-line banner above the card. Doubles as the push-notification text and as the fallback for clients with embeds turned off. */
  content: string;
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
}

/**
 * The subset of a player profile the roster message needs — plan section 16's
 * "No response" section and the real `Confirmed: X/Y` denominator (Phase 5).
 * `role` / `preferredAgent` are optional profile facts (plan section 8) that
 * only decorate the name; a `PlayerRow` satisfies this shape as-is.
 */
export interface RosterPlayer {
  discordUserId: string;
  displayName: string;
  role?: "DUELIST" | "INITIATOR" | "CONTROLLER" | "SENTINEL" | null;
  preferredAgent?: string | null;
}

type Status = AttendanceRow["status"];

// Valorant's own brand red for an open match; green once the whole roster is in; Discord grey when cancelled.
const COLOR_OPEN = 0xff4655;
const COLOR_FULL = 0x3bd671;
const COLOR_CANCELLED = 0x4f545c;

const STATUS_SECTIONS: Array<{ status: Status; heading: string; square: string }> = [
  { status: "PLAYING", heading: "🟢 Playing", square: "🟩" },
  { status: "WANTS_TO_BUT_CANNOT", heading: "🟡 Want to, but can't", square: "🟨" },
  { status: "CANNOT_PLAY", heading: "🔴 Can't play", square: "🟥" },
];
const PENDING_SQUARE = "⬛";
const NO_RESPONSE_HEADING = "⚪ No response";

const ROLE_GLYPH: Record<NonNullable<RosterPlayer["role"]>, string> = {
  DUELIST: "⚔️",
  INITIATOR: "🔎",
  CONTROLLER: "☁️",
  SENTINEL: "🛡️",
};

/** Most squares one bar will draw (a 6–7 player team is far below this); beyond it the bar is skipped and only the count is shown. */
const MAX_BAR_SEGMENTS = 15;
const FIELD_VALUE_LIMIT = 1024;
const FEED_LENGTH = 3;

const FEED_LINE: Record<Status, (name: string) => string> = {
  PLAYING: (name) => `🟢 **${name}** locked in`,
  WANTS_TO_BUT_CANNOT: (name) => `🟡 **${name}** wants to, but can't`,
  CANNOT_PLAY: (name) => `🔴 **${name}** is out`,
};

function unix(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/** One line per person: `⚔️ **Ahmed** · Jett`. Names are markdown-escaped. */
function describePerson(displayName: string, profile: RosterPlayer | undefined): string {
  const glyph = profile?.role ? `${ROLE_GLYPH[profile.role]} ` : "";
  const agent = profile?.preferredAgent ? ` · ${escapeMarkdown(profile.preferredAgent)}` : "";
  return `${glyph}**${escapeMarkdown(displayName)}**${agent}`;
}

/** Keeps a field under Discord's 1024-character limit. */
function fieldValue(lines: string[]): string {
  const joined = lines.join("\n");
  return joined.length <= FIELD_VALUE_LIMIT ? joined : `${joined.slice(0, FIELD_VALUE_LIMIT - 1)}…`;
}

/** `🟩🟩🟨🟥⬛⬛` — one square per roster player, greens first, undecided players last. */
function buildSquadBar(counts: Map<Status, number>, rosterSize: number): string | null {
  if (rosterSize === 0 || rosterSize > MAX_BAR_SEGMENTS) return null;
  const squares: string[] = [];
  for (const section of STATUS_SECTIONS) {
    for (let i = 0; i < (counts.get(section.status) ?? 0); i++) squares.push(section.square);
  }
  // A responder who isn't on the active roster must not push the bar past its width.
  const bar = squares.slice(0, rosterSize);
  while (bar.length < rosterSize) bar.push(PENDING_SQUARE);
  return bar.join("");
}

/**
 * Builds the public match announcement (plan section 14) and, once
 * responses start coming in, the roster (plan section 16), as a single
 * message that gets edited in place — "The bot should maintain a single
 * match message where possible."
 *
 * Revised 2026-10-02 ("make the match message more visually impressive"):
 * the card is now an embed instead of plain text. What it adds over the
 * old text layout, none of which involves the LLM (plan section 14: every
 * fact on this message is built by the app):
 *
 *  - a colored border: Valorant red while open, green once every active
 *    player has confirmed, grey when cancelled;
 *  - the kickoff in the team's timezone (the plan's own "Today at 7:00 PM"
 *    style) plus Discord's native `<t:unix:R>` countdown and `<t:unix:t>`
 *    local time, which every viewer's client renders in their own timezone
 *    and keeps ticking with no further edits from the bot;
 *  - a squad bar with one square per roster player (🟩 playing, 🟨 wants
 *    to but can't, 🟥 can't, ⬛ no response yet) next to `Confirmed: X/Y`;
 *  - the plan-section-16 groups as embed columns, each with a count, and
 *    each person tagged with their role glyph and preferred agent from the
 *    player profile (plan section 8 — deterministic data);
 *  - a short "latest activity" feed of the last few responses, with
 *    relative timestamps.
 *
 * `roster` is every currently-active player (PlayerRepository.
 * listActivePlayersByGuild) — optional and defaulting to `[]`: a guild that hasn't
 * run /add-player yet has no roster to be honest about. In that case this
 * falls back to the earlier behavior: no "No response" section, no
 * fabricated denominator and no squad bar, just "Responded: N". With a
 * roster it renders plan section 16's example: a real "⚪ No response"
 * section and `Confirmed: <PLAYING count>/<roster size>`.
 */
export function buildRosterMessage(
  match: MatchRow,
  attendanceRows: AttendanceRow[],
  roster: RosterPlayer[] = [],
): RosterMessage {
  const cancelled = match.status === "CANCELLED";
  const profileById = new Map(roster.map((p) => [p.discordUserId, p]));

  const byStatus = new Map<Status, AttendanceRow[]>();
  const respondedUserIds = new Set<string>();
  for (const row of attendanceRows) {
    const list = byStatus.get(row.status) ?? [];
    list.push(row);
    byStatus.set(row.status, list);
    respondedUserIds.add(row.discordUserId);
  }
  const counts = new Map<Status, number>(STATUS_SECTIONS.map((s) => [s.status, byStatus.get(s.status)?.length ?? 0]));
  const playingCount = counts.get("PLAYING") ?? 0;
  const noResponsePlayers = roster.filter((p) => !respondedUserIds.has(p.discordUserId));
  const fullSquad = !cancelled && roster.length > 0 && noResponsePlayers.length === 0 && playingCount === roster.length;

  const kickoff = formatMatchDateTime(match.scheduledAt, match.timezone);
  const at = unix(match.scheduledAt);

  const content = cancelled ? "# 🚫 PREMIER MATCH — CANCELLED" : fullSquad ? "# 🔥 PREMIER MATCH" : "# 🔴 PREMIER MATCH";

  const description: string[] = [];
  if (cancelled) {
    description.push("🚫 **This match was cancelled.**");
  } else {
    description.push(`⏳ Kickoff <t:${at}:R>  ·  🌍 <t:${at}:t> your time`);
    description.push("");
    if (roster.length > 0) {
      const bar = buildSquadBar(counts, roster.length);
      description.push(bar ? `${bar}  **Confirmed: ${playingCount}/${roster.length}**` : `**Confirmed: ${playingCount}/${roster.length}**`);
      if (fullSquad) description.push("🔥 **FULL SQUAD LOCKED IN**");
    } else {
      description.push(`**Responded: ${attendanceRows.length}**`);
    }
  }

  const embed = new EmbedBuilder()
    .setColor(cancelled ? COLOR_CANCELLED : fullSquad ? COLOR_FULL : COLOR_OPEN)
    .setTitle(cancelled ? `~~${kickoff}~~` : `📅 ${kickoff}`)
    .setDescription(description.join("\n"));

  if (attendanceRows.length === 0 && roster.length === 0 && !cancelled) {
    embed.addFields({ name: "📋 Roster", value: "_No one has responded yet._" });
  } else {
    for (const section of STATUS_SECTIONS) {
      const rows = byStatus.get(section.status);
      if (!rows || rows.length === 0) continue;
      embed.addFields({
        name: `${section.heading} · ${rows.length}`,
        value: fieldValue(rows.map((row) => describePerson(row.discordDisplayName, profileById.get(row.discordUserId)))),
        inline: true,
      });
    }
    if (!cancelled && roster.length > 0 && noResponsePlayers.length > 0) {
      embed.addFields({
        name: `${NO_RESPONSE_HEADING} · ${noResponsePlayers.length}`,
        value: fieldValue(noResponsePlayers.map((p) => describePerson(p.displayName, p))),
        inline: true,
      });
    }
  }

  if (attendanceRows.length > 0) {
    const latest = [...attendanceRows].sort((a, b) => b.respondedAt.getTime() - a.respondedAt.getTime()).slice(0, FEED_LENGTH);
    embed.addFields({
      name: "⚡ Latest activity",
      value: fieldValue(latest.map((row) => `${FEED_LINE[row.status](escapeMarkdown(row.discordDisplayName))} · <t:${unix(row.respondedAt)}:R>`)),
    });
  }

  embed.setFooter({ text: cancelled ? `Match #${match.id} · cancelled` : `Match #${match.id} · tap a button below to respond` });

  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  // Buttons only make sense while the match is actually accepting
  // responses (plan section 15 step 3: "Verify that the match is
  // accepting responses"). A cancelled match's message keeps its history
  // visible but loses its buttons entirely, rather than leaving live
  // buttons that would just be rejected on click.
  if (match.status === "CONFIRMATION_OPEN") {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(buildAttendanceCustomId(match.id, "PLAYING"))
        .setLabel("I'M PLAYING")
        .setEmoji("🟢")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(buildAttendanceCustomId(match.id, "CANNOT_PLAY"))
        .setLabel("CAN'T PLAY")
        .setEmoji("🔴")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(buildAttendanceCustomId(match.id, "WANTS_TO_BUT_CANNOT"))
        .setLabel("WANT TO, BUT CAN'T")
        .setEmoji("🟡")
        .setStyle(ButtonStyle.Secondary),
    );
    components.push(row);
  }

  return { content, embeds: [embed], components };
}
