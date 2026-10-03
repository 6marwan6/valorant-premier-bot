import { DateTime } from "luxon";
import { parseMatchDateTime } from "../matches/dateTime.js";

/**
 * Pure weekly-schedule logic — no database, no Discord — so the rules the
 * owner described are testable in isolation (plan section 60, same reasoning
 * as matchLifecycle.ts / reminderScheduling.ts):
 *
 *  - "we need 5 to play the match"            -> MIN_PLAYERS_TO_QUEUE
 *  - "highest-voted time by default, if it has 5 or more votes" -> pickLeadingSlot
 *  - "an additional time edit (we're queuing at 7:30)"          -> parseQueueInput / effectiveAt
 *
 * Everything here is deterministic application logic: the LLM has no part in
 * who is in or when the team queues (plan section 14, principle #9).
 */

/** "we need 5 to play the match" (owner, 2026-10-03). A constant for now; a server_config column if a team ever needs another number. */
export const MIN_PLAYERS_TO_QUEUE = 5;
/** Discord allows 5 buttons x 5 rows; slot buttons use at most 2 rows so the "can't play any day" button always fits below them. */
export const MAX_SLOTS = 10;

/** The slice of a slot the pure functions need — a `ScheduleSlotRow` satisfies it. */
export interface SlotLike {
  id: number;
  scheduledAt: Date;
  queueAt: Date | null;
  remindMode: "AUTO" | "ALWAYS" | "NEVER";
}

/** When the team actually queues: the admin's queue-time edit, else the slot's own time. Reminders count back from this. */
export function effectiveAt(slot: Pick<SlotLike, "scheduledAt" | "queueAt">): Date {
  return slot.queueAt ?? slot.scheduledAt;
}

/**
 * The slot this week's reminders are for when nothing is forced: the one with
 * the most votes, provided it has at least `minPlayers`; ties go to the
 * earliest. Slots whose time has already passed no longer compete (a Thursday
 * match that was played must not keep Saturday from being "the next match"),
 * and slots the admin switched off (NEVER) never lead. Null = nobody has
 * enough players yet.
 */
export function pickLeadingSlot(
  slots: readonly SlotLike[],
  voteCounts: ReadonlyMap<number, number>,
  now: Date,
  minPlayers: number = MIN_PLAYERS_TO_QUEUE,
): SlotLike | null {
  let best: SlotLike | null = null;
  let bestCount = 0;
  for (const slot of slots) {
    if (slot.remindMode === "NEVER") continue;
    if (effectiveAt(slot).getTime() <= now.getTime()) continue;
    const count = voteCounts.get(slot.id) ?? 0;
    if (count < minPlayers) continue;
    if (count > bestCount || (count === bestCount && best !== null && slot.scheduledAt < best.scheduledAt)) {
      best = slot;
      bestCount = count;
    }
  }
  return best;
}

/** Whether this slot's reminder should go out right now. AUTO follows the leader; ALWAYS / NEVER are the admin's override. */
export function shouldRemind(slot: Pick<SlotLike, "id" | "remindMode">, leaderId: number | null): boolean {
  if (slot.remindMode === "NEVER") return false;
  if (slot.remindMode === "ALWAYS") return true;
  return leaderId !== null && slot.id === leaderId;
}

/** `■■■□□` toward the quorum; extra votes beyond it just show in the number. */
export function voteBar(count: number, target: number = MIN_PLAYERS_TO_QUEUE): string {
  const filled = Math.max(0, Math.min(count, target));
  return "■".repeat(filled) + "□".repeat(Math.max(0, target - filled));
}

const DAY_ABBR = ["", "MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

/** `SAT 25/06` — the day column of the schedule board, in the poll's timezone. */
export function formatSlotDay(at: Date, timezone: string): string {
  const dt = DateTime.fromJSDate(at, { zone: timezone });
  return `${DAY_ABBR[dt.weekday]} ${dt.toFormat("dd/LL")}`;
}

/** `19:00` — 24h, in the poll's timezone. */
export function formatSlotTime(at: Date, timezone: string): string {
  return DateTime.fromJSDate(at, { zone: timezone }).toFormat("HH:mm");
}

const TIME_AT_END =
  /^(.+?)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)|\d{1,2}:\d{2}|noon|midnight|morning|afternoon|evening|night)$/i;

/** `25/06` (no year) -> the next 25 June, as the dd/MM/yyyy the strict parser reads. Anything else passes through unchanged. */
function withInferredYear(dateStr: string, now: Date, timezone: string): string {
  const m = /^(\d{1,2})[/-](\d{1,2})$/.exec(dateStr.trim());
  if (!m) return dateStr;
  const today = DateTime.fromJSDate(now, { zone: timezone }).startOf("day");
  let candidate = DateTime.fromObject({ day: Number(m[1]), month: Number(m[2]), year: today.year }, { zone: timezone });
  if (candidate.isValid && candidate < today) candidate = candidate.plus({ years: 1 });
  return candidate.isValid ? candidate.toFormat("dd/MM/yyyy") : dateStr;
}

export type ParsedSlots = { ok: true; slots: Date[] } | { ok: false; error: string };

/**
 * Reads the admin's `/create-schedule slots:` text — entries separated by
 * `,` `;` or a new line, each "<date> <time>":
 *
 *   sat 7pm, sun 7pm
 *   25/06 19:00; 26/06 19:00
 *   18/09/2026 19:00
 *
 * The date part takes everything /create-match's date field takes (plus a
 * yearless DD/MM meaning its next occurrence); the time part is the last
 * token(s). Slots must be in the future, distinct, and at most MAX_SLOTS;
 * the result is sorted earliest-first.
 */
export function parseSlotsInput(input: string, timezone: string, now: Date = new Date()): ParsedSlots {
  const entries = input
    .split(/[,;\n]+/)
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  if (entries.length === 0) {
    return { ok: false, error: "Give me at least one slot, e.g. `sat 7pm, sun 7pm`." };
  }
  if (entries.length > MAX_SLOTS) {
    return { ok: false, error: `That's ${entries.length} slots — a schedule holds at most ${MAX_SLOTS}.` };
  }

  const times = new Map<number, string>();
  for (const entry of entries) {
    const m = TIME_AT_END.exec(entry);
    if (!m) {
      return { ok: false, error: `Couldn't read "${entry}". Each slot is a date and a time, like \`sat 7pm\` or \`25/06 19:00\`.` };
    }
    const parsed = parseMatchDateTime(withInferredYear(m[1]!, now, timezone), m[2]!.trim(), timezone, now);
    if (!parsed.ok) return { ok: false, error: `"${entry}": ${parsed.error}` };
    if (parsed.scheduledAt.getTime() <= now.getTime()) {
      return { ok: false, error: `"${entry}" is already in the past.` };
    }
    const at = parsed.scheduledAt.getTime();
    if (times.has(at)) return { ok: false, error: `"${entry}" is listed twice.` };
    times.set(at, entry);
  }
  return { ok: true, slots: [...times.keys()].sort((a, b) => a - b).map((t) => new Date(t)) };
}

export type ParsedQueue = { ok: true; queueAt: Date | null } | { ok: false; error: string };

const CLEAR_WORDS = new Set(["clear", "none", "off", "reset", "remove"]);

/**
 * Reads the admin's queue-time edit for a slot: a clock time on the slot's own
 * day ("19:30", "7:30pm"), or `clear` to go back to queuing at the slot time.
 */
export function parseQueueInput(input: string, slotAt: Date, timezone: string, now: Date = new Date()): ParsedQueue {
  const text = input.trim();
  if (CLEAR_WORDS.has(text.toLowerCase())) return { ok: true, queueAt: null };
  const day = DateTime.fromJSDate(slotAt, { zone: timezone }).toFormat("dd/MM/yyyy");
  const parsed = parseMatchDateTime(day, text, timezone, now);
  if (!parsed.ok) {
    return { ok: false, error: `Couldn't read "${text}" as a time. Try \`19:30\`, \`7:30pm\`, or \`clear\`.` };
  }
  if (parsed.scheduledAt.getTime() <= now.getTime()) {
    return { ok: false, error: "That queue time has already passed." };
  }
  return { ok: true, queueAt: parsed.scheduledAt };
}
