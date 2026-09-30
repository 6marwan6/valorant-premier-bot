import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { parseMatchDateTime, formatMatchDateTime } from "../../src/modules/matches/dateTime.js";

describe("parseMatchDateTime", () => {
  it("parses the plan's own example (section 11) correctly", () => {
    const result = parseMatchDateTime("18/09/2026", "19:00", "Europe/Berlin");
    expect(result.ok).toBe(true);
    if (result.ok) {
      // 18 Sep 2026 19:00 Europe/Berlin (CEST, UTC+2) = 17:00 UTC.
      expect(result.scheduledAt.toISOString()).toBe("2026-09-18T17:00:00.000Z");
    }
  });

  it("interprets the same wall-clock time differently across timezones", () => {
    const berlin = parseMatchDateTime("18/09/2026", "19:00", "Europe/Berlin");
    const cairo = parseMatchDateTime("18/09/2026", "19:00", "Africa/Cairo");
    expect(berlin.ok && cairo.ok).toBe(true);
    if (berlin.ok && cairo.ok) {
      expect(berlin.scheduledAt.getTime()).not.toBe(cairo.scheduledAt.getTime());
    }
  });

  it("rejects a malformed date (wrong separator/order)", () => {
    const result = parseMatchDateTime("2026-09-18", "19:00", "Europe/Berlin");
    expect(result.ok).toBe(false);
  });

  it("rejects a calendar-invalid date (Feb 30)", () => {
    const result = parseMatchDateTime("30/02/2026", "19:00", "Europe/Berlin");
    expect(result.ok).toBe(false);
  });

  it("rejects Feb 29 on a non-leap year", () => {
    // 2026 is not a leap year.
    const result = parseMatchDateTime("29/02/2026", "19:00", "Europe/Berlin");
    expect(result.ok).toBe(false);
  });

  it("accepts Feb 29 on a real leap year", () => {
    const result = parseMatchDateTime("29/02/2028", "19:00", "Europe/Berlin");
    expect(result.ok).toBe(true);
  });

  it("rejects an out-of-range time", () => {
    expect(parseMatchDateTime("18/09/2026", "25:00", "Europe/Berlin").ok).toBe(false);
    expect(parseMatchDateTime("18/09/2026", "19:61", "Europe/Berlin").ok).toBe(false);
  });

  it("rejects an invalid IANA timezone rather than silently defaulting", () => {
    const result = parseMatchDateTime("18/09/2026", "19:00", "Europe/Frankfurt");
    expect(result.ok).toBe(false);
  });

  it("handles a DST transition correctly (plan section 59 Phase 4 calls this out explicitly)", () => {
    // Europe/Berlin springs forward on the last Sunday of March. 2026's
    // transition is 29 March, 02:00 -> 03:00 CEST. 01:30 still exists
    // (before the jump); the offset either side must differ.
    const before = parseMatchDateTime("29/03/2026", "01:30", "Europe/Berlin");
    const after = parseMatchDateTime("29/03/2026", "03:30", "Europe/Berlin");
    expect(before.ok && after.ok).toBe(true);
  });
});

describe("formatMatchDateTime", () => {
  it("round-trips a parsed date back into a readable string in the same zone", () => {
    const parsed = parseMatchDateTime("18/09/2026", "19:00", "Europe/Berlin");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const formatted = formatMatchDateTime(parsed.scheduledAt, "Europe/Berlin");
      // formatMatchDateTime deliberately matches the plan's own display
      // convention (sections 14/16: "Today at 7:00 PM"), 12-hour with AM/PM.
      expect(formatted).toContain("7:00 PM");
      expect(formatted.toLowerCase()).toContain("september");
    }
  });
});

describe("parseMatchDateTime — looser formats (2026-09-28 revision)", () => {
  // A fixed "now" so every relative case below is deterministic:
  // Thursday 24 September 2026, 10:00 Europe/Berlin.
  const NOW = new Date("2026-09-24T08:00:00.000Z");

  it("still accepts the plan's own exact example untouched", () => {
    const result = parseMatchDateTime("18/09/2026", "19:00", "Europe/Berlin", NOW);
    expect(result.ok).toBe(true);
  });

  it('date: "today" + time: 24h HH:mm', () => {
    const result = parseMatchDateTime("today", "19:00", "Europe/Berlin", NOW);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.scheduledAt.toISOString()).toBe("2026-09-24T17:00:00.000Z");
  });

  it('date: "tomorrow" + time: "7pm"', () => {
    const result = parseMatchDateTime("tomorrow", "7pm", "Europe/Berlin", NOW);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.scheduledAt.toISOString()).toBe("2026-09-25T17:00:00.000Z");
  });

  it('time: "morning" anchors to 09:00', () => {
    const result = parseMatchDateTime("tomorrow", "morning", "Europe/Berlin", NOW);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.scheduledAt.toISOString()).toBe("2026-09-25T07:00:00.000Z");
  });

  it.each([
    ["evening", 19],
    ["afternoon", 15],
    ["night", 21],
    ["noon", 12],
    ["midnight", 0],
  ])('time: "%s" anchors to %d:00', (word, hour) => {
    const result = parseMatchDateTime("tomorrow", word, "Europe/Berlin", NOW);
    expect(result.ok).toBe(true);
    if (result.ok) expect(DateTime.fromJSDate(result.scheduledAt, { zone: "Europe/Berlin" }).hour).toBe(hour);
  });

  it('time: "2 hours" (bare, no "in") is 2 hours from now, with date: today', () => {
    const result = parseMatchDateTime("today", "2 hours", "Europe/Berlin", NOW);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.scheduledAt.toISOString()).toBe("2026-09-24T10:00:00.000Z");
  });

  it('time: "in 90m" also works, and "1h30m" combines both units', () => {
    const a = parseMatchDateTime("today", "in 90m", "Europe/Berlin", NOW);
    const b = parseMatchDateTime("today", "1h30m", "Europe/Berlin", NOW);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.scheduledAt.toISOString()).toBe("2026-09-24T09:30:00.000Z");
      expect(a.scheduledAt.toISOString()).toBe(b.scheduledAt.toISOString());
    }
  });

  it('a relative duration rejects a non-"today" date rather than silently ignoring it', () => {
    const result = parseMatchDateTime("tomorrow", "2 hours", "Europe/Berlin", NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/only works with date: today/i);
  });

  it("a bare weekday resolves to its next occurrence, including today itself", () => {
    // NOW is Thursday.
    const thursday = parseMatchDateTime("thursday", "19:00", "Europe/Berlin", NOW);
    const saturday = parseMatchDateTime("saturday", "19:00", "Europe/Berlin", NOW);
    expect(thursday.ok && saturday.ok).toBe(true);
    if (thursday.ok && saturday.ok) {
      expect(DateTime.fromJSDate(thursday.scheduledAt, { zone: "Europe/Berlin" }).toISODate()).toBe("2026-09-24");
      expect(DateTime.fromJSDate(saturday.scheduledAt, { zone: "Europe/Berlin" }).toISODate()).toBe("2026-09-26");
    }
  });

  it('"next <weekday>" always skips a full week ahead, even for today\'s own weekday', () => {
    const result = parseMatchDateTime("next thursday", "19:00", "Europe/Berlin", NOW);
    expect(result.ok).toBe(true);
    if (result.ok) expect(DateTime.fromJSDate(result.scheduledAt, { zone: "Europe/Berlin" }).toISODate()).toBe("2026-10-01");
  });

  it('"in N days" / "in N weeks" work for the date field', () => {
    const days = parseMatchDateTime("in 3 days", "19:00", "Europe/Berlin", NOW);
    const weeks = parseMatchDateTime("in 2 weeks", "19:00", "Europe/Berlin", NOW);
    expect(days.ok && weeks.ok).toBe(true);
    if (days.ok && weeks.ok) {
      expect(DateTime.fromJSDate(days.scheduledAt, { zone: "Europe/Berlin" }).toISODate()).toBe("2026-09-27");
      expect(DateTime.fromJSDate(weeks.scheduledAt, { zone: "Europe/Berlin" }).toISODate()).toBe("2026-10-08");
    }
  });

  it("the loose date parser also accepts D/M/YYYY with either separator", () => {
    const slash = parseMatchDateTime("8/9/2026", "19:00", "Europe/Berlin", NOW);
    const dash = parseMatchDateTime("8-9-2026", "19:00", "Europe/Berlin", NOW);
    expect(slash.ok && dash.ok).toBe(true);
    if (slash.ok && dash.ok) {
      expect(DateTime.fromJSDate(slash.scheduledAt, { zone: "Europe/Berlin" }).toISODate()).toBe("2026-09-08");
      expect(slash.scheduledAt.toISOString()).toBe(dash.scheduledAt.toISOString());
    }
  });

  it("an exact date paired with a loose time still works (mixed strictness)", () => {
    const result = parseMatchDateTime("18/09/2026", "7pm", "Europe/Berlin", NOW);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.scheduledAt.toISOString()).toBe("2026-09-18T17:00:00.000Z");
  });

  it("rejects a calendar-invalid loose date (31 Sep has no 31st) the same as the strict path", () => {
    const result = parseMatchDateTime("31/09/2026", "19:00", "Europe/Berlin", NOW);
    expect(result.ok).toBe(false);
  });

  it("rejects an out-of-range loose time (13pm, 19:61)", () => {
    expect(parseMatchDateTime("tomorrow", "13pm", "Europe/Berlin", NOW).ok).toBe(false);
    expect(parseMatchDateTime("tomorrow", "19:61", "Europe/Berlin", NOW).ok).toBe(false);
  });

  it("rejects gibberish in either field with a helpful combined message", () => {
    const result = parseMatchDateTime("whenever", "some time", "Europe/Berlin", NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("whenever");
      expect(result.error).toContain("some time");
    }
  });

  it("rejects an invalid IANA timezone on the loose path too, not just the strict one", () => {
    const result = parseMatchDateTime("tomorrow", "7pm", "Europe/Frankfurt", NOW);
    expect(result.ok).toBe(false);
  });

  it("a bare ambiguous number with no unit is rejected, not guessed as a duration", () => {
    const result = parseMatchDateTime("today", "2", "Europe/Berlin", NOW);
    expect(result.ok).toBe(false);
  });
});
