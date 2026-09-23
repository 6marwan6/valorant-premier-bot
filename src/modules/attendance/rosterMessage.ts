import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import type { MatchRow } from "../../database/schema/matches.js";
import type { AttendanceRow } from "../../database/schema/attendance.js";
import { formatMatchDateTime } from "../matches/dateTime.js";
import { buildAttendanceCustomId } from "./customId.js";

export interface RosterMessage {
  content: string;
  components: ActionRowBuilder<ButtonBuilder>[];
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
 * Deliberately does NOT include a "No response" section or a fixed
 * "Confirmed: X/6" denominator the way section 16's example does: without
 * a team roster (Player Profiles, Phase 5) there's no way to know who's
 * *expected* to respond, only who has. Showing "Responded: N" is the
 * honest subset of that example derivable from data that actually exists
 * right now. See README's Phase 3 section for the plan citation on this.
 */
export function buildRosterMessage(match: MatchRow, attendanceRows: AttendanceRow[]): RosterMessage {
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
  for (const row of attendanceRows) {
    const list = byStatus.get(row.status) ?? [];
    list.push(row);
    byStatus.set(row.status, list);
  }

  if (attendanceRows.length === 0 && match.status !== "CANCELLED") {
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
  }

  if (match.status !== "CANCELLED") {
    lines.push(`Responded: ${attendanceRows.length}`);
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
