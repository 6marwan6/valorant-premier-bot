import { describe, expect, it } from "vitest";
import {
  effectiveAt,
  formatSlotDay,
  formatSlotTime,
  MAX_SLOTS,
  MIN_PLAYERS_TO_QUEUE,
  parseQueueInput,
  parseSlotsInput,
  pickLeadingSlot,
  shouldRemind,
  voteBar,
  type SlotLike,
} from "../../src/modules/schedules/scheduleLogic.js";

const TZ = "Africa/Cairo";
const NOW = new Date("2026-10-03T10:00:00Z"); // a Saturday

function slot(id: number, iso: string, extra: Partial<SlotLike> = {}): SlotLike {
  return { id, scheduledAt: new Date(iso), queueAt: null, remindMode: "AUTO", ...extra };
}
const counts = (o: Record<number, number>) => new Map(Object.entries(o).map(([k, v]) => [Number(k), v]));

describe("pickLeadingSlot — highest-voted slot, only with 5+ votes", () => {
  const slots = [slot(1, "2026-10-08T16:00:00Z"), slot(2, "2026-10-10T16:00:00Z"), slot(3, "2026-10-11T16:00:00Z")];

  it("picks the slot with the most votes when it has enough players", () => {
    expect(pickLeadingSlot(slots, counts({ 1: 5, 2: 6, 3: 2 }), NOW)?.id).toBe(2);
  });

  it("needs at least MIN_PLAYERS_TO_QUEUE (5) — 4 votes is no match", () => {
    expect(MIN_PLAYERS_TO_QUEUE).toBe(5);
    expect(pickLeadingSlot(slots, counts({ 1: 4, 2: 4, 3: 3 }), NOW)).toBeNull();
    expect(pickLeadingSlot(slots, counts({ 3: 5 }), NOW)?.id).toBe(3);
  });

  it("breaks ties toward the earliest slot", () => {
    expect(pickLeadingSlot(slots, counts({ 2: 5, 3: 5 }), NOW)?.id).toBe(2);
    expect(pickLeadingSlot([...slots].reverse(), counts({ 2: 5, 3: 5 }), NOW)?.id).toBe(2);
  });

  it("ignores slots that already started and slots switched off", () => {
    const mixed = [slot(1, "2026-10-01T16:00:00Z"), slot(2, "2026-10-10T16:00:00Z", { remindMode: "NEVER" }), slot(3, "2026-10-11T16:00:00Z")];
    expect(pickLeadingSlot(mixed, counts({ 1: 7, 2: 7, 3: 5 }), NOW)?.id).toBe(3);
  });

  it("judges 'already started' by the queue time when one is set", () => {
    const late = slot(1, "2026-10-03T09:00:00Z", { queueAt: new Date("2026-10-03T12:00:00Z") });
    expect(pickLeadingSlot([late], counts({ 1: 5 }), NOW)?.id).toBe(1);
  });
});

describe("shouldRemind", () => {
  it("AUTO follows the leader; ALWAYS and NEVER are the admin's override", () => {
    expect(shouldRemind({ id: 1, remindMode: "AUTO" }, 1)).toBe(true);
    expect(shouldRemind({ id: 2, remindMode: "AUTO" }, 1)).toBe(false);
    expect(shouldRemind({ id: 1, remindMode: "AUTO" }, null)).toBe(false);
    expect(shouldRemind({ id: 2, remindMode: "ALWAYS" }, 1)).toBe(true);
    expect(shouldRemind({ id: 2, remindMode: "ALWAYS" }, null)).toBe(true);
    expect(shouldRemind({ id: 1, remindMode: "NEVER" }, 1)).toBe(false);
  });
});

describe("effectiveAt", () => {
  it("is the queue time when set, else the slot time", () => {
    expect(effectiveAt(slot(1, "2026-10-10T16:00:00Z")).toISOString()).toBe("2026-10-10T16:00:00.000Z");
    expect(effectiveAt(slot(1, "2026-10-10T16:00:00Z", { queueAt: new Date("2026-10-10T16:30:00Z") })).toISOString()).toBe("2026-10-10T16:30:00.000Z");
  });
});

describe("voteBar / formatting", () => {
  it("fills toward the quorum and never overflows", () => {
    expect(voteBar(0)).toBe("□□□□□");
    expect(voteBar(3)).toBe("■■■□□");
    expect(voteBar(7)).toBe("■■■■■");
  });

  it("formats day and time in the poll's timezone", () => {
    const at = new Date("2026-10-10T16:00:00Z"); // 19:00 in Cairo (UTC+3)
    expect(formatSlotDay(at, TZ)).toBe("SAT 10/10");
    expect(formatSlotTime(at, TZ)).toBe("19:00");
  });
});

describe("parseSlotsInput", () => {
  it("reads weekday + time entries, sorted earliest first, in the team's timezone", () => {
    const r = parseSlotsInput("sun 8pm, sat 7pm", TZ, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.slots.map((d) => d.toISOString())).toEqual(["2026-10-03T16:00:00.000Z", "2026-10-04T17:00:00.000Z"]);
  });

  it("reads DD/MM HH:mm with the year inferred (next occurrence) and explicit years", () => {
    const r = parseSlotsInput("10/10 19:00; 11/10/2026 19:00\n09/10 18:30", TZ, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.slots.map((d) => formatSlotDay(d, TZ))).toEqual(["FRI 09/10", "SAT 10/10", "SUN 11/10"]);
    const rolled = parseSlotsInput("01/01 19:00", TZ, NOW);
    expect(rolled.ok && rolled.slots[0]!.getUTCFullYear()).toBe(2027);
  });

  it.each([
    ["", /at least one slot/],
    ["sat", /Couldn't read/],
    ["blah 7pm", /blah 7pm/],
    ["sat 7pm, sat 7pm", /twice/],
    ["01/10/2026 19:00", /past/],
    ["31/02/2027 19:00", /real date/],
  ])("rejects %j", (input, message) => {
    const r = parseSlotsInput(input, TZ, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(message);
  });

  it("caps a schedule at MAX_SLOTS", () => {
    const many = Array.from({ length: MAX_SLOTS + 1 }, (_, i) => `${String(10 + i).padStart(2, "0")}/11 19:00`).join(", ");
    const r = parseSlotsInput(many, TZ, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/at most/);
  });
});

describe("parseQueueInput — the 'we're queuing at 7:30' edit", () => {
  const slotAt = new Date("2026-10-10T16:00:00Z"); // SAT 19:00 Cairo

  it("reads a clock time on the slot's own day", () => {
    for (const text of ["19:30", "7:30pm", "7:30 PM"]) {
      const r = parseQueueInput(text, slotAt, TZ, NOW);
      expect(r.ok && r.queueAt?.toISOString()).toBe("2026-10-10T16:30:00.000Z");
    }
  });

  it("clears with clear/none/off", () => {
    for (const text of ["clear", "None", "off"]) expect(parseQueueInput(text, slotAt, TZ, NOW)).toEqual({ ok: true, queueAt: null });
  });

  it("rejects gibberish and times already passed", () => {
    expect(parseQueueInput("later", slotAt, TZ, NOW).ok).toBe(false);
    const past = parseQueueInput("19:30", new Date("2026-10-01T16:00:00Z"), TZ, NOW);
    expect(past.ok).toBe(false);
  });
});
