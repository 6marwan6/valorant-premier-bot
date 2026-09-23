import type { MatchRow } from "../../database/schema/matches.js";
import type { AttendanceRow } from "../../database/schema/attendance.js";
import { formatOffsetLabel } from "./reminderScheduling.js";

/**
 * The text for every reminder *after* the first one (which instead posts
 * the full buttoned announcement via buildRosterMessage — see
 * reminderCronJob.ts). This is a short standalone nudge, not a rebuild of
 * the roster message: plan section 16 already establishes the single
 * roster message as the one place attendance state lives; this is a ping
 * pointing back at it, matching plan section 13's framing of reminders as
 * distinct, individually-tracked notifications rather than edits to the
 * announcement.
 *
 * No buttons on this message on purpose — the roster message above still
 * has the live ones (plan section 16: "single match message where
 * possible" for the interactive part); a second set of buttons on a
 * second message would just be a second, easy-to-miss place to click.
 */
export function buildReminderNudgeMessage(
  match: MatchRow,
  attendanceRows: AttendanceRow[],
  offsetMinutes: number,
): string {
  const respondedCount = attendanceRows.length;
  const playingCount = attendanceRows.filter((row) => row.status === "PLAYING").length;

  return [
    `⏰ **${formatOffsetLabel(offsetMinutes)} until kickoff** — Match #${match.id} vs **${match.opponent}**`,
    `🟢 ${playingCount} confirmed playing · ${respondedCount} responded total`,
    "Haven't answered yet? Scroll up to the match announcement and tap a button.",
  ].join("\n");
}
