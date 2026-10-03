/**
 * Encodes the weekly-schedule buttons into Discord's component `custom_id`
 * (max 100 chars; these are ~20):
 *
 *   sched:<pollId>:vote:<slotId>    toggle "I can play this slot"
 *   sched:<pollId>:decline          "I can't play any day"
 *
 * Same contract as attendance/customId.ts: parse returns null for anything
 * malformed so the dispatcher treats it like an unknown button instead of
 * crashing.
 */
const PREFIX = "sched";

export type ScheduleAction = { pollId: number; kind: "vote"; slotId: number } | { pollId: number; kind: "decline" };

export function buildVoteCustomId(pollId: number, slotId: number): string {
  return `${PREFIX}:${pollId}:vote:${slotId}`;
}

export function buildDeclineCustomId(pollId: number): string {
  return `${PREFIX}:${pollId}:decline`;
}

export function isScheduleCustomId(customId: string): boolean {
  return customId.startsWith(`${PREFIX}:`);
}

function positiveInt(raw: string | undefined): number | null {
  const n = Number(raw);
  return raw !== undefined && Number.isInteger(n) && n > 0 ? n : null;
}

export function parseScheduleCustomId(customId: string): ScheduleAction | null {
  const parts = customId.split(":");
  if (parts[0] !== PREFIX) return null;
  const pollId = positiveInt(parts[1]);
  if (pollId === null) return null;
  if (parts.length === 3 && parts[2] === "decline") return { pollId, kind: "decline" };
  if (parts.length === 4 && parts[2] === "vote") {
    const slotId = positiveInt(parts[3]);
    return slotId === null ? null : { pollId, kind: "vote", slotId };
  }
  return null;
}
