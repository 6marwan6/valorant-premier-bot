import { EmbedBuilder } from "discord.js";
import type { MatchRow } from "../../database/schema/matches.js";
import type { AttendanceRow } from "../../database/schema/attendance.js";
import { formatOffsetLabel } from "./reminderScheduling.js";

/** Under 20 minutes out — the last reminder in a typical [180, 60, 15] plan (section 13's own example). Discord's own "danger" red. */
const IMMINENT_MINUTES = 20;
/** Under an hour out, but not imminent — Discord's amber/gold. */
const SOON_MINUTES = 60;

const COLOR_IMMINENT = 0xed4245;
const COLOR_SOON = 0xf5a623;
const COLOR_CALM = 0x5865f2; // Discord blurple — plenty of time left

function colorFor(offsetMinutes: number): number {
  if (offsetMinutes <= IMMINENT_MINUTES) return COLOR_IMMINENT;
  if (offsetMinutes < SOON_MINUTES) return COLOR_SOON;
  return COLOR_CALM;
}

/**
 * The embed for every reminder *after* the first one (which instead posts
 * the full buttoned announcement via buildRosterMessage — see
 * reminderCronJob.ts). This is a short standalone nudge, not a rebuild of
 * the roster message: plan section 16 already establishes the single
 * roster message as the one place attendance state lives; this is a ping
 * pointing back at it, matching plan section 13's framing of reminders as
 * distinct, individually-tracked notifications rather than edits to the
 * announcement.
 *
 * An embed rather than plain text (revised 2026-09-27, "enhance the UI of
 * the reminder messages") for three real capabilities plain content
 * doesn't have, not just decoration: a colored left border that shifts
 * from calm blurple to urgent red as kickoff approaches, giving the
 * reminder a glance-able urgency signal in a busy channel; a visual break
 * from the roster message above it, which stays plain text, so the two
 * don't blur together; and Discord's native `<t:unix:F>`/`<t:unix:R>`
 * timestamp markdown, which every viewer's own client renders in their
 * own timezone and locale, live-updating the relative ("in 47 minutes")
 * part with no further action needed from the bot — a "widget" Discord
 * itself provides, strictly better than a fixed-timezone string only the
 * team's own configured timezone would ever be right for.
 *
 * Phase 10 (plan section 38 "Match Hype"): when `hypeText` is given, the
 * same embed becomes the hype message — a `🔥 15 MINUTES` title (the
 * plan's own example header) and the AI's personality-layer text on top
 * of the deterministic match line. The colored border, the live
 * timestamps and the attendance tallies are unchanged, so the enhanced
 * reminder UI and MATCH_HYPE are one message, not two. Every fact in it
 * (match id, kickoff, tallies) is still built by the app; the model only
 * ever supplies `hypeText`.
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
  hypeText?: string | null,
): { embeds: EmbedBuilder[] } {
  const respondedCount = attendanceRows.length;
  const playingCount = attendanceRows.filter((row) => row.status === "PLAYING").length;
  const unixSeconds = Math.floor(match.scheduledAt.getTime() / 1000);

  const matchLine = `Match #${match.id} — <t:${unixSeconds}:F> (<t:${unixSeconds}:R>)`;
  const hype = hypeText?.trim();

  const embed = new EmbedBuilder()
    .setColor(colorFor(offsetMinutes))
    .setTitle(hype ? `🔥 ${formatOffsetLabel(offsetMinutes).toUpperCase()}` : `⏰ ${formatOffsetLabel(offsetMinutes)} until kickoff`)
    .setDescription(hype ? `${hype}\n\n${matchLine}` : matchLine)
    .addFields(
      { name: "🟢 Confirmed playing", value: String(playingCount), inline: true },
      { name: "📋 Responded", value: String(respondedCount), inline: true },
    )
    .setFooter({ text: "Haven't answered yet? Scroll up and tap a button." });

  return { embeds: [embed] };
}
