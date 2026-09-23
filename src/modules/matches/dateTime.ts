import { DateTime } from "luxon";

/**
 * Parses the Date/Time strings a /create-match or /edit-match admin
 * enters into an absolute UTC instant, interpreted in the team's
 * configured timezone — plan section 11: "The team's configured timezone
 * should be used automatically", with explicit examples of the expected
 * formats:
 *
 *   Date: 18/09/2026
 *   Time: 19:00
 *
 * so this accepts exactly `dd/MM/yyyy` and `HH:mm` (24-hour), matching the
 * plan's own example, and rejects anything else with a specific reason
 * rather than a generic "invalid date" (plan section 11: "The bot should
 * validate: Date is valid. Time is valid.").
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

export function parseMatchDateTime(
  dateStr: string,
  timeStr: string,
  timezone: string,
): ParsedMatchDateTime | InvalidMatchDateTime {
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(dateStr)) {
    return { ok: false, error: `"${dateStr}" isn't a valid date. Use DD/MM/YYYY, e.g. 18/09/2026.` };
  }
  if (!/^\d{2}:\d{2}$/.test(timeStr)) {
    return { ok: false, error: `"${timeStr}" isn't a valid time. Use 24-hour HH:mm, e.g. 19:00.` };
  }

  const dt = DateTime.fromFormat(`${dateStr} ${timeStr}`, `${DATE_FORMAT} ${TIME_FORMAT}`, {
    zone: timezone,
  });

  if (!dt.isValid) {
    // Covers things regex alone can't catch: 31/02/2026, 29/02/2027
    // (not a leap year), 25:61, etc. Luxon's invalidReason/invalidExplanation
    // give a genuinely useful message rather than a bare "invalid".
    return {
      ok: false,
      error: `"${dateStr} ${timeStr}" isn't a real date/time (${dt.invalidReason ?? "invalid"}).`,
    };
  }

  return { ok: true, scheduledAt: dt.toJSDate() };
}

/**
 * Formats a stored UTC instant back into the plan's own display style
 * (plan sections 14/61 example: "Today at 7:00 PM" / "7:00 PM"), in the
 * timezone the match was actually created under — see matches.ts schema
 * doc for why that's stored per-match rather than re-read from the
 * (possibly since-changed) guild config.
 */
export function formatMatchDateTime(scheduledAt: Date, timezone: string): string {
  return DateTime.fromJSDate(scheduledAt, { zone: timezone }).toFormat("cccc d LLLL, h:mm a");
}
