import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import type { MatchRow } from "../../database/schema/matches.js";
import type { AttendanceRow } from "../../database/schema/attendance.js";
import { formatMatchDateTime } from "../matches/dateTime.js";
import { buildAttendanceCustomId } from "./customId.js";

export interface RosterMessage {
  content: string;
  components: ActionRowBuilder<ButtonBuilder>[];
}

/** The subset of a player profile the roster message needs — plan section 16's "No response" section and the real `Confirmed: X/Y` denominator (Phase 5). */
export interface RosterPlayer {
  discordUserId: string;
  displayName: string;
}

const STATUS_SECTIONS: Array<{ status: AttendanceRow["status"]; heading: string }> = [
  { status: "PLAYING", heading: "🟢 Playing" },
  { status: "WANTS_TO_BUT_CANNOT", heading: "🟡 Want to, but can't" },
  { status: "CANNOT_PLAY", heading: "🔴 Can't play" },
];

/**
 * Builds the public match announcement (plan section 14) and, once
 * responses start coming in, the roster (plan section 16), as a single
 * message that gets edited in place — "The bot should maintain a single
 * match message where possible."
 *
 * `roster` is every currently-active player (PlayerRepository.
 * listActiveByGuild) — optional and defaulting to `[]` for two reasons:
 * callers from before Phase 5 existed shouldn't have to change, and a
 * guild that hasn't run /add-player yet (or one still on Phase 1-4 code)
 * has no roster to be honest about. In that empty-roster case this falls
 * back to exactly the previous behavior: no "No response" section, no
 * fabricated denominator, just "Responded: N" — the same reasoning this
 * file's previous version documented (see README's Phase 3 section for
 * the original citation). Once a roster is passed, this renders plan
 * section 16's example faithfully: a real "⚪ No response" section
 * listing every active player who hasn't answered, and
 * `Confirmed: <PLAYING count>/<roster size>` in place of "Responded: N".
 */
export function buildRosterMessage(
  match: MatchRow,
  attendanceRows: AttendanceRow[],
  roster: RosterPlayer[] = [],
): RosterMessage {
  const lines: string[] = [];

  if (match.status === "CANCELLED") {
    lines.push("🚫 **PREMIER MATCH — CANCELLED**");
  } else {
    lines.push("🔴 **PREMIER MATCH**");
  }
  lines.push("");
  lines.push(`**${match.opponent}**`);
  lines.push(formatMatchDateTime(match.scheduledAt, match.timezone));
  lines.push("");

  const byStatus = new Map<AttendanceRow["status"], AttendanceRow[]>();
  const respondedUserIds = new Set<string>();
  for (const row of attendanceRows) {
    const list = byStatus.get(row.status) ?? [];
    list.push(row);
    byStatus.set(row.status, list);
    respondedUserIds.add(row.discordUserId);
  }

  const noResponsePlayers = roster.filter((p) => !respondedUserIds.has(p.discordUserId));

  if (attendanceRows.length === 0 && roster.length === 0 && match.status !== "CANCELLED") {
    lines.push("_No one has responded yet._");
  } else {
    for (const section of STATUS_SECTIONS) {
      const rows = byStatus.get(section.status);
      if (!rows || rows.length === 0) continue;
      lines.push(section.heading);
      for (const row of rows) {
        lines.push(row.discordDisplayName);
      }
      lines.push("");
    }
    if (roster.length > 0 && noResponsePlayers.length > 0) {
      lines.push("⚪ No response");
      for (const player of noResponsePlayers) {
        lines.push(player.displayName);
      }
      lines.push("");
    }
  }

  if (match.status !== "CANCELLED") {
    if (roster.length > 0) {
      const playingCount = byStatus.get("PLAYING")?.length ?? 0;
      lines.push(`Confirmed: ${playingCount}/${roster.length}`);
    } else {
      lines.push(`Responded: ${attendanceRows.length}`);
    }
  }

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

  return { content: lines.join("\n").trimEnd(), components };
}
