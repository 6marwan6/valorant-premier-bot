import { describe, expect, it } from "vitest";
import {
  buildMemoryDeclineCustomId,
  buildMemoryRememberCustomId,
  isMemoryDecisionCustomId,
  parseMemoryDecisionCustomId,
} from "../../src/modules/memories/memoryCustomId.js";
import {
  buildMemoryDeleteCustomId,
  isMemoryDeleteCustomId,
  parseMemoryDeleteCustomId,
} from "../../src/modules/memories/memoryManageCustomId.js";
import { parseAttendanceCustomId } from "../../src/modules/attendance/customId.js";
import { isConsoleReplyCustomId } from "../../src/modules/ai/conversationCustomId.js";

describe("memory decision custom ids (plan section 21)", () => {
  it("round-trips remember and decline", () => {
    expect(parseMemoryDecisionCustomId(buildMemoryRememberCustomId(42))).toEqual({ messageId: 42, decision: "remember" });
    expect(parseMemoryDecisionCustomId(buildMemoryDeclineCustomId(42))).toEqual({ messageId: 42, decision: "decline" });
  });

  it("keeps remember and decline distinct from each other and from every other custom_id family", () => {
    const remember = buildMemoryRememberCustomId(1);
    const decline = buildMemoryDeclineCustomId(1);
    expect(isMemoryDecisionCustomId(remember)).toBe(true);
    expect(isMemoryDecisionCustomId(decline)).toBe(true);
    expect(isMemoryDecisionCustomId("attendance:1:PLAYING")).toBe(false);
    expect(isMemoryDecisionCustomId("console:reply:1")).toBe(false);
    expect(isMemoryDecisionCustomId(buildMemoryDeleteCustomId(1))).toBe(false);
    expect(parseAttendanceCustomId(remember)).toBeNull();
    expect(isConsoleReplyCustomId(remember)).toBe(false);
  });

  it.each([
    "memory:remember:",
    "memory:remember:abc",
    "memory:remember:0",
    "memory:remember:-3",
    "memory:remember:1.5",
    "memory:remember:1:2",
    "memory:remember: 7",
    "memory:decline:",
    "memory:decline:abc",
    "remember:7",
  ])("rejects malformed id %j", (id) => {
    expect(parseMemoryDecisionCustomId(id)).toBeNull();
  });

  it("rejects ids too large to be a safe integer", () => {
    expect(parseMemoryDecisionCustomId("memory:remember:99999999999999999999")).toBeNull();
  });
});

describe("memory delete custom ids (plan sections 42/43)", () => {
  it("round-trips", () => {
    expect(parseMemoryDeleteCustomId(buildMemoryDeleteCustomId(7))).toBe(7);
  });

  it("stays distinct from the remember/decline family despite sharing the memory: prefix", () => {
    const del = buildMemoryDeleteCustomId(7);
    expect(isMemoryDeleteCustomId(del)).toBe(true);
    expect(isMemoryDecisionCustomId(del)).toBe(false);
    expect(isMemoryDeleteCustomId(buildMemoryRememberCustomId(7))).toBe(false);
  });

  it.each(["memory:del:", "memory:del:abc", "memory:del:0", "memory:del:-1", "memory:del:1.5", "del:7"])(
    "rejects malformed id %j",
    (id) => {
      expect(parseMemoryDeleteCustomId(id)).toBeNull();
    },
  );

  it("rejects ids too large to be a safe integer", () => {
    expect(parseMemoryDeleteCustomId("memory:del:99999999999999999999")).toBeNull();
  });
});
