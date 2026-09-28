import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { sql } from "drizzle-orm";
import { createDatabase, type Database } from "../../src/database/client.js";
import { ServerConfigRepository } from "../../src/database/repositories/serverConfigRepository.js";
import { MatchRepository } from "../../src/database/repositories/matchRepository.js";
import { PlayerRepository } from "../../src/database/repositories/playerRepository.js";
import { MatchEventRepository } from "../../src/database/repositories/matchEventRepository.js";

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("MatchEventRepository (integration, plan section 40)", () => {
  let db: Database;
  let pool: Pool;
  let matchEvents: MatchEventRepository;
  let matches: MatchRepository;
  let players: PlayerRepository;
  const guildId = `match-event-repo-guild-${Date.now()}`;
  let matchId: number;
  let playerId: number;

  beforeAll(async () => {
    ({ db, pool } = createDatabase({ DATABASE_URL: databaseUrl! }));
    matchEvents = new MatchEventRepository(db);
    matches = new MatchRepository(db);
    players = new PlayerRepository(db);

    await new ServerConfigRepository(db).upsert(guildId, { timezone: "Europe/Berlin" });
    const match = await matches.create({
      guildId,
      opponent: "Team Alpha",
      scheduledAt: new Date("2026-10-01T18:00:00Z"),
      timezone: "Europe/Berlin",
    });
    matchId = match.id;

    const { player } = await players.upsertByDiscordUserId(guildId, "user-1", {
      displayName: "Ahmed",
      role: "DUELIST",
      agents: ["Jett"],
      preferredAgent: "Jett",
      roastIntensity: 80,
      personalReferencesEnabled: true,
      runningJokesEnabled: true,
      valorantReferencesEnabled: true,
      matchHistoryReferencesEnabled: true,
      memoryUsageEnabled: true,
      aiFollowUpsEnabled: true,
      protectedTopics: [],
    });
    playerId = player.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  it("bulk-creates events for a match and reads them back in creation order", async () => {
    const created = await matchEvents.createMany([
      { matchId, playerId, type: "CLUTCH", description: "Won a 1v3." },
      { matchId, playerId: null, type: "TEAM_EVENT", description: "Slow start, strong finish." },
    ]);
    expect(created).toHaveLength(2);
    expect(created[0]!.matchId).toBe(matchId);
    expect(created[1]!.playerId).toBeNull();

    const listed = await matchEvents.listByMatch(matchId);
    expect(listed.map((e) => e.description)).toEqual(["Won a 1v3.", "Slow start, strong finish."]);
  });

  it("createMany([]) is a no-op, not an error", async () => {
    expect(await matchEvents.createMany([])).toEqual([]);
  });

  it("cascades on match deletion (onDelete: cascade)", async () => {
    const throwaway = await matches.create({
      guildId,
      opponent: "Throwaway Opponent",
      scheduledAt: new Date("2026-10-09T18:00:00Z"),
      timezone: "Europe/Berlin",
    });
    await matchEvents.createMany([{ matchId: throwaway.id, playerId: null, type: "TEAM_EVENT", description: "x" }]);
    expect(await matchEvents.listByMatch(throwaway.id)).toHaveLength(1);

    await db.execute(sql`DELETE FROM matches WHERE id = ${throwaway.id}`);
    expect(await matchEvents.listByMatch(throwaway.id)).toHaveLength(0);
  });

  it("detaches (not deletes) the event when the player is removed (onDelete: set null)", async () => {
    const { player: throwawayPlayer } = await players.upsertByDiscordUserId(guildId, "user-throwaway", {
      displayName: "Throwaway",
      role: "SENTINEL",
      agents: ["Cypher"],
      preferredAgent: "Cypher",
      roastIntensity: 50,
      personalReferencesEnabled: true,
      runningJokesEnabled: true,
      valorantReferencesEnabled: true,
      matchHistoryReferencesEnabled: true,
      memoryUsageEnabled: true,
      aiFollowUpsEnabled: true,
      protectedTopics: [],
    });
    const [event] = await matchEvents.createMany([
      { matchId, playerId: throwawayPlayer.id, type: "MVP", description: "Best round." },
    ]);

    await db.execute(sql`DELETE FROM players WHERE id = ${throwawayPlayer.id}`);

    const refreshed = (await matchEvents.listByMatch(matchId)).find((e) => e.id === event!.id);
    expect(refreshed).toBeDefined();
    expect(refreshed!.playerId).toBeNull();
    expect(refreshed!.description).toBe("Best round."); // the match's own history survives the roster change
  });

  it("refuses an insert for a match that doesn't exist (FK constraint)", async () => {
    const err: any = await matchEvents
      .createMany([{ matchId: 999_999_999, playerId: null, type: "TEAM_EVENT", description: "x" }])
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.cause?.code).toBe("23503");
  });
});
