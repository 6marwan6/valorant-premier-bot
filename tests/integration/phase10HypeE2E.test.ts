import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { createDatabase, type Database } from "../../src/database/client.js";
import { buildAppContext, type AppContext } from "../../src/appContext.js";
import type { DiscordRestClient, ReplyPayload } from "../../src/discord/discordRest.js";
import { runReminderCronJob } from "../../src/services/scheduling/reminderCronJob.js";
import { logger } from "../../src/config/logger.js";
import type { LlmClient } from "../../src/services/ai/llmClient.js";

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

const MINUTE = 60_000;

/**
 * Same scoping caveat as phase4E2E.test.ts: runReminderCronJob loops over
 * every configured guild in the shared test database, so every assertion
 * here is scoped to this file's own channel / opponent names rather than
 * assuming no other test file left a due match behind.
 */
function fakeDiscordRestClient() {
  let nextId = 1;
  const sendChannelMessage = vi.fn(async (_channelId: string, _payload: ReplyPayload) => ({ id: `hype-msg-${nextId++}` }));
  return {
    discord: { sendChannelMessage } as unknown as DiscordRestClient,
    callsForChannel(channelId: string) {
      return sendChannelMessage.mock.calls.filter(([id]) => id === channelId);
    },
  };
}

function fakeLlm(impl: (input: { system: string; user: string }) => Promise<string> | string) {
  const llm: LlmClient & { complete: ReturnType<typeof vi.fn> } = {
    model: "fake-model",
    complete: vi.fn(async (req: { system: string; user: string }) => ({
      text: await impl(req),
      model: "fake-model",
      inputTokens: 1,
      outputTokens: 1,
    })),
  };
  return llm;
}

const teamJson = (response: string) => JSON.stringify({ response });

/** How many LLM calls were made about a specific opponent (other guilds' due matches share the same fake). */
function llmCallsFor(llm: { complete: ReturnType<typeof vi.fn> }, opponent: string) {
  return llm.complete.mock.calls.filter(([req]) => (req as { user: string }).user.includes(opponent));
}

describeIfDb("Phase 10 — MATCH_HYPE in the reminder cron job (integration, plan section 38)", () => {
  let db: Database;
  let pool: Pool;

  beforeAll(async () => {
    ({ db, pool } = createDatabase({ DATABASE_URL: databaseUrl! }));
  });

  afterAll(async () => {
    await pool.end();
  });

  async function setup(reminderScheduleMinutes: number[], llm: LlmClient | null) {
    const guildId = `phase10-hype-guild-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const channelId = `phase10-hype-channel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const fakeD = fakeDiscordRestClient();
    const ctx: AppContext = buildAppContext({ discord: fakeD.discord, db, env: {} as any, logger, llm });
    await ctx.repositories.serverConfig.upsert(guildId, {
      timezone: "Africa/Cairo",
      matchChannelId: channelId,
      reminderScheduleMinutes,
    });
    await ctx.repositories.players.upsertByDiscordUserId(guildId, "hype-user-1", {
      displayName: "Ahmed",
      role: "DUELIST",
      agents: ["Jett"],
      preferredAgent: "Jett",
      roastIntensity: 50,
      personalReferencesEnabled: true,
      runningJokesEnabled: true,
      valorantReferencesEnabled: true,
      matchHistoryReferencesEnabled: true,
      memoryUsageEnabled: true,
      aiFollowUpsEnabled: true,
      protectedTopics: [],
    });
    return { ctx, guildId, channelId, fakeD };
  }

  it("the closest-to-kickoff nudge becomes an AI hype message with a deterministic header (plan section 38's example)", async () => {
    const llm = fakeLlm(() => teamJson("The squad is assembling. Jett is locked."));
    const { ctx, guildId, channelId, fakeD } = await setup([120, 60], llm);
    const match = await ctx.repositories.matches.create({
      guildId,
      opponent: "Team HypeClosest",
      scheduledAt: new Date(Date.now() + 65 * MINUTE),
      timezone: "Africa/Cairo",
    });

    await runReminderCronJob(ctx, new Date()); // 120 opens confirmation (announcement, never hype)
    expect(llmCallsFor(llm, "Team HypeClosest")).toHaveLength(0);

    await runReminderCronJob(ctx, new Date(Date.now() + 10 * MINUTE)); // 60 is the closest offset -> hype

    const calls = fakeD.callsForChannel(channelId);
    const [, payload] = calls.at(-1)!;
    expect(payload.content).toContain("🔥 **1 HOUR**");
    expect(payload.content).toContain(`Match #${match.id} vs **Team HypeClosest**`);
    expect(payload.content).toContain("The squad is assembling. Jett is locked.");
    expect(payload.components).toBeUndefined(); // still a nudge-style message: no buttons

    const promptsForMatch = llmCallsFor(llm, "Team HypeClosest");
    expect(promptsForMatch).toHaveLength(1);
    expect((promptsForMatch[0]![0] as { user: string }).user).toContain("Ahmed (DUELIST, Jett)"); // roster facts came from the DB
  });

  it("a non-closest nudge stays the plain deterministic nudge, and never calls the LLM", async () => {
    const llm = fakeLlm(() => teamJson("hype"));
    const { ctx, guildId, channelId, fakeD } = await setup([180, 120, 60], llm);
    await ctx.repositories.matches.create({
      guildId,
      opponent: "Team HypeMiddle",
      scheduledAt: new Date(Date.now() + 115 * MINUTE), // 180 (-65m) and 120 (-5m) are due now; 60 (+55m) is not
      timezone: "Africa/Cairo",
    });

    await runReminderCronJob(ctx, new Date());

    const calls = fakeD.callsForChannel(channelId);
    const [, payload] = calls.at(-1)!;
    expect(payload.content).toContain("until kickoff"); // buildReminderNudgeMessage's plain header
    expect(payload.content).not.toContain("🔥");
    expect(llmCallsFor(llm, "Team HypeMiddle")).toHaveLength(0);
  });

  it("falls back to the plain nudge when the LLM fails — the reminder still goes out (plan sections 48/66.8)", async () => {
    const llm = fakeLlm(() => {
      throw new Error("provider down");
    });
    const { ctx, guildId, channelId, fakeD } = await setup([120, 60], llm);
    const match = await ctx.repositories.matches.create({
      guildId,
      opponent: "Team HypeFallback",
      scheduledAt: new Date(Date.now() + 65 * MINUTE),
      timezone: "Africa/Cairo",
    });

    await runReminderCronJob(ctx, new Date());
    await runReminderCronJob(ctx, new Date(Date.now() + 10 * MINUTE));

    const [, payload] = fakeD.callsForChannel(channelId).at(-1)!;
    expect(payload.content).toContain("until kickoff");
    expect(payload.content).not.toContain("🔥");

    const rows = await ctx.repositories.reminders.listByMatch(match.id);
    expect(rows.every((r) => r.status === "SENT")).toBe(true); // reminder recorded as sent despite AI failure
  });

  it("with AI disabled entirely, the closest nudge is the plain deterministic nudge (no hype header)", async () => {
    const { ctx, guildId, channelId, fakeD } = await setup([120, 60], null);
    await ctx.repositories.matches.create({
      guildId,
      opponent: "Team HypeNoAi",
      scheduledAt: new Date(Date.now() + 65 * MINUTE),
      timezone: "Africa/Cairo",
    });

    await runReminderCronJob(ctx, new Date());
    await runReminderCronJob(ctx, new Date(Date.now() + 10 * MINUTE));

    const [, payload] = fakeD.callsForChannel(channelId).at(-1)!;
    expect(payload.content).toContain("until kickoff");
    expect(payload.content).not.toContain("🔥");
  });

  it("a single-offset schedule never hypes: its only reminder is the announcement", async () => {
    const llm = fakeLlm(() => teamJson("hype"));
    const { ctx, guildId, channelId, fakeD } = await setup([60], llm);
    await ctx.repositories.matches.create({
      guildId,
      opponent: "Team HypeSingle",
      scheduledAt: new Date(Date.now() + 30 * MINUTE),
      timezone: "Africa/Cairo",
    });

    await runReminderCronJob(ctx, new Date());

    const [, payload] = fakeD.callsForChannel(channelId).at(-1)!;
    expect(payload.components).toHaveLength(1); // the roster announcement with buttons
    expect(payload.content).not.toContain("🔥");
    expect(llmCallsFor(llm, "Team HypeSingle")).toHaveLength(0);
  });
});
