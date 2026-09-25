import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { eq } from "drizzle-orm";
import type { Database } from "../../src/database/client.js";
import { createDatabase } from "../../src/database/client.js";
import { ServerConfigRepository } from "../../src/database/repositories/serverConfigRepository.js";
import { PlayerRepository } from "../../src/database/repositories/playerRepository.js";
import { MemoryRepository } from "../../src/database/repositories/memoryRepository.js";
import { memoryEvidence } from "../../src/database/schema/memoryEvidence.js";

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

const profile = {
  displayName: "Ahmed",
  role: "DUELIST" as const,
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
};

describeIfDb("MemoryRepository (integration)", () => {
  let db: Database;
  let pool: Pool;
  let memoriesRepo: MemoryRepository;
  let playerA: number;
  let playerB: number;
  const guildId = `memory-repo-guild-${Date.now()}`;

  beforeAll(async () => {
    ({ db, pool } = createDatabase({ DATABASE_URL: databaseUrl! }));
    memoriesRepo = new MemoryRepository(db);
    const players = new PlayerRepository(db);
    await new ServerConfigRepository(db).upsert(guildId, { timezone: "Europe/Berlin" });
    playerA = (await players.upsertByDiscordUserId(guildId, "user-a", profile)).player.id;
    playerB = (await players.upsertByDiscordUserId(guildId, "user-b", { ...profile, displayName: "Omar" })).player.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  it("create() writes the memory and its evidence in the same transaction (plan section 25)", async () => {
    const memory = await memoriesRepo.create({
      playerId: playerA,
      type: "MATCH_EVENT",
      content: "Ahmed had an exam that prevented him from playing.",
      evidence: [{ sourceType: "AI_CONVERSATION", sourceId: "42" }],
    });
    expect(memory.confidence).toBe(1); // default
    expect(memory.visibility).toBe("PRIVATE"); // default
    expect(memory.aiUsable).toBe(true); // default

    const evidence = await db.select().from(memoryEvidence).where(eq(memoryEvidence.memoryId, memory.id));
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ sourceType: "AI_CONVERSATION", sourceId: "42" });
  });

  it("getById returns the row; a nonexistent id returns undefined", async () => {
    const memory = await memoriesRepo.create({
      playerId: playerA,
      type: "HABIT",
      content: "Blames ping after dying.",
      evidence: [{ sourceType: "AI_CONVERSATION", sourceId: "1" }],
    });
    expect((await memoriesRepo.getById(memory.id))?.content).toBe("Blames ping after dying.");
    expect(await memoriesRepo.getById(999_999_999)).toBeUndefined();
  });

  it("listByPlayer scopes strictly to that player and returns newest first", async () => {
    await memoriesRepo.create({
      playerId: playerB,
      type: "RUNNING_JOKE",
      content: "Omar's own memory — must never show up for Ahmed.",
      evidence: [{ sourceType: "AI_CONVERSATION", sourceId: "7" }],
    });
    const third = await memoriesRepo.create({
      playerId: playerA,
      type: "TEAM_JOKE",
      content: "Third memory for Ahmed.",
      evidence: [{ sourceType: "AI_CONVERSATION", sourceId: "9" }],
    });

    const list = await memoriesRepo.listByPlayer(playerA);
    expect(list.every((m) => m.playerId === playerA)).toBe(true);
    expect(list[0]!.id).toBe(third.id); // newest first
    expect(list.map((m) => m.content)).not.toContain("Omar's own memory — must never show up for Ahmed.");
  });

  it("deleteForPlayer only deletes when the id belongs to that player (plan section 44 rule 4), and cascades to evidence", async () => {
    const memory = await memoriesRepo.create({
      playerId: playerB,
      type: "ACHIEVEMENT",
      content: "1v3 clutch last match.",
      evidence: [{ sourceType: "AI_CONVERSATION", sourceId: "11" }],
    });

    // Ahmed can't delete Omar's memory, even by guessing the right id.
    const wrongOwner = await memoriesRepo.deleteForPlayer(memory.id, playerA);
    expect(wrongOwner).toBe(false);
    expect(await memoriesRepo.getById(memory.id)).toBeDefined();

    const rightOwner = await memoriesRepo.deleteForPlayer(memory.id, playerB);
    expect(rightOwner).toBe(true);
    expect(await memoriesRepo.getById(memory.id)).toBeUndefined();
    expect(await db.select().from(memoryEvidence).where(eq(memoryEvidence.memoryId, memory.id))).toHaveLength(0);
  });

  it("deleteForPlayer on an id that doesn't exist at all returns false, not an error", async () => {
    expect(await memoriesRepo.deleteForPlayer(999_999_999, playerA)).toBe(false);
  });

  it("a memory can carry more than one piece of evidence", async () => {
    const memory = await memoriesRepo.create({
      playerId: playerA,
      type: "TEAM_HISTORY",
      content: "Mentioned twice, both times the same way.",
      evidence: [
        { sourceType: "AI_CONVERSATION", sourceId: "20" },
        { sourceType: "AI_CONVERSATION", sourceId: "21" },
      ],
    });
    expect(await db.select().from(memoryEvidence).where(eq(memoryEvidence.memoryId, memory.id))).toHaveLength(2);
  });
});
