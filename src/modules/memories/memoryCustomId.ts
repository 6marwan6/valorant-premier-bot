/**
 * custom_id encoding for the memory-approval UI (Phase 8, plan section 21).
 *
 * Same round-trip idea as conversationCustomId.ts: the click carries the id
 * of the ai_messages row the candidate lives on (see aiConversations.ts's
 * schema doc) — that row is both the candidate's content and its evidence
 * (plan section 25), so no separate lookup table is needed.
 *
 *   memory:remember:<messageId>
 *   memory:decline:<messageId>
 *
 * Parsing returns null for anything malformed, same convention as every
 * other custom_id module here, so the router can treat it like an unknown
 * button rather than throw.
 */
const REMEMBER_PREFIX = "memory:remember:";
const DECLINE_PREFIX = "memory:decline:";

export function buildMemoryRememberCustomId(messageId: number): string {
  return `${REMEMBER_PREFIX}${messageId}`;
}

export function buildMemoryDeclineCustomId(messageId: number): string {
  return `${DECLINE_PREFIX}${messageId}`;
}

function parseId(customId: string, prefix: string): number | null {
  if (!customId.startsWith(prefix)) return null;
  const raw = customId.slice(prefix.length);
  if (!/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function isMemoryDecisionCustomId(customId: string): boolean {
  return customId.startsWith(REMEMBER_PREFIX) || customId.startsWith(DECLINE_PREFIX);
}

/** Returns the decision implied by the prefix, or null if the id itself doesn't parse. */
export function parseMemoryDecisionCustomId(customId: string): { messageId: number; decision: "remember" | "decline" } | null {
  const decision = customId.startsWith(REMEMBER_PREFIX) ? "remember" : customId.startsWith(DECLINE_PREFIX) ? "decline" : null;
  if (!decision) return null;
  const messageId = parseId(customId, decision === "remember" ? REMEMBER_PREFIX : DECLINE_PREFIX);
  return messageId === null ? null : { messageId, decision };
}
