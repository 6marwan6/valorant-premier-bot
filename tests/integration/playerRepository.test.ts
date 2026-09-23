import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { sql } from "drizzle-orm";
import type { Database } from "../../src/database/client.js";
import { createDatabase } from "../../src/database/client.js";
import { ServerConfigRepository } from "../../src/database/repositories/serverConfigRepository.js";
import { PlayerRepository } from "../../src/database/repositories/playerRepository.js";

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("PlayerRepository (integration)", () => {
  let db: Database;
  let pool: Pool;
  let players: PlayerRepository;
  const guildId = `player-repo-guild-${Date.now()}`;

  beforeAll(async () => {
    ({ db, pool } = createDatabase({ DATABASE_URL: databaseUrl! }));
    players = new PlayerRepository(db);
    await new ServerConfigRepository(db).upsert(guildId, { timezone: "Europe/Berlin" });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("creates a new player on first upsert", async () => {
    const { player, created } = await players.upsertByDiscordUserId(guildId, "user-1", {
      displayName: "Ahmed",
      role: "DUELIST",
      agents: ["Jett", "Raze"],
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
    expect(created).toBe(true);
    expect(player.role).toBe("DUELIST");
    expect(player.agents).toEqual(["Jett", "Raze"]);
    expect(player.active).toBe(true);
  });

  it("getByDiscordUserId returns the row scoped to the correct guild", async () => {
    const found = await players.getByDiscordUserId(guildId, "user-1");
    expect(found?.displayName).toBe("Ahmed");
    const notFound = await players.getByDiscordUserId(`${guildId}-other`, "user-1");
    expect(notFound).toBeUndefined();
  });

  it("update() only changes the fields explicitly passed", async () => {
    const updated = await players.update(guildId, "user-1", { roastIntensity: 40 });
    expect(updated?.roastIntensity).toBe(40);
    // Untouched fields survive the partial update.
    expect(updated?.role).toBe("DUELIST");
    expect(updated?.agents).toEqual(["Jett", "Raze"]);
  });

  it("deactivate() soft-deletes and is excluded from the active roster; a second call is a no-op", async () => {
    await players.upsertByDiscordUserId(guildId, "user-2", {
      displayName: "Omar",
      role: "CONTROLLER",
      agents: ["Omen"],
      preferredAgent: "Omen",
      roastIntensity: 30,
      personalReferencesEnabled: true,
      runningJokesEnabled: true,
      valorantReferencesEnabled: true,
      matchHistoryReferencesEnabled: true,
      memoryUsageEnabled: true,
      aiFollowUpsEnabled: true,
      protectedTopics: ["Family"],
    });

    const removed = await players.deactivate(guildId, "user-2");
    expect(removed?.active).toBe(false);

    const secondAttempt = await players.deactivate(guildId, "user-2");
    expect(secondAttempt).toBeUndefined(); // idempotent — plan section 50

    const roster = await players.listActiveByGuild(guildId);
    expect(roster.map((p) => p.discordUserId)).not.toContain("user-2");
  });

  it("re-adding a removed player via upsertByDiscordUserId reactivates the same row instead of duplicating it", async () => {
    const { player, created } = await players.upsertByDiscordUserId(guildId, "user-2", {
      displayName: "Omar",
      role: "CONTROLLER",
      agents: ["Omen", "Viper"],
      preferredAgent: "Viper",
      roastIntensity: 35,
      personalReferencesEnabled: true,
      runningJokesEnabled: true,
      valorantReferencesEnabled: true,
      matchHistoryReferencesEnabled: true,
      memoryUsageEnabled: true,
      aiFollowUpsEnabled: true,
      protectedTopics: ["Family"],
    });
    expect(created).toBe(false);
    expect(player.active).toBe(true);
    expect(player.agents).toEqual(["Omen", "Viper"]);

    const roster = await players.listActiveByGuild(guildId);
    expect(roster.map((p) => p.discordUserId).sort()).toEqual(["user-1", "user-2"]);
  });

  it("enforces one profile per (guild, discord user) via the unique index", async () => {
    const result = await db.execute(
      sql`select count(*)::int as count from players where guild_id = ${guildId} and discord_user_id = 'user-1'`,
    );
    // Only ever one row for user-1 across every upsert/update above.
    expect((result.rows[0] as { count: number }).count).toBe(1);
  });
});
