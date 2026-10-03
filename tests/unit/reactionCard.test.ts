import { describe, expect, it } from "vitest";
import { buildFullSquadCard, buildReactionCard, squadBar } from "../../src/modules/attendance/reactionCard.js";
import { makeMatch, makePlayer } from "./helpers/aiFixtures.js";
import type { AttendanceRow } from "../../src/database/schema/attendance.js";

function row(id: number, status: AttendanceRow["status"]): AttendanceRow {
  return {
    id,
    guildId: "guild-1",
    matchId: 42,
    discordUserId: `u${id}`,
    discordDisplayName: `P${id}`,
    status,
    respondedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("squadBar", () => {
  it("draws one square per roster player: greens, yellows, reds, then undecided", () => {
    expect(squadBar([row(1, "CANNOT_PLAY"), row(2, "PLAYING"), row(3, "WANTS_TO_BUT_CANNOT")], 5)).toBe("🟩🟨🟥⬛⬛");
  });

  it("never grows past the roster size", () => {
    expect(squadBar([row(1, "PLAYING"), row(2, "PLAYING"), row(3, "PLAYING")], 2)).toBe("🟩🟩");
  });
});

describe("buildReactionCard", () => {
  const base = { match: makeMatch(), attendanceRows: [row(1, "PLAYING")], rosterSize: 6, text: "LET'S GOOO" };

  it.each([
    ["PLAYING", 0x3bd671, "LOCKED IN"],
    ["CANNOT_PLAY", 0xff4655, "MAN DOWN"],
    ["WANTS_TO_BUT_CANNOT", 0xf5a623, "BENCHED BY LIFE"],
  ] as const)("%s gets its own color and headline", (status, color, headline) => {
    const e = buildReactionCard({ ...base, player: makePlayer({ displayName: "Ahmed" }), status }).embeds[0]!.toJSON();
    expect(e.color).toBe(color);
    expect(e.title).toContain(headline);
    expect(e.description).toBe("LET'S GOOO");
    expect(e.author?.name).toBe("Ahmed");
  });

  it("adds role, agent and the squad tally from the database, never from the text", () => {
    const player = makePlayer({ role: "DUELIST", preferredAgent: "Jett" });
    const e = buildReactionCard({ ...base, player, status: "PLAYING" }).embeds[0]!.toJSON();
    const byName = Object.fromEntries((e.fields ?? []).map((f) => [f.name, f.value]));
    expect(byName.Role).toContain("Duelist");
    expect(byName.Agent).toBe("Jett");
    expect(byName.Squad).toContain("🟩⬛⬛⬛⬛⬛");
    expect(byName.Squad).toContain("1/6");
    expect(e.footer?.text).toBe("Match #42");
  });

  it("skips the squad field without a roster and the thumbnail without an avatar", () => {
    const e = buildReactionCard({ ...base, rosterSize: 0, player: { discordUserId: "u1", displayName: "Ahmed" }, status: "PLAYING" }).embeds[0]!.toJSON();
    expect(e.fields ?? []).toHaveLength(0);
    expect(e.thumbnail).toBeUndefined();
  });

  it("uses the avatar for the thumbnail when given", () => {
    const e = buildReactionCard({ ...base, player: makePlayer(), status: "PLAYING", avatarUrl: "https://cdn.discordapp.com/avatars/1/a.png" }).embeds[0]!.toJSON();
    expect(e.thumbnail?.url).toContain("cdn.discordapp.com");
  });

  it("keeps long model text inside Discord's description limit", () => {
    const e = buildReactionCard({ ...base, player: makePlayer(), status: "PLAYING", text: "x".repeat(6000) }).embeds[0]!.toJSON();
    expect(e.description!.length).toBeLessThanOrEqual(4096);
  });
});

describe("buildFullSquadCard", () => {
  it("lists the lineup and the kickoff countdown, deterministically", () => {
    const lineup = [makePlayer({ displayName: "Ahmed", role: "DUELIST", preferredAgent: "Jett" }), { discordUserId: "u2", displayName: "Omar" }];
    const e = buildFullSquadCard(makeMatch(), lineup, 1_790_000_000).embeds[0]!.toJSON();
    expect(e.title).toContain("FULL SQUAD");
    expect(e.description).toContain("🟩🟩  **2/2**");
    expect(e.description).toContain("⚔️ **Ahmed** · Jett");
    expect(e.description).toContain("**Omar**");
    expect(e.description).toContain("<t:1790000000:R>");
  });
});
