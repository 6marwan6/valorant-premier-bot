import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createDatabase, type Database } from "../../src/database/client.js";
import { VoiceJoinRepository } from "../../src/database/repositories/voiceJoinRepository.js";

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("VoiceJoinRepository (integration)", () => {
  let db: Database;
  let pool: Pool;
  let repo: VoiceJoinRepository;
  // One guild per test keeps the partial unique index (one PENDING per guild) from coupling the tests together.
  let n = 0;
  const guild = () => `voice-join-guild-${Date.now()}-${++n}`;
  const minutes = (m: number) => new Date(Date.now() + m * 60_000);

  beforeAll(() => {
    ({ db, pool } = createDatabase({ DATABASE_URL: databaseUrl! }));
    repo = new VoiceJoinRepository(db);
  });
  afterAll(async () => {
    await pool.end();
  });

  it("stores a PENDING request", async () => {
    const g = guild();
    const { request, replaced } = await repo.schedule({ guildId: g, channelId: "c1", joinAt: minutes(10), requestedBy: "admin" });
    expect(request.status).toBe("PENDING");
    expect(replaced).toBeNull();
    expect((await repo.getPending(g))?.id).toBe(request.id);
  });

  it("a newer request replaces the pending one (only one PENDING per guild)", async () => {
    const g = guild();
    const first = await repo.schedule({ guildId: g, channelId: "c1", joinAt: minutes(10), requestedBy: "admin" });
    const second = await repo.schedule({ guildId: g, channelId: "c2", joinAt: minutes(20), requestedBy: "admin" });
    expect(second.replaced?.id).toBe(first.request.id);
    expect((await repo.getPending(g))?.channelId).toBe("c2");
    expect(await repo.claim(first.request.id)).toBe(false); // the cancelled one can't be claimed
  });

  it("listDue returns only requests whose time has come", async () => {
    const g = guild();
    await repo.schedule({ guildId: g, channelId: "c1", joinAt: minutes(30), requestedBy: "admin" });
    expect(await repo.listDue(g, new Date())).toHaveLength(0);
    expect(await repo.listDue(g, minutes(31))).toHaveLength(1);
  });

  it("claim is atomic: only one of two racing ticks wins (plan section 50)", async () => {
    const g = guild();
    const { request } = await repo.schedule({ guildId: g, channelId: "c1", joinAt: minutes(-1), requestedBy: "admin" });
    const results = await Promise.all([repo.claim(request.id), repo.claim(request.id), repo.claim(request.id)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await repo.listDue(g, new Date())).toHaveLength(0); // CLAIMED is no longer due
  });

  it("finish moves CLAIMED -> DONE/FAILED and PENDING -> EXPIRED, and never rewrites a finished row", async () => {
    const g = guild();
    const a = await repo.schedule({ guildId: g, channelId: "c1", joinAt: minutes(-1), requestedBy: "admin" });
    await repo.claim(a.request.id);
    await repo.finish(a.request.id, "DONE");
    await repo.finish(a.request.id, "FAILED"); // too late: must stay DONE
    const done = await pool.query("select status, handled_at from voice_join_requests where id = $1", [a.request.id]);
    expect(done.rows[0].status).toBe("DONE");
    expect(done.rows[0].handled_at).not.toBeNull();

    const b = await repo.schedule({ guildId: g, channelId: "c2", joinAt: minutes(-60), requestedBy: "admin" });
    await repo.finish(b.request.id, "EXPIRED");
    const expired = await pool.query("select status from voice_join_requests where id = $1", [b.request.id]);
    expect(expired.rows[0].status).toBe("EXPIRED");
    expect(await repo.getPending(g)).toBeUndefined();
  });

  it("after one finishes, a new request can be scheduled for the same guild", async () => {
    const g = guild();
    const a = await repo.schedule({ guildId: g, channelId: "c1", joinAt: minutes(-1), requestedBy: "admin" });
    await repo.claim(a.request.id);
    await repo.finish(a.request.id, "DONE");
    const b = await repo.schedule({ guildId: g, channelId: "c1", joinAt: minutes(5), requestedBy: "admin" });
    expect(b.replaced).toBeNull(); // nothing pending to replace
    expect((await repo.getPending(g))?.id).toBe(b.request.id);
  });
});
