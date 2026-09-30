import type { AttendanceRow } from "../../database/schema/attendance.js";

/**
 * Plan section 3 lists four initial AI modes; Phase 6 (section 59) builds
 * the three that react to an attendance click. MATCH_HYPE is Phase 10,
 * POST_MATCH is later still.
 */
export type AiMode = "CELEBRATE" | "ROAST" | "CONSOLE";

/**
 * `AiMode` plus DIRECT_CHAT (plan section 63's `/ai`, pulled forward —
 * 2026-09-28): the wider set retrieval and multi-turn conversation code
 * (memoryRetrieval.ts, conversationContextBuilder.ts, aiService.ts's
 * `respondInConversation`) needs to reason about. `aiContextBuilder.ts`'s
 * single-shot builder deliberately keeps the narrower `AiMode` — it
 * requires a `match: MatchRow`, which DIRECT_CHAT never has, so it was
 * never going to be called with this mode anyway; widening its type too
 * would just force dead Record entries into it.
 */
export type ConversationMode = AiMode | "DIRECT_CHAT" | "SERVER_CHAT";

/**
 * The two free-form chats with Mari (plan section 63, revised 2026-09-29):
 * DIRECT_CHAT in a DM (private) and SERVER_CHAT in the server (public).
 * They share one lifecycle — no match, closed by idleness or a length cap
 * rather than by the model deciding it is "done", memories saved silently
 * on any turn, "forget" by asking — so code that cares about that
 * lifecycle asks this instead of comparing against both names.
 */
export type ChatMode = "DIRECT_CHAT" | "SERVER_CHAT";

export function isChatMode(mode: string): mode is ChatMode {
  return mode === "DIRECT_CHAT" || mode === "SERVER_CHAT";
}

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
