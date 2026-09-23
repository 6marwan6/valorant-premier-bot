import { describe, expect, it } from "vitest";
import { formatOffsetLabel, planReminders } from "../../src/modules/reminders/reminderScheduling.js";

describe("planReminders", () => {
  it("computes scheduled_at as an absolute instant offset before kickoff (plan section 13's 180/60/15 example)", () => {
    const kickoff = new Date("2026-11-01T19:00:00Z");
    const plan = planReminders(kickoff, [180, 60, 15]);

    expect(plan).toHaveLength(3);
    expect(plan.map((p) => p.scheduledAt.toISOString())).toEqual([
      "2026-11-01T16:00:00.000Z", // 3h before
      "2026-11-01T18:00:00.000Z", // 1h before
      "2026-11-01T18:45:00.000Z", // 15m before
    ]);
  });

  it("sorts by largest offset first — plan[0] is always the announcement-triggering reminder", () => {
    const kickoff = new Date("2026-11-01T19:00:00Z");
    const plan = planReminders(kickoff, [15, 180, 60]);
    expect(plan.map((p) => p.offsetMinutes)).toEqual([180, 60, 15]);
  });

  it("de-duplicates repeated offsets — plan section 13/50: one unique reminder record per offset, not per config entry", () => {
    const kickoff = new Date("2026-11-01T19:00:00Z");
    const plan = planReminders(kickoff, [60, 60, 180]);
    expect(plan.map((p) => p.offsetMinutes)).toEqual([180, 60]);
  });

  it("drops zero/negative/non-finite offsets rather than producing a reminder scheduled at or after kickoff", () => {
    const kickoff = new Date("2026-11-01T19:00:00Z");
    const plan = planReminders(kickoff, [180, 0, -30, Number.NaN]);
    expect(plan.map((p) => p.offsetMinutes)).toEqual([180]);
  });

  it("handles an empty offsets list (admin configured zero reminders)", () => {
    expect(planReminders(new Date("2026-11-01T19:00:00Z"), [])).toEqual([]);
  });

  it("DST transition: offsets are absolute-instant math, unaffected by the admin's original wall-clock zone", () => {
    // Europe DST falls back on 2026-10-25 — a match created for the
    // evening before, with a reminder offset crossing midnight into the
    // transition, must still be exactly 300 minutes (absolute) before
    // kickoff, not "5 wall-clock hours" (which would be off by one after
    // the clocks change).
    const kickoff = new Date("2026-10-25T20:00:00Z"); // already an absolute UTC instant, as dateTime.ts would have resolved it
    const plan = planReminders(kickoff, [300]);
    expect(plan[0]!.scheduledAt.toISOString()).toBe("2026-10-25T15:00:00.000Z");
    expect(kickoff.getTime() - plan[0]!.scheduledAt.getTime()).toBe(300 * 60_000);
  });
});

describe("formatOffsetLabel", () => {
  it("formats whole hours", () => {
    expect(formatOffsetLabel(60)).toBe("1 hour");
    expect(formatOffsetLabel(180)).toBe("3 hours");
  });

  it("formats sub-hour minutes", () => {
    expect(formatOffsetLabel(15)).toBe("15 minutes");
    expect(formatOffsetLabel(45)).toBe("45 minutes");
  });

  it("formats mixed hours+minutes", () => {
    expect(formatOffsetLabel(90)).toBe("1h 30m");
    expect(formatOffsetLabel(200)).toBe("3h 20m");
  });
});
