import { describe, expect, it } from "vitest";
import type { MatchRow } from "../../src/database/schema/matches.js";
import type { AttendanceRow } from "../../src/database/schema/attendance.js";
import { buildReminderNudgeMessage } from "../../src/modules/reminders/reminderMessages.js";

function makeMatch(overrides: Partial<MatchRow> = {}): MatchRow {
  return {
    id: 42,
    guildId: "guild-1",
    opponent: "Team XYZ",
    scheduledAt: new Date("2026-11-01T19:00:00Z"),
    timezone: "Africa/Cairo",
    status: "CONFIRMATION_OPEN",
    announcementChannelId: "channel-1",
    announcementMessageId: "msg-1",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeAttendance(overrides: Partial<AttendanceRow>): AttendanceRow {
  return {
    id: 1,
    guildId: "guild-1",
    matchId: 42,
    discordUserId: "user-1",
    discordDisplayName: "Ahmed",
    status: "PLAYING",
    respondedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("buildReminderNudgeMessage", () => {
  it("includes the match id, opponent, and formatted offset (plan section 13/14)", () => {
    const content = buildReminderNudgeMessage(makeMatch(), [], 60);
    expect(content).toContain("Match #42");
    expect(content).toContain("Team XYZ");
    expect(content).toContain("1 hour");
  });

  it("tallies PLAYING separately from total responses", () => {
    const rows = [
      makeAttendance({ id: 1, discordUserId: "a", status: "PLAYING" }),
      makeAttendance({ id: 2, discordUserId: "b", status: "PLAYING" }),
      makeAttendance({ id: 3, discordUserId: "c", status: "WANTS_TO_BUT_CANNOT" }),
    ];
    const content = buildReminderNudgeMessage(makeMatch(), rows, 15);
    expect(content).toContain("2 confirmed playing");
    expect(content).toContain("3 responded total");
  });

  it("returns plain text only — no component/button payload (buttons stay solely on the roster message, plan section 16)", () => {
    const content = buildReminderNudgeMessage(makeMatch(), [], 180);
    expect(typeof content).toBe("string");
    expect(content).toContain("Scroll up to the match announcement and tap a button.");
  });

  it("handles zero responses without a negative or NaN tally", () => {
    const content = buildReminderNudgeMessage(makeMatch(), [], 15);
    expect(content).toContain("0 confirmed playing");
    expect(content).toContain("0 responded total");
  });
});
