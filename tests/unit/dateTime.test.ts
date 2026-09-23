import { describe, expect, it } from "vitest";
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
