import { describe, expect, it } from "vitest";
import { visibleText } from "./helpers/embedText.js";
import { buildRosterMessage } from "../../src/modules/attendance/rosterMessage.js";
import type { MatchRow } from "../../src/database/schema/matches.js";
import type { AttendanceRow } from "../../src/database/schema/attendance.js";

function fakeMatch(overrides: Partial<MatchRow> = {}): MatchRow {
  return {
    id: 42,
    guildId: "guild-1",
    scheduledAt: new Date("2026-09-18T17:00:00Z"),
    timezone: "Europe/Berlin",
    status: "CONFIRMATION_OPEN",
    announcementChannelId: null,
    announcementMessageId: null,
    result: null,
    notes: null,
    completedAt: null,
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

function embedOf(message: ReturnType<typeof buildRosterMessage>) {
  return message.embeds[0]!.toJSON();
}

describe("buildRosterMessage", () => {
  it("shows the plan section 14 header fields and 'no one yet' with zero responses", () => {
    const message = buildRosterMessage(fakeMatch(), []);
    const text = visibleText(message);
    expect(message.content).toContain("PREMIER MATCH");
    expect(text).toContain("No one has responded yet.");
    expect(text).not.toContain("undefined");
    expect(message.embeds).toHaveLength(1);
    expect(message.components).toHaveLength(1);
  });

  it("shows the kickoff in the team's timezone plus live Discord timestamps, all built by the app", () => {
    const e = embedOf(buildRosterMessage(fakeMatch(), []));
    const at = Math.floor(new Date("2026-09-18T17:00:00Z").getTime() / 1000);
    expect(e.title).toBe("📅 Friday 18 September, 7:00 PM"); // Europe/Berlin
    expect(e.description).toContain(`<t:${at}:R>`);
    expect(e.description).toContain(`<t:${at}:t>`);
    expect(e.footer?.text).toContain("Match #42");
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

  it("groups respondents into counted sections, in the plan section 16 order", () => {
    const rows = [
      fakeAttendance({ discordUserId: "u1", discordDisplayName: "Ahmed", status: "PLAYING" }),
      fakeAttendance({ id: 2, discordUserId: "u2", discordDisplayName: "Marwan", status: "PLAYING" }),
      fakeAttendance({ id: 3, discordUserId: "u3", discordDisplayName: "Omar", status: "WANTS_TO_BUT_CANNOT" }),
      fakeAttendance({ id: 4, discordUserId: "u4", discordDisplayName: "Ali", status: "CANNOT_PLAY" }),
    ];
    const e = embedOf(buildRosterMessage(fakeMatch(), rows));
    const fields = (e.fields ?? []).filter((f) => f.name !== "⚡ Latest activity");

    expect(fields.map((f) => f.name)).toEqual(["🟢 Playing · 2", "🟡 Want to, but can't · 1", "🔴 Can't play · 1"]);
    expect(fields[0]!.value).toContain("Ahmed");
    expect(fields[0]!.value).toContain("Marwan");
    expect(fields[1]!.value).toContain("Omar");
    expect(fields[2]!.value).toContain("Ali");
    expect(e.description).toContain("Responded: 4");
  });

  it("omits a section entirely when no one has that status (matches plan section 16's example, which omits empty sections)", () => {
    const text = visibleText(buildRosterMessage(fakeMatch(), [fakeAttendance({ status: "PLAYING" })]));
    expect(text).not.toContain("🔴 Can't play");
    expect(text).not.toContain("🟡 Want to, but can't");
  });

  it("shows CANCELLED prominently and removes the buttons entirely", () => {
    const rows = [fakeAttendance({ status: "PLAYING" })];
    const message = buildRosterMessage(fakeMatch({ status: "CANCELLED" }), rows);
    expect(message.content).toContain("CANCELLED");
    expect(embedOf(message).color).toBe(0x4f545c);
    expect(message.components).toHaveLength(0);
    // History of who had responded is preserved even after cancellation.
    expect(visibleText(message)).toContain("Ahmed");
    // A cancelled match has no countdown and no squad bar.
    expect(visibleText(message)).not.toContain("Kickoff <t:");
    expect(visibleText(message)).not.toMatch(/Confirmed:|Responded:/);
  });

  it("does not attach buttons for a SCHEDULED (not-yet-posted) match", () => {
    const { components } = buildRosterMessage(fakeMatch({ status: "SCHEDULED" }), []);
    expect(components).toHaveLength(0);
  });

  it("without a roster (pre-Phase-5 callers, or a guild with no players yet), falls back to 'Responded: N' with no fabricated denominator or bar", () => {
    const text = visibleText(buildRosterMessage(fakeMatch(), [fakeAttendance({ status: "PLAYING" })]));
    expect(text).not.toMatch(/Confirmed:/);
    expect(text).not.toMatch(/no response/i);
    expect(text).not.toContain("⬛");
    expect(text).toContain("Responded: 1");
  });

  it("with a roster, shows a real 'No response' section, a Confirmed: X/Y denominator and a squad bar (plan section 16, Phase 5)", () => {
    const roster = [
      { discordUserId: "u1", displayName: "Ahmed" },
      { discordUserId: "u2", displayName: "Omar" },
      { discordUserId: "u3", displayName: "Hassan" },
    ];
    const rows = [
      fakeAttendance({ discordUserId: "u1", discordDisplayName: "Ahmed", status: "PLAYING" }),
      fakeAttendance({ id: 2, discordUserId: "u2", discordDisplayName: "Omar", status: "WANTS_TO_BUT_CANNOT" }),
    ];
    const message = buildRosterMessage(fakeMatch(), rows, roster);
    const e = embedOf(message);

    expect(e.fields?.map((f) => f.name)).toContain("⚪ No response · 1");
    expect(visibleText(message)).toContain("Hassan");
    expect(e.description).toContain("Confirmed: 1/3");
    expect(e.description).toContain("🟩🟨⬛");
    expect(visibleText(message)).not.toContain("Responded:");
  });

  it("with a roster and zero responses, lists every active player under No response instead of the generic placeholder", () => {
    const roster = [
      { discordUserId: "u1", displayName: "Ahmed" },
      { discordUserId: "u2", displayName: "Omar" },
    ];
    const message = buildRosterMessage(fakeMatch(), [], roster);
    const text = visibleText(message);

    expect(text).not.toContain("No one has responded yet.");
    expect(text).toContain("⚪ No response · 2");
    expect(text).toContain("Ahmed");
    expect(text).toContain("Omar");
    expect(embedOf(message).description).toContain("Confirmed: 0/2");
    expect(embedOf(message).description).toContain("⬛⬛");
    expect(embedOf(message).fields?.map((f) => f.name)).not.toContain("⚡ Latest activity"); // nothing to report yet
  });

  it("omits the No response section once everyone on the roster has answered", () => {
    const roster = [{ discordUserId: "u1", displayName: "Ahmed" }];
    const rows = [fakeAttendance({ discordUserId: "u1", discordDisplayName: "Ahmed", status: "CANNOT_PLAY" })];
    const text = visibleText(buildRosterMessage(fakeMatch(), rows, roster));

    expect(text).not.toContain("No response");
    expect(text).toContain("Confirmed: 0/1");
  });

  it("turns green and announces the full squad only when every active player is PLAYING", () => {
    const roster = [
      { discordUserId: "u1", displayName: "Ahmed" },
      { discordUserId: "u2", displayName: "Omar" },
    ];
    const playing = (id: number, user: string, name: string) => fakeAttendance({ id, discordUserId: user, discordDisplayName: name, status: "PLAYING" });

    const full = buildRosterMessage(fakeMatch(), [playing(1, "u1", "Ahmed"), playing(2, "u2", "Omar")], roster);
    expect(embedOf(full).color).toBe(0x3bd671);
    expect(embedOf(full).description).toContain("FULL SQUAD LOCKED IN");

    const partial = buildRosterMessage(fakeMatch(), [playing(1, "u1", "Ahmed")], roster);
    expect(embedOf(partial).color).toBe(0xff4655);
    expect(embedOf(partial).description).not.toContain("FULL SQUAD");
  });

  it("decorates people with role glyph and preferred agent from the player profile", () => {
    const roster = [{ discordUserId: "u1", displayName: "Ahmed", role: "DUELIST" as const, preferredAgent: "Jett" }];
    const rows = [fakeAttendance({ discordUserId: "u1", discordDisplayName: "Ahmed", status: "PLAYING" })];
    const playing = embedOf(buildRosterMessage(fakeMatch(), rows, roster)).fields!.find((f) => f.name.startsWith("🟢 Playing"))!;
    expect(playing.value).toBe("⚔️ **Ahmed** · Jett");
  });

  it("shows the latest three responses, newest first, with relative timestamps", () => {
    const base = new Date("2026-09-18T12:00:00Z").getTime();
    const rows = ["A", "B", "C", "D"].map((name, i) =>
      fakeAttendance({ id: i + 1, discordUserId: `u${i}`, discordDisplayName: name, status: "PLAYING", respondedAt: new Date(base + i * 60_000) }),
    );
    const feed = embedOf(buildRosterMessage(fakeMatch(), rows)).fields!.find((f) => f.name === "⚡ Latest activity")!;
    const lines = feed.value.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("**D**");
    expect(lines[2]).toContain("**B**");
    expect(feed.value).not.toContain("**A**");
    expect(feed.value).toMatch(/<t:\d+:R>/);
  });

  it("escapes markdown in display names and stays inside Discord's embed limits for a big roster", () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      fakeAttendance({ id: i + 1, discordUserId: `u${i}`, discordDisplayName: `**x${i}**_`.padEnd(30, "z"), status: "PLAYING" }),
    );
    const e = embedOf(buildRosterMessage(fakeMatch(), rows));
    expect(e.fields!.every((f) => f.value.length <= 1024)).toBe(true);
    expect(e.fields!.find((f) => f.name.startsWith("🟢"))!.value).toContain("\\*\\*x0");
    expect(e.fields!.length).toBeLessThanOrEqual(25);
  });

  it("does not draw a squad bar for an implausibly large roster (count only)", () => {
    const roster = Array.from({ length: 20 }, (_, i) => ({ discordUserId: `u${i}`, displayName: `P${i}` }));
    const e = embedOf(buildRosterMessage(fakeMatch(), [], roster));
    expect(e.description).toContain("Confirmed: 0/20");
    expect(e.description).not.toContain("⬛");
  });
});
