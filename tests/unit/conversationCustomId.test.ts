import { describe, expect, it } from "vitest";
import {
  buildConsoleModalCustomId,
  buildConsoleReplyCustomId,
  isConsoleModalCustomId,
  isConsoleReplyCustomId,
  parseConsoleModalCustomId,
  parseConsoleReplyCustomId,
} from "../../src/modules/ai/conversationCustomId.js";
import { parseAttendanceCustomId } from "../../src/modules/attendance/customId.js";

describe("conversation custom ids", () => {
  it("round-trips the reply button and the modal", () => {
    expect(parseConsoleReplyCustomId(buildConsoleReplyCustomId(42))).toBe(42);
    expect(parseConsoleModalCustomId(buildConsoleModalCustomId(42))).toBe(42);
  });

  it("keeps the two ids distinct from each other and from attendance ids", () => {
    const reply = buildConsoleReplyCustomId(1);
    const modal = buildConsoleModalCustomId(1);
    expect(isConsoleReplyCustomId(reply)).toBe(true);
    expect(isConsoleModalCustomId(reply)).toBe(false);
    expect(isConsoleModalCustomId(modal)).toBe(true);
    expect(isConsoleReplyCustomId(modal)).toBe(false);
    expect(parseAttendanceCustomId(reply)).toBeNull();
    expect(isConsoleReplyCustomId("attendance:1:PLAYING")).toBe(false);
  });

  it.each(["console:reply:", "console:reply:abc", "console:reply:0", "console:reply:-3", "console:reply:1.5", "console:reply:1:2", "console:reply: 7", "reply:7"])(
    "rejects malformed id %j",
    (id) => {
      expect(parseConsoleReplyCustomId(id)).toBeNull();
    },
  );

  it("rejects ids too large to be a safe integer", () => {
    expect(parseConsoleModalCustomId("console:modal:99999999999999999999")).toBeNull();
  });
});
