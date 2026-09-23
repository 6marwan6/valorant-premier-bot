import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createDatabase, type Database } from "../../src/database/client.js";
import { ServerConfigRepository } from "../../src/database/repositories/serverConfigRepository.js";
import { MatchRepository } from "../../src/database/repositories/matchRepository.js";
import { ReminderRepository } from "../../src/database/repositories/reminderRepository.js";
import { planReminders } from "../../src/modules/reminders/reminderScheduling.js";

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("ReminderRepository (integration)", () => {
  let db: Database;
  let pool: Pool;
  let reminderRepo: ReminderRepository;
  let matchRepo: MatchRepository;
  const guildId = `reminder-repo-guild-${Date.now()}`;

  beforeAll(async () => {
    ({ db, pool } = createDatabase({ DATABASE_URL: databaseUrl! }));
    reminderRepo = new ReminderRepository(db);
    matchRepo = new MatchRepository(db);
    const configRepo = new ServerConfigRepository(db);
    await configRepo.upsert(guildId, { timezone: "Africa/Cairo" });
  });

  afterAll(async () => {
    await pool.end();
  });

  async function makeMatch(opponent: string, scheduledAt: Date) {
    return matchRepo.create({ guildId, opponent, scheduledAt, timezone: "Africa/Cairo" });
  }

  it("reconcileMatch creates one row per configured offset (plan section 13)", async () => {
    const match = await makeMatch("Team Reconcile", new Date("2026-11-05T19:00:00Z"));
    await reminderRepo.reconcileMatch(match.id, planReminders(match.scheduledAt, [180, 60, 15]));

    const rows = await reminderRepo.listByMatch(match.id);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === "PENDING")).toBe(true);
    expect(new Set(rows.map((r) => r.offsetMinutes))).toEqual(new Set([180, 60, 15]));
  });

  it("reconcileMatch is idempotent — re-running with the same plan does not duplicate rows (plan section 50)", async () => {
    const match = await makeMatch("Team Idempotent", new Date("2026-11-06T19:00:00Z"));
    const plan = planReminders(match.scheduledAt, [180, 60, 15]);
    await reminderRepo.reconcileMatch(match.id, plan);
    await reminderRepo.reconcileMatch(match.id, plan);
    await reminderRepo.reconcileMatch(match.id, plan);

    const rows = await reminderRepo.listByMatch(match.id);
    expect(rows).toHaveLength(3);
  });

  it("reconcileMatch refreshes scheduled_at for a still-PENDING row when the match is edited", async () => {
    const match = await makeMatch("Team Edited", new Date("2026-11-07T19:00:00Z"));
    await reminderRepo.reconcileMatch(match.id, planReminders(match.scheduledAt, [60]));
    const before = (await reminderRepo.listByMatch(match.id))[0]!;

    const newKickoff = new Date("2026-11-07T20:30:00Z");
    await reminderRepo.reconcileMatch(match.id, planReminders(newKickoff, [60]));
    const after = (await reminderRepo.listByMatch(match.id))[0]!;

    expect(after.id).toBe(before.id); // same row, not a duplicate
    expect(after.scheduledAt.toISOString()).toBe(new Date("2026-11-07T19:30:00Z").toISOString());
  });

  it("reconcileMatch does NOT overwrite a SENT reminder's scheduled_at (it's history, not a live plan)", async () => {
    const match = await makeMatch("Team AlreadySent", new Date("2026-11-08T19:00:00Z"));
    await reminderRepo.reconcileMatch(match.id, planReminders(match.scheduledAt, [60]));
    const row = (await reminderRepo.listByMatch(match.id))[0]!;

    const claimed = await reminderRepo.claim(row.id);
    expect(claimed).toBeDefined();
    await reminderRepo.markSent(row.id, "channel-1", "msg-1");

    // Match gets edited afterwards — reconcile runs again with a new time.
    await reminderRepo.reconcileMatch(match.id, planReminders(new Date("2026-11-08T21:00:00Z"), [60]));
    const after = (await reminderRepo.listByMatch(match.id))[0]!;
    expect(after.status).toBe("SENT");
    expect(after.scheduledAt.toISOString()).toBe(row.scheduledAt.toISOString()); // untouched
  });

  it("claim() is a one-way door — a second claim on the same PENDING->CLAIMED row fails (plan section 50 duplicate-send prevention)", async () => {
    const match = await makeMatch("Team Race", new Date("2026-11-09T19:00:00Z"));
    await reminderRepo.reconcileMatch(match.id, planReminders(match.scheduledAt, [60]));
    const row = (await reminderRepo.listByMatch(match.id))[0]!;

    const [first, second] = await Promise.all([reminderRepo.claim(row.id), reminderRepo.claim(row.id)]);
    const winners = [first, second].filter((r) => r !== undefined);
    expect(winners).toHaveLength(1); // exactly one caller wins the race
  });

  it("revertToPending lets a failed send retry on the next tick", async () => {
    const match = await makeMatch("Team Revert", new Date("2026-11-10T19:00:00Z"));
    await reminderRepo.reconcileMatch(match.id, planReminders(match.scheduledAt, [60]));
    const row = (await reminderRepo.listByMatch(match.id))[0]!;

    await reminderRepo.claim(row.id);
    await reminderRepo.revertToPending(row.id);

    const after = (await reminderRepo.listByMatch(match.id))[0]!;
    expect(after.status).toBe("PENDING");

    // And it can be claimed again after reverting.
    const reclaimed = await reminderRepo.claim(row.id);
    expect(reclaimed).toBeDefined();
  });

  it("findDue only returns PENDING reminders at/after their scheduled_at, for still-eligible matches, earliest first", async () => {
    const past = await makeMatch("Team Due", new Date(Date.now() + 60_000));
    await reminderRepo.reconcileMatch(
      past.id,
      // both offsets computed against a kickoff 1 minute from now, so
      // both scheduled_at values land in the past relative to `now` below
      planReminders(new Date(Date.now() + 60_000), [120, 30]),
    );
    const future = await makeMatch("Team NotDueYet", new Date("2030-01-01T19:00:00Z"));
    await reminderRepo.reconcileMatch(future.id, planReminders(new Date("2030-01-01T19:00:00Z"), [180]));

    const due = await reminderRepo.findDue(new Date());
    const dueForPast = due.filter((d) => d.match.id === past.id);
    expect(dueForPast).toHaveLength(2);
    expect(dueForPast[0]!.reminder.offsetMinutes).toBe(120); // larger offset = earlier scheduled_at = first
    expect(due.some((d) => d.match.id === future.id)).toBe(false);
  });

  it("skipPendingForTerminalMatches marks PENDING reminders SKIPPED once their match is CANCELLED", async () => {
    const match = await makeMatch("Team Cancelled", new Date("2026-11-11T19:00:00Z"));
    await reminderRepo.reconcileMatch(match.id, planReminders(match.scheduledAt, [180, 60]));
    await matchRepo.update(match.id, { status: "CANCELLED" });

    const skipped = await reminderRepo.skipPendingForTerminalMatches();
    expect(skipped).toBeGreaterThanOrEqual(2);

    const rows = await reminderRepo.listByMatch(match.id);
    expect(rows.every((r) => r.status === "SKIPPED")).toBe(true);
  });

  it("skipPendingForTerminalMatches does not touch reminders for still-active matches", async () => {
    const match = await makeMatch("Team StillActive", new Date("2026-11-12T19:00:00Z"));
    await reminderRepo.reconcileMatch(match.id, planReminders(match.scheduledAt, [60]));

    await reminderRepo.skipPendingForTerminalMatches();

    const rows = await reminderRepo.listByMatch(match.id);
    expect(rows[0]!.status).toBe("PENDING");
  });
});
