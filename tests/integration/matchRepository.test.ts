import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createDatabase, type Database } from "../../src/database/client.js";
import { ServerConfigRepository } from "../../src/database/repositories/serverConfigRepository.js";
import { MatchRepository } from "../../src/database/repositories/matchRepository.js";

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("MatchRepository (integration)", () => {
  let db: Database;
  let pool: Pool;
  let matchRepo: MatchRepository;
  let configRepo: ServerConfigRepository;
  const guildId = `match-repo-guild-${Date.now()}`;

  beforeAll(async () => {
    ({ db, pool } = createDatabase({ DATABASE_URL: databaseUrl! }));
    matchRepo = new MatchRepository(db);
    configRepo = new ServerConfigRepository(db);
    // matches.guild_id has a FK to server_config.guild_id — a config row
    // must exist first, same as it would after a real /setup.
    await configRepo.upsert(guildId, { timezone: "Europe/Berlin" });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("creates a match and reads it back", async () => {
    const created = await matchRepo.create({
      guildId,
      opponent: "Team Alpha",
      scheduledAt: new Date("2026-10-01T18:00:00Z"),
      timezone: "Europe/Berlin",
    });
    expect(created.id).toBeGreaterThan(0);
    expect(created.status).toBe("SCHEDULED");

    const fetched = await matchRepo.getById(created.id);
    expect(fetched?.opponent).toBe("Team Alpha");
  });

  it("finds an active duplicate but not a cancelled one (plan section 11)", async () => {
    const scheduledAt = new Date("2026-10-02T18:00:00Z");
    const first = await matchRepo.create({
      guildId,
      opponent: "Team Beta",
      scheduledAt,
      timezone: "Europe/Berlin",
    });

    const duplicate = await matchRepo.findActiveDuplicate(guildId, "Team Beta", scheduledAt);
    expect(duplicate?.id).toBe(first.id);

    await matchRepo.update(first.id, { status: "CANCELLED" });
    const noLongerDuplicate = await matchRepo.findActiveDuplicate(guildId, "Team Beta", scheduledAt);
    expect(noLongerDuplicate).toBeUndefined();
  });

  it("the database itself rejects a true duplicate insert (partial unique index)", async () => {
    const scheduledAt = new Date("2026-10-03T18:00:00Z");
    await matchRepo.create({ guildId, opponent: "Team Gamma", scheduledAt, timezone: "Europe/Berlin" });

    // drizzle-orm 0.45.x wraps the driver error: the top-level message is a
    // generic "Failed query: ..."; the actual Postgres error (code 23505,
    // "duplicate key value violates unique constraint ...") is on `.cause`.
    const err: any = await matchRepo
      .create({ guildId, opponent: "Team Gamma", scheduledAt, timezone: "Europe/Berlin" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.cause?.code).toBe("23505");
    expect(err.cause?.message).toMatch(/duplicate key value violates unique constraint/);
  });

  it("lists matches for a guild soonest-first", async () => {
    const list = await matchRepo.listByGuild(guildId);
    const times = list.map((m) => m.scheduledAt.getTime());
    const sorted = [...times].sort((a, b) => a - b);
    expect(times).toEqual(sorted);
    expect(list.every((m) => m.guildId === guildId)).toBe(true);
  });

  it("updates only the fields passed", async () => {
    const created = await matchRepo.create({
      guildId,
      opponent: "Team Delta",
      scheduledAt: new Date("2026-10-04T18:00:00Z"),
      timezone: "Europe/Berlin",
    });
    const updated = await matchRepo.update(created.id, { opponent: "Team Delta FC" });
    expect(updated?.opponent).toBe("Team Delta FC");
    expect(updated?.status).toBe("SCHEDULED");
    expect(updated?.scheduledAt.getTime()).toBe(created.scheduledAt.getTime());
  });

  it("refuses to insert a match for a guild with no server_config row (FK constraint)", async () => {
    const err: any = await matchRepo
      .create({
        guildId: "guild-that-never-ran-setup",
        opponent: "Team Epsilon",
        scheduledAt: new Date("2026-10-05T18:00:00Z"),
        timezone: "Europe/Berlin",
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.cause?.code).toBe("23503");
    expect(err.cause?.message).toMatch(/violates foreign key constraint/);
  });
});
