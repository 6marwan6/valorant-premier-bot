import type { AttendanceRow } from "../../database/schema/attendance.js";

/**
 * Plan section 3 lists four initial AI modes; Phase 6 (section 59) builds
 * the three that react to an attendance click. MATCH_HYPE and POST_MATCH
 * (Phase 10, plan sections 38/39) are deliberately NOT added to this type:
 * both address the whole roster, not one player reacting to one attendance
 * status, so they have no `modeForStatus` case and no ai_conversations row
 * (that table is player+match scoped — see schema/aiConversations.ts).
 * They're built and validated as their own thing in
 * teamAiContextBuilder.ts/aiOutput.ts and triggered directly by
 * reminderCronJob.ts and postMatchService.ts rather than through this
 * file.
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
