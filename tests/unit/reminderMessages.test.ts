import { describe, expect, it } from "vitest";
import type { MatchRow } from "../../src/database/schema/matches.js";
import type { AttendanceRow } from "../../src/database/schema/attendance.js";
import { buildReminderNudgeMessage } from "../../src/modules/reminders/reminderMessages.js";

function makeMatch(overrides: Partial<MatchRow> = {}): MatchRow {
  return {
    id: 42,
    guildId: "guild-1",
    scheduledAt: new Date("2026-11-01T19:00:00Z"),
    timezone: "Africa/Cairo",
    status: "CONFIRMATION_OPEN",
    announcementChannelId: "channel-1",
    announcementMessageId: "msg-1",
    result: null,
    notes: null,
    completedAt: null,
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

/** EmbedBuilder has no public getters — read back via .toJSON() like the real send path does (discordRest.ts's serializeEmbeds). */
function json(embeds: ReturnType<typeof buildReminderNudgeMessage>["embeds"]) {
  return embeds[0]!.toJSON();
}

describe("buildReminderNudgeMessage (plan section 13/14, revised 2026-09-27 to an embed)", () => {
  it("returns exactly one embed, no content and no components (buttons stay solely on the roster message, plan section 16)", () => {
    const { embeds } = buildReminderNudgeMessage(makeMatch(), [], 180);
    expect(embeds).toHaveLength(1);
  });

  it("includes the match id and formatted offset in the title/description", () => {
    const e = json(buildReminderNudgeMessage(makeMatch(), [], 60).embeds);
    expect(e.title).toContain("1 hour");
    expect(e.description).toContain("Match #42");
  });

  it("renders the kickoff time as native Discord timestamp markdown, not a fixed-timezone string (a live-updating countdown in every viewer's own client)", () => {
    const match = makeMatch({ scheduledAt: new Date("2026-11-01T19:00:00Z") });
    const unix = Math.floor(match.scheduledAt.getTime() / 1000);
    const e = json(buildReminderNudgeMessage(match, [], 60).embeds);
    expect(e.description).toContain(`<t:${unix}:F>`);
    expect(e.description).toContain(`<t:${unix}:R>`);
  });

  it("tallies PLAYING separately from total responses, as inline fields", () => {
    const rows = [
      makeAttendance({ id: 1, discordUserId: "a", status: "PLAYING" }),
      makeAttendance({ id: 2, discordUserId: "b", status: "PLAYING" }),
      makeAttendance({ id: 3, discordUserId: "c", status: "WANTS_TO_BUT_CANNOT" }),
    ];
    const e = json(buildReminderNudgeMessage(makeMatch(), rows, 15).embeds);
    const byName = Object.fromEntries(e.fields!.map((f) => [f.name, f.value]));
    expect(byName["🟢 Confirmed playing"]).toBe("2");
    expect(byName["📋 Responded"]).toBe("3");
    expect(e.fields!.every((f) => f.inline)).toBe(true);
  });

  it("handles zero responses without a negative or NaN tally", () => {
    const e = json(buildReminderNudgeMessage(makeMatch(), [], 15).embeds);
    const byName = Object.fromEntries(e.fields!.map((f) => [f.name, f.value]));
    expect(byName["🟢 Confirmed playing"]).toBe("0");
    expect(byName["📋 Responded"]).toBe("0");
  });

  it("points the player back at the roster message's buttons in the footer", () => {
    const e = json(buildReminderNudgeMessage(makeMatch(), [], 180).embeds);
    expect(e.footer?.text).toMatch(/scroll up.*tap a button/i);
  });

  it.each([
    [20, 0xed4245], // imminent — red
    [15, 0xed4245],
    [59, 0xf5a623], // soon — amber
    [60, 0x5865f2], // far out — calm blurple, exactly at the boundary
    [180, 0x5865f2],
  ])("colors the embed by urgency: %i minutes out -> #%s", (offsetMinutes, color) => {
    const e = json(buildReminderNudgeMessage(makeMatch(), [], offsetMinutes).embeds);
    expect(e.color).toBe(color);
  });

  describe("with hype text (plan section 38, MATCH_HYPE)", () => {
    it("turns the same embed into the hype message: 🔥 title, AI text first, deterministic match line after", () => {
      const match = makeMatch();
      const unix = Math.floor(match.scheduledAt.getTime() / 1000);
      const e = json(buildReminderNudgeMessage(match, [], 15, "The squad is assembling. Jett is locked.").embeds);
      expect(e.title).toBe("🔥 15 MINUTES");
      expect(e.description).toBe(`The squad is assembling. Jett is locked.\n\nMatch #42 — <t:${unix}:F> (<t:${unix}:R>)`);
    });

    it("keeps the enhanced UI: colour, tallies and footer are unchanged", () => {
      const rows = [makeAttendance({ id: 1, status: "PLAYING" })];
      const e = json(buildReminderNudgeMessage(makeMatch(), rows, 15, "hype").embeds);
      expect(e.color).toBe(0xed4245);
      expect(e.fields!.map((f) => f.value)).toEqual(["1", "1"]);
      expect(e.footer?.text).toMatch(/scroll up.*tap a button/i);
    });

    it.each([[undefined], [null], [""], ["   "]])("falls back to the plain nudge for empty hype (%j)", (hype) => {
      const e = json(buildReminderNudgeMessage(makeMatch(), [], 15, hype as string | null | undefined).embeds);
      expect(e.title).toBe("⏰ 15 minutes until kickoff");
      expect(e.description).toMatch(/^Match #42/);
    });

    it("uses the hour label for hour-multiple offsets", () => {
      expect(json(buildReminderNudgeMessage(makeMatch(), [], 60, "hype").embeds).title).toBe("🔥 1 HOUR");
    });
  });
});
