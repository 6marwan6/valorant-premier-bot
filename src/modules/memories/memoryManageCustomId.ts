/**
 * custom_id encoding for a memory delete button — plan sections 42/43:
 * "Players should be able to request deletion of their memories," offered
 * here as "an interactive memory-management flow" — the plan's own
 * alternative to a separate `/memory-delete <id>` command, chosen because
 * it never requires the player to know or type a raw id.
 *
 * Since the section 21 revision (memories save automatically — see
 * memoryService.ts's `autoSave`), this is the *only* memory button there
 * is: `/memories`' own list uses it, and so does the one-tap "Forget this"
 * note consoleConversation.ts attaches right after an auto-save. Both
 * route to discord/memoryDelete.ts. It identifies a `memories` row
 * directly (a saved fact) — never an `ai_messages` row (a proposal); there
 * is no button for those anymore, since nothing waits on one.
 */
const DELETE_PREFIX = "memory:del:";

export function buildMemoryDeleteCustomId(memoryId: number): string {
  return `${DELETE_PREFIX}${memoryId}`;
}

export function isMemoryDeleteCustomId(customId: string): boolean {
  return customId.startsWith(DELETE_PREFIX);
}

export function parseMemoryDeleteCustomId(customId: string): number | null {
  if (!customId.startsWith(DELETE_PREFIX)) return null;
  const raw = customId.slice(DELETE_PREFIX.length);
  if (!/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
