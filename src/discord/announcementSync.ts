import type { AppContext } from "../appContext.js";
import type { MatchWithAttendance } from "../modules/attendance/attendanceService.js";
import { buildRosterMessage } from "../modules/attendance/rosterMessage.js";

/**
 * Pushes a fresh roster message to an already-posted match announcement —
 * used by /edit-match and /cancel-match, which change match state outside
 * of a button click and so have no interaction to piggyback update() on
 * (unlike dispatchButton.ts, which edits its own message directly).
 *
 * Best-effort by design: the database update these commands make is
 * already the source of truth (plan design principle #2) by the time this
 * runs, so a Discord-side failure here (message deleted, bot lost channel
 * access, etc.) is logged and swallowed rather than failing the whole
 * command — the admin's edit/cancel still succeeded where it matters.
 * Silently doing nothing when there's no announcement yet (a SCHEDULED
 * match that was never posted) is the normal, expected case, not an
 * error.
 */
export async function syncAnnouncementIfPosted(
  ctx: AppContext,
  { match, attendanceRows }: MatchWithAttendance,
): Promise<void> {
  if (!match.announcementChannelId || !match.announcementMessageId) return;

  try {
    const { content, components } = buildRosterMessage(match, attendanceRows);
    await ctx.discord.editChannelMessage(match.announcementChannelId, match.announcementMessageId, {
      content,
      components,
    });
  } catch (err) {
    ctx.logger.warn(
      {
        event: "announcement.syncFailed",
        matchId: match.id,
        guildId: match.guildId,
        err: err instanceof Error ? err.message : String(err),
      },
      "Failed to refresh the posted match announcement (database is still correct)",
    );
  }
}
