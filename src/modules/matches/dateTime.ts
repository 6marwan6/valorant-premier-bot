import { DateTime } from "luxon";

/**
 * Parses the Date/Time strings a /create-match or /edit-match admin enters
 * into an absolute UTC instant, interpreted in the team's configured
 * timezone — plan section 11: "The team's configured timezone should be
 * used automatically", with explicit examples of the expected formats:
 *
 *   Date: 18/09/2026
 *   Time: 19:00
 *
 * **Revision, 2026-09-28:** admins also want to type things like "tomorrow"
 * / "in 3 days" / a weekday name for the date, and "7pm" / "morning" /
 * "2 hours" for the time, rather than always spelling out an exact
 * calendar date and 24h clock time. The two fields stay separate (the
 * plan's own shape); each just accepts more than one format now. The
 * plan's own DD/MM/YYYY + HH:mm example is tried FIRST and unconditionally
 * — every existing habit and every pre-revision test keeps working
 * byte-for-byte — and only when that exact shape doesn't match does either
 * field fall through to the looser forms below. Free-form NLP ("next
 * Tuesday-ish evening sometime") is deliberately out of scope (design
 * principle #11: start simple, extend only when the product needs it) —
 * these are a fixed, documented set of extra tokens, not a general parser.
 */
export interface ParsedMatchDateTime {
  ok: true;
  scheduledAt: Date;
}
export interface InvalidMatchDateTime {
  ok: false;
  error: string;
}

const DATE_FORMAT = "dd/MM/yyyy";
const TIME_FORMAT = "HH:mm";

/** Monday=1 .. Sunday=7, luxon's own `DateTime#weekday` numbering — full names plus the common three-letter abbreviations. */
const WEEKDAY_NUMBERS: Record<string, number> = {
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
  sunday: 7,
  sun: 7,
};

/**
 * The date field's looser forms: today/tomorrow/tonight, "in N day(s)"/"in
 * N week(s)", a bare weekday (the NEXT time it occurs, today counts), "next
 * <weekday>" (always the week after that), and DD/MM/YYYY or D/M/YYYY with
 * either "/" or "-". `today` is a zoned, start-of-day DateTime (already in
 * the match's timezone) so every offset below stays calendar-correct
 * across a DST boundary. Returns `null`, never throws, on anything it
 * doesn't recognize — the caller decides what an unparsed field means.
 */
function parseLooseDate(raw: string, today: DateTime): DateTime | null {
  const s = raw.trim().toLowerCase();
  if (s.length === 0) return null;
  if (s === "today" || s === "tonight" || s === "now") return today;
  if (s === "tomorrow") return today.plus({ days: 1 });

  let m = /^in\s+(\d+)\s*(?:d|day|days)$/.exec(s);
  if (m) return today.plus({ days: Number(m[1]) });
  m = /^in\s+(\d+)\s*(?:w|week|weeks)$/.exec(s);
  if (m) return today.plus({ weeks: Number(m[1]) });

  const nextMatch = /^next\s+([a-z]+)$/.exec(s);
  if (nextMatch) {
    const target = WEEKDAY_NUMBERS[nextMatch[1]!];
    if (target === undefined) return null;
    // Always the week AFTER the nearest occurrence, even when today itself matches.
    const delta = ((target - today.weekday + 7) % 7) + 7;
    return today.plus({ days: delta });
  }
  const bareWeekday = WEEKDAY_NUMBERS[s];
  if (bareWeekday !== undefined) {
    const delta = (bareWeekday - today.weekday + 7) % 7; // 0 = today
    return today.plus({ days: delta });
  }

  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);
  if (m) {
    const dt = DateTime.fromObject({ day: Number(m[1]), month: Number(m[2]), year: Number(m[3]) }, { zone: today.zone });
    return dt.isValid ? dt.startOf("day") : null;
  }

  return null;
}

/**
 * The time field's looser forms: a named part of day (morning/afternoon/
 * evening/night/noon/midnight/tonight — anchor times are a judgment call,
 * documented here rather than buried in a regex), 12h with am/pm in any of
 * the usual spacings ("7pm", "7 pm", "7:30pm"), or 24h HH:mm (same shape
 * the strict path accepts, plus a single-digit hour like "7:00"). Range
 * checks happen here so a bogus "13pm" or "19:61" is rejected before ever
 * reaching a DateTime.
 */
function parseLooseTime(raw: string): { hour: number; minute: number } | null {
  const s = raw.trim().toLowerCase();
  if (s.length === 0) return null;
  if (s === "noon") return { hour: 12, minute: 0 };
  if (s === "midnight") return { hour: 0, minute: 0 };
  if (s === "morning") return { hour: 9, minute: 0 };
  if (s === "afternoon") return { hour: 15, minute: 0 };
  if (s === "evening" || s === "tonight") return { hour: 19, minute: 0 };
  if (s === "night") return { hour: 21, minute: 0 };

  let m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/.exec(s);
  if (m) {
    const hour12 = Number(m[1]);
    const minute = m[2] ? Number(m[2]) : 0;
    if (hour12 < 1 || hour12 > 12 || minute > 59) return null;
    const isPm = m[3] === "pm";
    const hour = isPm ? (hour12 === 12 ? 12 : hour12 + 12) : hour12 === 12 ? 0 : hour12;
    return { hour, minute };
  }

  m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (m) {
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour > 23 || minute > 59) return null;
    return { hour, minute };
  }

  return null;
}

/**
 * A relative duration in the TIME field only — "2 hours", "in 90m",
 * "1h30m" — meaning "this many minutes from now", not a time-of-day.
 * Returns total minutes, or `null` for anything that isn't a duration
 * (including a bare number with no unit — "2" alone is ambiguous between
 * 2:00 and a duration, so it's deliberately rejected rather than guessed).
 */
function parseDuration(raw: string): number | null {
  const s = raw.trim().toLowerCase().replace(/^in\s+/, "");
  if (s.length === 0) return null;
  const m = /^(?:(\d+)\s*(?:h|hr|hrs|hour|hours))?\s*(?:(\d+)\s*(?:m|min|mins|minute|minutes))?$/.exec(s);
  if (!m || (m[1] === undefined && m[2] === undefined)) return null;
  const total = (m[1] ? Number(m[1]) * 60 : 0) + (m[2] ? Number(m[2]) : 0);
  return total > 0 ? total : null;
}

export function parseMatchDateTime(
  dateStr: string,
  timeStr: string,
  timezone: string,
  now: Date = new Date(),
): ParsedMatchDateTime | InvalidMatchDateTime {
  // 1. The plan's own exact example shape, tried first and unconditionally
  //    (pre-revision behavior, verbatim — see this file's doc comment).
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateStr) && /^\d{2}:\d{2}$/.test(timeStr)) {
    const dt = DateTime.fromFormat(`${dateStr} ${timeStr}`, `${DATE_FORMAT} ${TIME_FORMAT}`, { zone: timezone });
    if (!dt.isValid) {
      // Covers things regex alone can't catch: 31/02/2026, 29/02/2027
      // (not a leap year), 25:61, an invalid IANA zone, etc.
      return { ok: false, error: `"${dateStr} ${timeStr}" isn't a real date/time (${dt.invalidReason ?? "invalid"}).` };
    }
    return { ok: true, scheduledAt: dt.toJSDate() };
  }

  const nowInZone = DateTime.fromJSDate(now, { zone: timezone });
  if (!nowInZone.isValid) {
    return { ok: false, error: `"${timezone}" isn't a recognized timezone.` };
  }

  // 2. A relative duration in the time field only makes sense counted from
  //    *now* — so the date field has to actually mean "today" alongside it,
  //    or the two fields would be contradicting each other.
  const duration = parseDuration(timeStr);
  if (duration !== null) {
    const normalizedDate = dateStr.trim().toLowerCase();
    if (normalizedDate !== "" && !["today", "now", "tonight"].includes(normalizedDate)) {
      return {
        ok: false,
        error: `A relative time like "${timeStr}" only works with date: today (you gave "${dateStr}").`,
      };
    }
    return { ok: true, scheduledAt: nowInZone.plus({ minutes: duration }).toJSDate() };
  }

  // 3. Everything else: a loose calendar date plus a loose time-of-day.
  const baseDate = parseLooseDate(dateStr, nowInZone.startOf("day"));
  const time = parseLooseTime(timeStr);
  if (!baseDate || !time) {
    return {
      ok: false,
      error: `Couldn't understand "${dateStr}" / "${timeStr}". Try DD/MM/YYYY and 24h HH:mm (e.g. 18/09/2026, 19:00) — or looser forms: date: today, tomorrow, a weekday, "in 3 days"; time: 7pm, morning, evening, "2 hours".`,
    };
  }
  const dt = baseDate.set({ hour: time.hour, minute: time.minute, second: 0, millisecond: 0 });
  if (!dt.isValid) {
    return { ok: false, error: `"${dateStr} ${timeStr}" isn't a real date/time (${dt.invalidReason ?? "invalid"}).` };
  }
  return { ok: true, scheduledAt: dt.toJSDate() };
}

/**
 * Formats a stored UTC instant back into the plan's own display style
 * (plan sections 14/16 example: "Today at 7:00 PM"), in the timezone the
 * match was actually created under — see matches.ts schema doc for why
 * that's stored per-match rather than re-read from the (possibly
 * since-changed) guild config.
 */
export function formatMatchDateTime(scheduledAt: Date, timezone: string): string {
  return DateTime.fromJSDate(scheduledAt, { zone: timezone }).toFormat("cccc d LLLL, h:mm a");
}
