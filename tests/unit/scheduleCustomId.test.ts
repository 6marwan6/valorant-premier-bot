import { describe, expect, it } from "vitest";
import { buildDeclineCustomId, buildVoteCustomId, isScheduleCustomId, parseScheduleCustomId } from "../../src/modules/schedules/scheduleCustomId.js";

describe("schedule custom ids", () => {
  it("round-trips votes and declines", () => {
    expect(parseScheduleCustomId(buildVoteCustomId(7, 31))).toEqual({ pollId: 7, kind: "vote", slotId: 31 });
    expect(parseScheduleCustomId(buildDeclineCustomId(7))).toEqual({ pollId: 7, kind: "decline" });
  });

  it("recognizes its own prefix and nothing else", () => {
    expect(isScheduleCustomId("sched:1:decline")).toBe(true);
    expect(isScheduleCustomId("attendance:1:PLAYING")).toBe(false);
  });

  it.each(["sched", "sched:x:decline", "sched:0:decline", "sched:1:vote", "sched:1:vote:0", "sched:1:vote:a", "sched:1:other", "sched:1:decline:2", "attendance:1:PLAYING"])(
    "returns null for %s",
    (id) => {
      expect(parseScheduleCustomId(id)).toBeNull();
    },
  );

  it("stays far below Discord's 100-character limit", () => {
    expect(buildVoteCustomId(999999, 999999).length).toBeLessThan(40);
  });
});
