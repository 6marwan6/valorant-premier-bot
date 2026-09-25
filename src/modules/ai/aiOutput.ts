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
const MAX_MEMORY_CONTENT_LENGTH = 300; // shown back to the player verbatim in the Remember/Don't Remember prompt

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

export function mentionsForbiddenTopic(text: string, forbiddenTopics: string[]): boolean {
  const haystack = text.toLowerCase();
  return forbiddenTopics.some((topic) => topic.length > 0 && haystack.includes(topic.toLowerCase()));
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
