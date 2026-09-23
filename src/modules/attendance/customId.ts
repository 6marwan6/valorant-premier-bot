import type { AttendanceRow } from "../../database/schema/attendance.js";

export type AttendanceButtonStatus = AttendanceRow["status"];

const PREFIX = "attendance";

/**
 * Encodes which match + which response a button represents into Discord's
 * component `custom_id` (max 100 chars — this format is nowhere close).
 * Discord round-trips whatever we set here back to us verbatim on click,
 * so this is the only state a button click handler has to work with
 * besides the clicking user's own identity.
 */
export function buildAttendanceCustomId(matchId: number, status: AttendanceButtonStatus): string {
  return `${PREFIX}:${matchId}:${status}`;
}

const VALID_STATUSES: readonly AttendanceButtonStatus[] = [
  "PLAYING",
  "CANNOT_PLAY",
  "WANTS_TO_BUT_CANNOT",
];

export interface ParsedAttendanceCustomId {
  matchId: number;
  status: AttendanceButtonStatus;
}

/**
 * Decodes a custom_id back into (matchId, status), or returns null for
 * anything malformed. Returning null rather than throwing lets the button
 * dispatcher treat "not one of ours" / "corrupted" the same safe way as
 * "unknown command" in dispatchCommand.ts, rather than crashing on a
 * button click from a future feature or a manually-crafted bad id.
 */
export function parseAttendanceCustomId(customId: string): ParsedAttendanceCustomId | null {
  const parts = customId.split(":");
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;

  const matchId = Number(parts[1]);
  if (!Number.isInteger(matchId) || matchId <= 0) return null;

  const status = parts[2] as AttendanceButtonStatus;
  if (!VALID_STATUSES.includes(status)) return null;

  return { matchId, status };
}
