import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { sql } from "drizzle-orm";
import { createDatabase, type Database } from "../../src/database/client.js";
import { ServerConfigRepository } from "../../src/database/repositories/serverConfigRepository.js";
import { MatchRepository } from "../../src/database/repositories/matchRepository.js";
import { AttendanceRepository } from "../../src/database/repositories/attendanceRepository.js";

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("AttendanceRepository (integration)", () => {
  let db: Database;
  let pool: Pool;
  let attendanceRepo: AttendanceRepository;
  let matchRepo: MatchRepository;
  const guildId = `attendance-repo-guild-${Date.now()}`;
  let matchId: number;

  beforeAll(async () => {
    ({ db, pool } = createDatabase({ DATABASE_URL: databaseUrl! }));
    attendanceRepo = new AttendanceRepository(db);
    matchRepo = new MatchRepository(db);
    const configRepo = new ServerConfigRepository(db);
    await configRepo.upsert(guildId, { timezone: "Europe/Berlin" });
    const match = await matchRepo.create({
      guildId,
      opponent: "Team Attendance",
      scheduledAt: new Date("2026-11-01T18:00:00Z"),
      timezone: "Europe/Berlin",
    });
    matchId = match.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  it("creates a new attendance row on first response", async () => {
    const row = await attendanceRepo.upsert({
      guildId,
      matchId,
      discordUserId: "player-1",
      discordDisplayName: "Ahmed",
      status: "PLAYING",
    });
    expect(row.status).toBe("PLAYING");

    const all = await attendanceRepo.listByMatch(matchId);
    expect(all).toHaveLength(1);
  });

  it("updates the SAME row (not a new one) when the same player responds again — plan section 15 idempotency", async () => {
    await attendanceRepo.upsert({
      guildId,
      matchId,
      discordUserId: "player-1",
      discordDisplayName: "Ahmed",
      status: "CANNOT_PLAY",
    });

    const all = await attendanceRepo.listByMatch(matchId);
    expect(all).toHaveLength(1); // still just one row for player-1
    expect(all[0]!.status).toBe("CANNOT_PLAY");
  });

  it("updates the display name snapshot on re-response (e.g. nickname changed)", async () => {
    await attendanceRepo.upsert({
      guildId,
      matchId,
      discordUserId: "player-1",
      discordDisplayName: "Ahmed (renamed)",
      status: "PLAYING",
    });
    const row = await attendanceRepo.getForPlayer(matchId, "player-1");
    expect(row?.discordDisplayName).toBe("Ahmed (renamed)");
  });

  it("tracks multiple different players independently", async () => {
    await attendanceRepo.upsert({
      guildId,
      matchId,
      discordUserId: "player-2",
      discordDisplayName: "Marwan",
      status: "WANTS_TO_BUT_CANNOT",
    });
    const all = await attendanceRepo.listByMatch(matchId);
    expect(all).toHaveLength(2);
    expect(new Set(all.map((r) => r.discordUserId))).toEqual(new Set(["player-1", "player-2"]));
  });

  it("scopes attendance rows per match, not globally", async () => {
    const otherMatch = await matchRepo.create({
      guildId,
      opponent: "Team Other",
      scheduledAt: new Date("2026-11-02T18:00:00Z"),
      timezone: "Europe/Berlin",
    });
    await attendanceRepo.upsert({
      guildId,
      matchId: otherMatch.id,
      discordUserId: "player-1",
      discordDisplayName: "Ahmed",
      status: "PLAYING",
    });

    const forFirstMatch = await attendanceRepo.listByMatch(matchId);
    const forOtherMatch = await attendanceRepo.listByMatch(otherMatch.id);
    expect(forFirstMatch).toHaveLength(2);
    expect(forOtherMatch).toHaveLength(1);
  });

  it("cascades delete when a match is deleted (FK ON DELETE CASCADE)", async () => {
    const throwawayMatch = await matchRepo.create({
      guildId,
      opponent: "Team Throwaway",
      scheduledAt: new Date("2026-11-03T18:00:00Z"),
      timezone: "Europe/Berlin",
    });
    await attendanceRepo.upsert({
      guildId,
      matchId: throwawayMatch.id,
      discordUserId: "player-3",
      discordDisplayName: "Youssef",
      status: "PLAYING",
    });
    await db.execute(sql`DELETE FROM matches WHERE id = ${throwawayMatch.id}`);
    const remaining = await attendanceRepo.listByMatch(throwawayMatch.id);
    expect(remaining).toHaveLength(0);
  });
});
