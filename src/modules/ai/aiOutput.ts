import { z } from "zod";

/**
 * Plan section 36 (structured AI output) and section 55 ("AI output
 * validation"): the backend never trusts raw model text.
 *
 * `memory_candidate` (Phase 8, plan section 21/36): the exact nine
 * categories from plan section 22 — kept as a literal tuple here (rather
 * than importing schema/memories.ts's `memoryTypeEnum`) so this module
 * stays dependency-free and DB-agnostic, exactly as it was in Phase 6/7;
 * `memoryTypeSchema`'s test file pins the two lists together so they can't
 * silently drift.
 */
const MAX_RESPONSE_LENGTH = 1000; // section 35: concise; also far below Discord's 2000-char limit
// Shown back to the player verbatim in /memories (section 43). Exported so
// the /add-memory admin command (2026-09-28) enforces the exact same bound
// on a manually-entered memory as every AI-proposed one goes through here.
export const MAX_MEMORY_CONTENT_LENGTH = 300;

export const MEMORY_TYPES = [
  "PLAYER_PREFERENCE",
  "PERSONALITY_TRAIT",
  "RUNNING_JOKE",
  "VALORANT_PREFERENCE",
  "TEAM_JOKE",
  "MATCH_EVENT",
  "ACHIEVEMENT",
  "HABIT",
  "TEAM_HISTORY",
] as const;

const memoryCandidateSchema = z
  .object({
    type: z.enum(MEMORY_TYPES),
    content: z.string().trim().min(1).max(MAX_MEMORY_CONTENT_LENGTH),
    // Optional at the schema level (a model that forgets the field
    // shouldn't blow up shape validation) — the actual gate is the runtime
    // `=== true` check below, which treats "missing" exactly like "false".
    requires_confirmation: z.boolean().optional(),
  })
  .nullable()
  .optional();

const aiOutputSchema = z.object({
  response: z.string().trim().min(1).max(MAX_RESPONSE_LENGTH),
  should_follow_up: z.boolean().optional(),
  memory_candidate: memoryCandidateSchema,
});

export interface MemoryCandidate {
  type: (typeof MEMORY_TYPES)[number];
  content: string;
}

export interface ParsedAiOutput {
  response: string;
  shouldFollowUp: boolean;
  /** Non-null only when the model proposed one AND it survived validation (shape, confirmation flag, forbidden-topic check). */
  memoryCandidate: MemoryCandidate | null;
}

export type ParseAiOutputResult =
  | { ok: true; value: ParsedAiOutput }
  | { ok: false; reason: "invalid_json" | "invalid_shape" | "protected_topic" };

/** Reasoning models sometimes leak <think> blocks or wrap JSON in ``` fences; tolerate both. */
function extractJsonObject(raw: string): string | null {
  const withoutThinking = raw.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const start = withoutThinking.indexOf("{");
  const end = withoutThinking.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  return withoutThinking.slice(start, end + 1);
}

/**
 * Model output is untrusted text going into a Discord message: defuse
 * mass-mentions and user/role mention syntax so a hostile display name or
 * hallucination can never ping anyone.
 */
export function neutralizeMentions(text: string): string {
  return text
    .replace(/@(everyone|here)/gi, "@\u200b$1")
    .replace(/<(@[!&]?|#)/g, "<\u200b$1");
}

// Implementation lives in topicMatch.ts so it can normalize Arabic and map English/Arabic words for the same topic.
import { mentionsForbiddenTopic } from "./topicMatch.js";
export { mentionsForbiddenTopic };

// --- Phase 10: team-wide broadcasts (MATCH_HYPE / POST_MATCH) ---------------
//
// These are a separate, simpler output contract from aiOutputSchema above:
// a one-shot message with no follow-up/memory-candidate concept, since
// nothing about a team-wide broadcast is a private, ongoing conversation
// (see aiService.ts's TeamAiOutcome). Kept in this same file rather than a
// new one so every "trust nothing the model says until it's validated"
// check (section 55) lives in one place.

const MAX_TEAM_RESPONSE_LENGTH = 700; // section 35: concise; well under Discord's 2000-char limit even with the deterministic header prepended

const teamMessageSchema = z.object({
  response: z.string().trim().min(1).max(MAX_TEAM_RESPONSE_LENGTH),
});

export interface ParsedTeamMessage {
  response: string;
}

export type ParseTeamMessageResult =
  | { ok: true; value: ParsedTeamMessage }
  | { ok: false; reason: "invalid_json" | "invalid_shape" | "protected_topic" };

/** Validates a MATCH_HYPE/POST_MATCH broadcast the same way parseAiOutput validates a per-player response. */
export function parseTeamMessage(raw: string, forbiddenTopics: string[]): ParseTeamMessageResult {
  const json = extractJsonObject(raw);
  if (!json) return { ok: false, reason: "invalid_json" };

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(json);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }

  const result = teamMessageSchema.safeParse(parsedJson);
  if (!result.success) return { ok: false, reason: "invalid_shape" };

  if (mentionsForbiddenTopic(result.data.response, forbiddenTopics)) {
    return { ok: false, reason: "protected_topic" };
  }

  return { ok: true, value: { response: neutralizeMentions(result.data.response) } };
}

// --- 2026-09-30: /mari-say ai_voice (admin draft rewritten in Mari's voice) ---
//
// Same {"response": "..."} contract and the same checks as a team broadcast,
// but with a longer cap: an admin's announcement/intro can legitimately run
// past a hype line. Kept under 1500 so the ephemeral preview (the text in a
// code block, plus a short header) still fits in one Discord message.

export const MAX_ADMIN_REWRITE_LENGTH = 1500;

const adminRewriteSchema = z.object({
  response: z.string().trim().min(1).max(MAX_ADMIN_REWRITE_LENGTH),
});

export function parseAdminRewrite(raw: string, forbiddenTopics: string[]): ParseTeamMessageResult {
  const json = extractJsonObject(raw);
  if (!json) return { ok: false, reason: "invalid_json" };

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(json);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }

  const result = adminRewriteSchema.safeParse(parsedJson);
  if (!result.success) return { ok: false, reason: "invalid_shape" };

  if (mentionsForbiddenTopic(result.data.response, forbiddenTopics)) {
    return { ok: false, reason: "protected_topic" };
  }

  return { ok: true, value: { response: neutralizeMentions(result.data.response) } };
}

// --- Phase 10: match-event extraction (plan section 40) --------------------
//
// Turns /complete-match's freeform admin `notes` into structured,
// evidence-linkable events. Same tuple-not-import pattern as MEMORY_TYPES
// above (see schema/matchEvents.ts's matchEventTypeEnum, which
// tests/unit/matchEvents.test.ts pins this list against).

export const MATCH_EVENT_TYPES = ["CLUTCH", "MVP", "TOP_FRAG", "FUNNY_MOMENT", "ACHIEVEMENT", "TEAM_EVENT"] as const;

const MAX_MATCH_EVENT_DESCRIPTION_LENGTH = 200;
const MAX_EXTRACTED_EVENTS = 10; // a single match's notes for a 6-7 person team; bounds one bad extraction from flooding match_events

const matchEventExtractionItemSchema = z.object({
  type: z.enum(MATCH_EVENT_TYPES),
  description: z.string().trim().min(1).max(MAX_MATCH_EVENT_DESCRIPTION_LENGTH),
  // Copied verbatim from the roster list the prompt was given, or null —
  // see modules/matches/matchEvents.ts's matchPlayerByName for how this
  // gets resolved back to a real player id (never trusted as one here).
  player_name: z.string().trim().min(1).max(60).nullable().optional(),
});

const matchEventExtractionSchema = z.object({
  events: z.array(matchEventExtractionItemSchema).max(MAX_EXTRACTED_EVENTS),
});

export interface ExtractedMatchEvent {
  type: (typeof MATCH_EVENT_TYPES)[number];
  description: string;
  playerName: string | null;
}

export type ParseMatchEventExtractionResult =
  | { ok: true; value: ExtractedMatchEvent[] }
  | { ok: false; reason: "invalid_json" | "invalid_shape" };

/**
 * Unlike parseAiOutput/parseTeamMessage, a forbidden-topic hit here drops
 * just that one event rather than failing the whole extraction — plan
 * section 37's "the model only ever suggests" applies per-item, the same
 * way a bad memory_candidate doesn't sink an otherwise-good response.
 */
export function parseMatchEventExtraction(raw: string, forbiddenTopics: string[]): ParseMatchEventExtractionResult {
  const json = extractJsonObject(raw);
  if (!json) return { ok: false, reason: "invalid_json" };

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(json);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }

  const result = matchEventExtractionSchema.safeParse(parsedJson);
  if (!result.success) return { ok: false, reason: "invalid_shape" };

  const events: ExtractedMatchEvent[] = [];
  for (const item of result.data.events) {
    if (mentionsForbiddenTopic(item.description, forbiddenTopics)) continue;
    events.push({
      type: item.type,
      description: neutralizeMentions(item.description),
      playerName: item.player_name ?? null,
    });
  }

  return { ok: true, value: events };
}

export function parseAiOutput(raw: string, forbiddenTopics: string[]): ParseAiOutputResult {
  const json = extractJsonObject(raw);
  if (!json) return { ok: false, reason: "invalid_json" };

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(json);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }

  const result = aiOutputSchema.safeParse(parsedJson);
  if (!result.success) return { ok: false, reason: "invalid_shape" };

  if (mentionsForbiddenTopic(result.data.response, forbiddenTopics)) {
    return { ok: false, reason: "protected_topic" };
  }

  // A candidate never fails the whole turn — the response text has already
  // cleared its own forbidden-topic check above and stands on its own.
  // `requires_confirmation !== true` and a forbidden-topic hit in the
  // candidate's *content* both just drop the candidate silently: plan
  // section 37, the model only ever suggests, so a bad suggestion is
  // discarded, not treated as a reason to throw away a good response.
  const candidate = result.data.memory_candidate;
  const memoryCandidate: MemoryCandidate | null =
    candidate && candidate.requires_confirmation === true && !mentionsForbiddenTopic(candidate.content, forbiddenTopics)
      ? { type: candidate.type, content: neutralizeMentions(candidate.content) }
      : null;

  return {
    ok: true,
    value: {
      response: neutralizeMentions(result.data.response),
      shouldFollowUp: result.data.should_follow_up ?? false,
      memoryCandidate,
    },
  };
}

// --- 2026-09-29: free-form chat output (DIRECT_CHAT / SERVER_CHAT) ----------
//
// A real chat isn't one reply plus one optional wrap-up memory, so it has
// its own contract next to parseAiOutput's (which CONSOLE and the
// single-shot modes keep using unchanged):
//
//   { "response": "...",
//     "memory_candidates": [{ "type": "...", "content": "..." }],   // 0-3
//     "forget_memory_ids": [12, 15] }                               // 0-10
//
// Same rule as everywhere (plan section 37): these are *suggestions*.
// Nothing here writes anything — the backend validates ownership and
// visibility of every forget id and de-duplicates every candidate before
// it touches the database (memoryService.ts). A bad candidate or id is
// dropped, never a reason to throw away a good response. There is no
// `requires_confirmation` any more: consent is the player's "Memory usage"
// setting, expressed once (plan section 21, revised).

export const MAX_CHAT_MEMORY_CANDIDATES = 3;
export const MAX_CHAT_FORGET_IDS = 10;

const chatCandidateSchema = z.object({
  type: z.enum(MEMORY_TYPES),
  content: z.string().trim().min(1).max(MAX_MEMORY_CONTENT_LENGTH),
});

const chatOutputSchema = z.object({
  response: z.string().trim().min(1).max(MAX_RESPONSE_LENGTH),
  // Tolerant on purpose: a model that emits one malformed candidate must
  // not sink the response, so each element is validated on its own below.
  memory_candidates: z.array(z.unknown()).optional().nullable(),
  forget_memory_ids: z.array(z.unknown()).optional().nullable(),
});

export interface ParsedChatOutput {
  response: string;
  memoryCandidates: MemoryCandidate[];
  forgetMemoryIds: number[];
}

export type ParseChatOutputResult =
  | { ok: true; value: ParsedChatOutput }
  | { ok: false; reason: "invalid_json" | "invalid_shape" | "protected_topic" };

export function parseChatOutput(raw: string, forbiddenTopics: string[]): ParseChatOutputResult {
  const json = extractJsonObject(raw);
  if (!json) return { ok: false, reason: "invalid_json" };

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(json);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }

  const result = chatOutputSchema.safeParse(parsedJson);
  if (!result.success) return { ok: false, reason: "invalid_shape" };

  if (mentionsForbiddenTopic(result.data.response, forbiddenTopics)) {
    return { ok: false, reason: "protected_topic" };
  }

  const memoryCandidates: MemoryCandidate[] = [];
  for (const item of result.data.memory_candidates ?? []) {
    if (memoryCandidates.length >= MAX_CHAT_MEMORY_CANDIDATES) break;
    const candidate = chatCandidateSchema.safeParse(item);
    if (!candidate.success) continue;
    if (mentionsForbiddenTopic(candidate.data.content, forbiddenTopics)) continue;
    memoryCandidates.push({ type: candidate.data.type, content: neutralizeMentions(candidate.data.content) });
  }

  const forgetMemoryIds: number[] = [];
  for (const item of result.data.forget_memory_ids ?? []) {
    if (forgetMemoryIds.length >= MAX_CHAT_FORGET_IDS) break;
    if (typeof item === "number" && Number.isInteger(item) && item > 0 && !forgetMemoryIds.includes(item)) {
      forgetMemoryIds.push(item);
    }
  }

  return {
    ok: true,
    value: { response: neutralizeMentions(result.data.response), memoryCandidates, forgetMemoryIds },
  };
}
