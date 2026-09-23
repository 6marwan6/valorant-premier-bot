import { z } from "zod";

/**
 * Plan section 36 (structured AI output) and section 55 ("AI output
 * validation"): the backend never trusts raw model text. `memory_candidate`
 * is accepted but deliberately discarded in Phase 6 — memories are Phase 8,
 * and section 37 says the LLM can only ever *suggest*; it never writes.
 */
const MAX_RESPONSE_LENGTH = 1000; // section 35: concise; also far below Discord's 2000-char limit

const aiOutputSchema = z.object({
  response: z.string().trim().min(1).max(MAX_RESPONSE_LENGTH),
  should_follow_up: z.boolean().optional(),
  memory_candidate: z.unknown().optional(),
});

export interface ParsedAiOutput {
  response: string;
  shouldFollowUp: boolean;
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

  return {
    ok: true,
    value: {
      response: neutralizeMentions(result.data.response),
      shouldFollowUp: result.data.should_follow_up ?? false,
    },
  };
}
