import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { eq } from "drizzle-orm";
import { createDatabase, type Database } from "../../src/database/client.js";
import { ServerConfigRepository } from "../../src/database/repositories/serverConfigRepository.js";
import { serverConfig } from "../../src/database/schema/serverConfig.js";
import { isValidTimeZone } from "../../src/discord/timezone.js";

/**
 * Runs the ServerConfigRepository against a *real* Postgres instance rather
 * than a mock — plan section 60 calls for integration tests, not just unit
 * tests, and the repository layer is exactly where an ORM/SQL mismatch
 * would hide from a pure unit test.
 *
 * Requires DATABASE_URL to point at a disposable database (migrations are
 * expected to already be applied — see README "Running tests"). Skips
 * itself with a clear message if DATABASE_URL isn't set, so `npm test`
 * (unit only) stays fast and infra-free by default.
 */
const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("ServerConfigRepository (integration)", () => {
  let db: Database;
  let pool: Pool;
  let repo: ServerConfigRepository;

  const guildId = `test-guild-${Date.now()}`;

  beforeAll(() => {
    ({ db, pool } = createDatabase({ DATABASE_URL: databaseUrl! }));
    repo = new ServerConfigRepository(db);
  });

  afterAll(async () => {
    await db.delete(serverConfig).where(eq(serverConfig.guildId, guildId));
    await pool.end();
  });

  it("returns undefined for a guild that has never run /setup", async () => {
    const result = await repo.getByGuildId(guildId);
    expect(result).toBeUndefined();
  });

  it("creates a config row on first upsert, applying schema defaults for omitted fields", async () => {
    const created = await repo.upsert(guildId, { matchChannelId: "channel-1" });

    expect(created.guildId).toBe(guildId);
    expect(created.matchChannelId).toBe("channel-1");
    // Defaults from the schema (plan section 3 / 53), not passed explicitly.
    expect(created.timezone).toBe("Africa/Cairo");
    expect(created.reminderScheduleMinutes).toEqual([180, 60, 15]);
    expect(created.defaultRoastIntensity).toBe(50);
    expect(created.adminRoleId).toBeNull();
  });

  it("updates only the fields passed on a second /setup run, leaving the rest untouched", async () => {
    const before = await repo.getByGuildId(guildId);
    expect(before).toBeDefined();

    const updated = await repo.upsert(guildId, { adminRoleId: "role-42" });

    expect(updated.adminRoleId).toBe("role-42");
    // Unrelated field from the first upsert must survive untouched.
    expect(updated.matchChannelId).toBe("channel-1");
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(before!.updatedAt.getTime());
  });

  it("rejects an invalid timezone the way /setup would reject it before ever reaching the DB", () => {
    // The repository itself is permissive (it's a thin data layer); the
    // isValidTimeZone() guard lives in the command handler. This test just
    // documents that boundary so a future refactor doesn't accidentally
    // move validation into the repository and duplicate it.
    expect(isValidTimeZone("Europe/Frankfurt")).toBe(false);
  });
});
