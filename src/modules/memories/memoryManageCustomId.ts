/**
 * custom_id encoding for the delete button under each row of `/memories`
 * (plan sections 42/43: "Players should be able to request deletion of
 * their memories," offered here as "an interactive memory-management flow"
 * — the plan's own alternative to a separate `/memory-delete <id>` command,
 * chosen because it never requires the player to know or type a raw id.
 *
 * Deliberately a separate prefix (and separate module) from
 * memoryCustomId.ts's `memory:remember:` / `memory:decline:` — those
 * identify an ai_messages row (a proposal); this one identifies a
 * memories row directly (an already-approved fact). Different table,
 * different lifecycle, same round-trip convention as every other
 * custom_id module here.
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
