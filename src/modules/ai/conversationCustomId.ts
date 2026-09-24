/**
 * custom_id encoding for the private-conversation UI (Phase 7).
 *
 * Two ids, same round-trip idea as attendance/customId.ts — Discord hands
 * back whatever we set, so the id is the only state a click has:
 *
 *   console:reply:<conversationId>   the "💬 Reply" button under a bot DM
 *   console:modal:<conversationId>   the modal that button opens
 *
 * Parsing returns null for anything malformed so the interaction router can
 * treat it like an unknown button rather than crash.
 */
const REPLY_PREFIX = "console:reply:";
const MODAL_PREFIX = "console:modal:";

export function buildConsoleReplyCustomId(conversationId: number): string {
  return `${REPLY_PREFIX}${conversationId}`;
}

export function buildConsoleModalCustomId(conversationId: number): string {
  return `${MODAL_PREFIX}${conversationId}`;
}

function parseId(customId: string, prefix: string): number | null {
  if (!customId.startsWith(prefix)) return null;
  const raw = customId.slice(prefix.length);
  if (!/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function isConsoleReplyCustomId(customId: string): boolean {
  return customId.startsWith(REPLY_PREFIX);
}

export function isConsoleModalCustomId(customId: string): boolean {
  return customId.startsWith(MODAL_PREFIX);
}

export function parseConsoleReplyCustomId(customId: string): number | null {
  return parseId(customId, REPLY_PREFIX);
}

export function parseConsoleModalCustomId(customId: string): number | null {
  return parseId(customId, MODAL_PREFIX);
}

/** The single text-input field inside the reply modal. */
export const CONSOLE_MODAL_FIELD_ID = "reply";

/** Modal input cap (plan section 57: compact prompts; also keeps replies conversational). */
export const CONSOLE_MODAL_MAX_LENGTH = 500;
