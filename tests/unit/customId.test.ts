import { describe, expect, it } from "vitest";
import { buildAttendanceCustomId, parseAttendanceCustomId } from "../../src/modules/attendance/customId.js";

describe("attendance custom_id", () => {
  it("round-trips every valid status", () => {
    for (const status of ["PLAYING", "CANNOT_PLAY", "WANTS_TO_BUT_CANNOT"] as const) {
      const id = buildAttendanceCustomId(42, status);
      expect(parseAttendanceCustomId(id)).toEqual({ matchId: 42, status });
    }
  });

  it("stays well under Discord's 100-char custom_id limit", () => {
    const id = buildAttendanceCustomId(999999, "WANTS_TO_BUT_CANNOT");
    expect(id.length).toBeLessThanOrEqual(100);
  });

  it("rejects a custom_id from a different feature", () => {
    expect(parseAttendanceCustomId("some-other-button:1:2")).toBeNull();
  });

  it("rejects a malformed match id", () => {
    expect(parseAttendanceCustomId("attendance:not-a-number:PLAYING")).toBeNull();
    expect(parseAttendanceCustomId("attendance:-5:PLAYING")).toBeNull();
    expect(parseAttendanceCustomId("attendance:0:PLAYING")).toBeNull();
  });

  it("rejects an unknown status", () => {
    expect(parseAttendanceCustomId("attendance:42:MAYBE")).toBeNull();
    expect(parseAttendanceCustomId("attendance:42:NO_RESPONSE")).toBeNull();
  });

  it("rejects a truncated or extended id", () => {
    expect(parseAttendanceCustomId("attendance:42")).toBeNull();
    expect(parseAttendanceCustomId("attendance:42:PLAYING:extra")).toBeNull();
  });
});
