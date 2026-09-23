import { describe, expect, it } from "vitest";
import { buildRosterMessage } from "../../src/modules/attendance/rosterMessage.js";
import type { MatchRow } from "../../src/database/schema/matches.js";
import type { AttendanceRow } from "../../src/database/schema/attendance.js";

function fakeMatch(overrides: Partial<MatchRow> = {}): MatchRow {
  return {
    id: 42,
    guildId: "guild-1",
    opponent: "Team XYZ",
    scheduledAt: new Date("2026-09-18T17:00:00Z"),
    timezone: "Europe/Berlin",
    status: "CONFIRMATION_OPEN",
    announcementChannelId: null,
    announcementMessageId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function fakeAttendance(overrides: Partial<AttendanceRow>): AttendanceRow {
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

describe("buildRosterMessage", () => {
  it("shows the plan section 14 header fields and 'no one yet' with zero responses", () => {
    const { content, components } = buildRosterMessage(fakeMatch(), []);
    expect(content).toContain("PREMIER MATCH");
    expect(content).toContain("Team XYZ");
    expect(content).toContain("No one has responded yet.");
    expect(content).not.toContain("undefined");
    expect(components).toHaveLength(1);
  });

  it("attaches exactly the 3 buttons from plan section 14 when accepting responses", () => {
    const { components } = buildRosterMessage(fakeMatch({ status: "CONFIRMATION_OPEN" }), []);
    const buttons = components[0]!.components.map((b) => b.toJSON());
    expect(buttons).toHaveLength(3);
    const customIds = buttons.map((b) => ("custom_id" in b ? b.custom_id : undefined));
    expect(customIds).toEqual([
      "attendance:42:PLAYING",
      "attendance:42:CANNOT_PLAY",
      "attendance:42:WANTS_TO_BUT_CANNOT",
    ]);
  });

  it("groups respondents under the correct section headings, in the plan section 16 order", () => {
    const rows = [
      fakeAttendance({ discordUserId: "u1", discordDisplayName: "Ahmed", status: "PLAYING" }),
      fakeAttendance({ id: 2, discordUserId: "u2", discordDisplayName: "Marwan", status: "PLAYING" }),
      fakeAttendance({ id: 3, discordUserId: "u3", discordDisplayName: "Omar", status: "WANTS_TO_BUT_CANNOT" }),
      fakeAttendance({ id: 4, discordUserId: "u4", discordDisplayName: "Ali", status: "CANNOT_PLAY" }),
    ];
    const { content } = buildRosterMessage(fakeMatch(), rows);

    const playingIdx = content.indexOf("🟢 Playing");
    const wantsIdx = content.indexOf("🟡 Want to, but can't");
    const cannotIdx = content.indexOf("🔴 Can't play");
    const ahmedIdx = content.indexOf("Ahmed");
    const omarIdx = content.indexOf("Omar");
    const aliIdx = content.indexOf("Ali");

    expect(playingIdx).toBeGreaterThan(-1);
    expect(wantsIdx).toBeGreaterThan(playingIdx);
    expect(cannotIdx).toBeGreaterThan(wantsIdx);
    expect(ahmedIdx).toBeGreaterThan(playingIdx);
    expect(ahmedIdx).toBeLessThan(wantsIdx);
    expect(omarIdx).toBeGreaterThan(wantsIdx);
    expect(omarIdx).toBeLessThan(cannotIdx);
    expect(aliIdx).toBeGreaterThan(cannotIdx);
    expect(content).toContain("Responded: 4");
  });

  it("omits a section entirely when no one has that status (matches plan section 16's example, which omits empty sections)", () => {
    const rows = [fakeAttendance({ status: "PLAYING" })];
    const { content } = buildRosterMessage(fakeMatch(), rows);
    expect(content).not.toContain("🔴 Can't play");
    expect(content).not.toContain("🟡 Want to, but can't");
  });

  it("shows CANCELLED prominently and removes the buttons entirely", () => {
    const rows = [fakeAttendance({ status: "PLAYING" })];
    const { content, components } = buildRosterMessage(fakeMatch({ status: "CANCELLED" }), rows);
    expect(content).toContain("CANCELLED");
    expect(components).toHaveLength(0);
    // History of who had responded is preserved even after cancellation.
    expect(content).toContain("Ahmed");
  });

  it("does not attach buttons for a SCHEDULED (not-yet-posted) match", () => {
    const { components } = buildRosterMessage(fakeMatch({ status: "SCHEDULED" }), []);
    expect(components).toHaveLength(0);
  });

  it("never includes a fabricated 'X/6' denominator or a named No Response section (no roster exists yet — see README)", () => {
    const { content } = buildRosterMessage(fakeMatch(), [fakeAttendance({ status: "PLAYING" })]);
    expect(content).not.toMatch(/\/\d+/); // no "N/M" style ratio anywhere
    expect(content).not.toMatch(/no response/i);
  });
});
