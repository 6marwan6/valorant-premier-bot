import type { AttendanceRow } from "../../database/schema/attendance.js";

/**
 * Plan section 3 lists four initial AI modes; Phase 6 (section 59) builds
 * the three that react to an attendance click. MATCH_HYPE is Phase 10,
 * POST_MATCH is later still.
 */
export type AiMode = "CELEBRATE" | "ROAST" | "CONSOLE";

/**
 * Plan sections 18-20: PLAYING -> CELEBRATE, CANNOT_PLAY -> ROAST,
 * WANTS_TO_BUT_CANNOT -> CONSOLE. NO_RESPONSE is never stored as a row
 * (see schema/attendance.ts), so it can never reach this function.
 */
export function modeForStatus(status: AttendanceRow["status"]): AiMode {
  switch (status) {
    case "PLAYING":
      return "CELEBRATE";
    case "CANNOT_PLAY":
      return "ROAST";
    case "WANTS_TO_BUT_CANNOT":
      return "CONSOLE";
  }
}
