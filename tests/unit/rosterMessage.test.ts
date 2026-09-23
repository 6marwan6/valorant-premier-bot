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

  it("without a roster (pre-Phase-5 callers, or a guild with no players yet), falls back to 'Responded: N' with no fabricated denominator", () => {
    const { content } = buildRosterMessage(fakeMatch(), [fakeAttendance({ status: "PLAYING" })]);
    expect(content).not.toMatch(/\/\d+/); // no "N/M" style ratio anywhere
    expect(content).not.toMatch(/no response/i);
    expect(content).toContain("Responded: 1");
  });

  it("with a roster, shows a real 'No response' section and a Confirmed: X/Y denominator (plan section 16, Phase 5)", () => {
    const roster = [
      { discordUserId: "u1", displayName: "Ahmed" },
      { discordUserId: "u2", displayName: "Omar" },
      { discordUserId: "u3", displayName: "Hassan" },
    ];
    const rows = [
      fakeAttendance({ discordUserId: "u1", discordDisplayName: "Ahmed", status: "PLAYING" }),
      fakeAttendance({ id: 2, discordUserId: "u2", discordDisplayName: "Omar", status: "WANTS_TO_BUT_CANNOT" }),
    ];
    const { content } = buildRosterMessage(fakeMatch(), rows, roster);

    expect(content).toContain("⚪ No response");
    expect(content).toContain("Hassan");
    expect(content).toContain("Confirmed: 1/3");
    expect(content).not.toContain("Responded:");
  });

  it("with a roster and zero responses, lists every active player under No response instead of the generic placeholder", () => {
    const roster = [
      { discordUserId: "u1", displayName: "Ahmed" },
      { discordUserId: "u2", displayName: "Omar" },
    ];
    const { content } = buildRosterMessage(fakeMatch(), [], roster);

    expect(content).not.toContain("No one has responded yet.");
    expect(content).toContain("⚪ No response");
    expect(content).toContain("Ahmed");
    expect(content).toContain("Omar");
    expect(content).toContain("Confirmed: 0/2");
  });

  it("omits the No response section once everyone on the roster has answered", () => {
    const roster = [{ discordUserId: "u1", displayName: "Ahmed" }];
    const rows = [fakeAttendance({ discordUserId: "u1", discordDisplayName: "Ahmed", status: "PLAYING" })];
    const { content } = buildRosterMessage(fakeMatch(), rows, roster);

    expect(content).not.toContain("No response");
    expect(content).toContain("Confirmed: 1/1");
  });
});
