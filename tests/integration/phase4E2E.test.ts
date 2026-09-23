import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { createDatabase, type Database } from "../../src/database/client.js";
import { buildAppContext, type AppContext } from "../../src/appContext.js";
import type { DiscordRestClient, ReplyPayload } from "../../src/discord/discordRest.js";
import { runReminderCronJob } from "../../src/services/scheduling/reminderCronJob.js";
import { logger } from "../../src/config/logger.js";

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

/**
 * A fake DiscordRestClient, in the spirit of phase3E2E.test.ts's — but
 * with one addition specific to this file: `runReminderCronJob` loops
 * over *every* configured guild (correct for production — see
 * ServerConfigRepository.listAll's doc comment), and this test suite
 * shares one Postgres instance/database with every other integration
 * test file. That means a match some *other* test file created, in some
 * *other* guild, can legitimately be "due" by the time this file's tests
 * run and get processed in the same cron tick as this file's own
 * matches.
 *
 * Rather than assume that never happens (fragile — it depends on what
 * other test files' fixtures look like, which this file has no business
 * knowing about), every assertion below is scoped to this test's own
 * `channelId`, and `failNextSendMatching` only injects a failure into a
 * call this test itself is expecting, never into whichever call happens
 * to land first.
 */
function fakeDiscordRestClient() {
  const messages = new Map<string, ReplyPayload>();
  let nextId = 1;
  let failWhen: ((channelId: string, payload: ReplyPayload) => boolean) | undefined;

  const sendChannelMessage = vi.fn(async (channelId: string, payload: ReplyPayload) => {
    if (failWhen?.(channelId, payload)) {
      failWhen = undefined;
      throw new Error("simulated Discord outage");
    }
    const id = `msg-${nextId++}`;
    messages.set(id, payload);
    return { id };
  });

  return {
    discord: { sendChannelMessage } as unknown as DiscordRestClient,
    sendChannelMessage,
    messages,
    /** Every send this test's own channel actually received, in order. */
    callsForChannel(channelId: string) {
      return sendChannelMessage.mock.calls.filter(([id]) => id === channelId);
    },
    /** Makes the *next* call matching `predicate` throw, exactly once. */
    failNextSendMatching(predicate: (channelId: string, payload: ReplyPayload) => boolean) {
      failWhen = predicate;
    },
  };
}

const MINUTE = 60_000;

describeIfDb("Phase 4 — reminders cron job (integration)", () => {
  let db: Database;
  let pool: Pool;
  let ctx: AppContext;
  let fakeDiscord: ReturnType<typeof fakeDiscordRestClient>;
  const guildId = `phase4-guild-${Date.now()}`;
  const channelId = `channel-p4-${Date.now()}`;

  beforeAll(async () => {
    ({ db, pool } = createDatabase({ DATABASE_URL: databaseUrl! }));
    fakeDiscord = fakeDiscordRestClient();
    ctx = buildAppContext({ discord: fakeDiscord.discord, db, env: {} as any, logger });
    await ctx.repositories.serverConfig.upsert(guildId, {
      timezone: "Africa/Cairo",
      matchChannelId: channelId,
      reminderScheduleMinutes: [120, 60],
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  async function createMatch(opponent: string, scheduledAt: Date) {
    return ctx.repositories.matches.create({ guildId, opponent, scheduledAt, timezone: "Africa/Cairo" });
  }

  it("reconciles reminder rows for an active match without sending anything before they're due", async () => {
    const match = await createMatch("Team Far Future", new Date(Date.now() + 10 * 24 * 60 * MINUTE));

    const summary = await runReminderCronJob(ctx, new Date());

    expect(summary.matchesReconciled).toBeGreaterThanOrEqual(1);
    const rows = await ctx.repositories.reminders.listByMatch(match.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "PENDING")).toBe(true);
    expect(fakeDiscord.callsForChannel(channelId)).toHaveLength(0); // nothing due yet
  });

  it("the earliest-due reminder opens the match for confirmation — announcement, not a nudge", async () => {
    // kickoff in 90 minutes; offsets [120, 60] -> the 120 reminder's
    // scheduled_at is 30 minutes ago (due), the 60 reminder's is 30
    // minutes from now (not due yet).
    const match = await createMatch("Team Soon", new Date(Date.now() + 90 * MINUTE));

    const summary = await runReminderCronJob(ctx, new Date());

    expect(summary.remindersSent).toBeGreaterThanOrEqual(1);
    const refetched = await ctx.repositories.matches.getById(match.id);
    expect(refetched?.status).toBe("CONFIRMATION_OPEN");
    expect(refetched?.announcementChannelId).toBe(channelId);
    expect(refetched?.announcementMessageId).toBeTruthy();

    const ourCalls = fakeDiscord.callsForChannel(channelId);
    const [, payload] = ourCalls.at(-1)!;
    expect(payload.content).toContain("Team Soon");
    expect(payload.components).toHaveLength(1); // the roster message's buttons

    const rows = await ctx.repositories.reminders.listByMatch(match.id);
    const opened = rows.find((r) => r.offsetMinutes === 120)!;
    const notYetDue = rows.find((r) => r.offsetMinutes === 60)!;
    expect(opened.status).toBe("SENT");
    expect(opened.discordMessageId).toBe(refetched?.announcementMessageId);
    expect(notYetDue.status).toBe("PENDING");
  });

  it("re-running the same tick does not double-send the already-SENT announcement (plan section 50)", async () => {
    const match = await createMatch("Team NoDouble", new Date(Date.now() + 90 * MINUTE));
    await runReminderCronJob(ctx, new Date());
    const callsAfterFirst = fakeDiscord.callsForChannel(channelId).length;

    await runReminderCronJob(ctx, new Date());
    const callsAfterSecond = fakeDiscord.callsForChannel(channelId).length;

    expect(callsAfterSecond).toBe(callsAfterFirst); // no new sends
    const refetched = await ctx.repositories.matches.getById(match.id);
    expect(refetched?.status).toBe("CONFIRMATION_OPEN"); // unchanged, not re-opened
  });

  it("a later reminder for an already-open match sends a nudge, not a second announcement", async () => {
    // kickoff in 65 minutes: the 120-offset reminder is due now (opens the
    // match); the 60-offset reminder becomes due 5 minutes later.
    const match = await createMatch("Team Nudge", new Date(Date.now() + 65 * MINUTE));
    await runReminderCronJob(ctx, new Date());
    const afterOpen = await ctx.repositories.matches.getById(match.id);
    expect(afterOpen?.status).toBe("CONFIRMATION_OPEN");
    const callsAfterOpen = fakeDiscord.callsForChannel(channelId).length;

    // Simulate the clock advancing 10 minutes to the next cron tick.
    await runReminderCronJob(ctx, new Date(Date.now() + 10 * MINUTE));

    const ourCalls = fakeDiscord.callsForChannel(channelId);
    expect(ourCalls).toHaveLength(callsAfterOpen + 1);
    const [, nudgePayload] = ourCalls.at(-1)!;
    expect(nudgePayload.content).toContain(`Match #${match.id}`);
    expect(nudgePayload.components).toBeUndefined(); // no buttons on a nudge

    const stillOpen = await ctx.repositories.matches.getById(match.id);
    expect(stillOpen?.announcementMessageId).toBe(afterOpen?.announcementMessageId); // unchanged, not re-posted

    const rows = await ctx.repositories.reminders.listByMatch(match.id);
    expect(rows.every((r) => r.status === "SENT")).toBe(true);
  });

  it("a very late reminder generation sends the announcement AND a nudge in the same tick, in order", async () => {
    // kickoff in 5 minutes: both offsets [120, 60] are already past.
    const match = await createMatch("Team VeryLate", new Date(Date.now() + 5 * MINUTE));

    await runReminderCronJob(ctx, new Date());

    const ourCalls = fakeDiscord.callsForChannel(channelId);
    const matchCalls = ourCalls.filter(
      ([, payload]) => payload.content?.includes(`Match #${match.id}`) || payload.content?.includes("Team VeryLate"),
    );
    expect(matchCalls).toHaveLength(2);
    expect(matchCalls[0]![1].components).toHaveLength(1); // announcement first (largest offset = earliest scheduled_at)
    expect(matchCalls[1]![1].components).toBeUndefined(); // nudge second

    const refetched = await ctx.repositories.matches.getById(match.id);
    expect(refetched?.status).toBe("CONFIRMATION_OPEN");
    const rows = await ctx.repositories.reminders.listByMatch(match.id);
    expect(rows.every((r) => r.status === "SENT")).toBe(true);
  });

  it("cancelling a match skips its still-PENDING reminders instead of ever sending them", async () => {
    const match = await createMatch("Team CancelledBeforeDue", new Date(Date.now() + 10 * 24 * MINUTE));
    await runReminderCronJob(ctx, new Date()); // reconciles rows, nothing due
    await ctx.repositories.matches.update(match.id, { status: "CANCELLED" });
    const callsBefore = fakeDiscord.callsForChannel(channelId).length;

    const summary = await runReminderCronJob(ctx, new Date());

    expect(summary.remindersSkippedTerminal).toBeGreaterThanOrEqual(2);
    const rows = await ctx.repositories.reminders.listByMatch(match.id);
    expect(rows.every((r) => r.status === "SKIPPED")).toBe(true);
    expect(fakeDiscord.callsForChannel(channelId)).toHaveLength(callsBefore); // never sent
  });

  it("a Discord send failure reverts the claimed reminder to PENDING instead of losing it", async () => {
    const match = await createMatch("Team DiscordDown", new Date(Date.now() + 90 * MINUTE));
    // Only fail the call this test itself triggers — a blanket "fail the
    // very next call" would be at the mercy of whichever guild's
    // reminder happens to be processed first in this tick (see this
    // file's fakeDiscordRestClient doc comment).
    fakeDiscord.failNextSendMatching((cid, payload) => cid === channelId && Boolean(payload.content?.includes("Team DiscordDown")));

    const summary = await runReminderCronJob(ctx, new Date());
    expect(summary.remindersFailed).toBeGreaterThanOrEqual(1);

    const rows = await ctx.repositories.reminders.listByMatch(match.id);
    const attempted = rows.find((r) => r.offsetMinutes === 120)!;
    expect(attempted.status).toBe("PENDING"); // reverted, not stuck CLAIMED, not falsely SENT

    const refetched = await ctx.repositories.matches.getById(match.id);
    expect(refetched?.status).toBe("SCHEDULED"); // never marked open — the send never actually happened

    // The next tick retries successfully.
    const retrySummary = await runReminderCronJob(ctx, new Date());
    expect(retrySummary.remindersSent).toBeGreaterThanOrEqual(1);
    const retriedRow = (await ctx.repositories.reminders.listByMatch(match.id)).find((r) => r.offsetMinutes === 120)!;
    expect(retriedRow.status).toBe("SENT");
  });
});
