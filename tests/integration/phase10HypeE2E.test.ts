import { visibleText } from "../unit/helpers/embedText.js";
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
 * here is scoped to this file's own channel / per-test roster tag rather than
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

/** How many LLM calls were made for a given test's own roster (other guilds' due matches share the same fake). The prompt has no opponent/match id to key on, but it does list the roster. */
function llmCallsFor(llm: { complete: ReturnType<typeof vi.fn> }, tag: string) {
  return llm.complete.mock.calls.filter(([req]) => (req as { user: string }).user.includes(tag));
}

/** EmbedBuilder has no public getters — read back via .toJSON() like the real send path does. */
function embedOf(payload: ReplyPayload) {
  return payload.embeds![0]!.toJSON();
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
    const tag = Math.random().toString(36).slice(2, 8);
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
      displayName: `Ahmed-${tag}`,
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
    return { ctx, guildId, channelId, fakeD, tag };
  }

  it("the closest-to-kickoff nudge becomes an AI hype message with a deterministic header (plan section 38's example)", async () => {
    const llm = fakeLlm(() => teamJson("The squad is assembling. Jett is locked."));
    const { ctx, guildId, channelId, fakeD, tag } = await setup([120, 60], llm);
    const match = await ctx.repositories.matches.create({
      guildId,
      scheduledAt: new Date(Date.now() + 65 * MINUTE),
      timezone: "Africa/Cairo",
    });

    await runReminderCronJob(ctx, new Date()); // 120 opens confirmation (announcement, never hype)
    expect(llmCallsFor(llm, tag)).toHaveLength(0);

    await runReminderCronJob(ctx, new Date(Date.now() + 10 * MINUTE)); // 60 is the closest offset -> hype

    const calls = fakeD.callsForChannel(channelId);
    const [, payload] = calls.at(-1)!;
    const embed = embedOf(payload);
    expect(embed.title).toBe("🔥 1 HOUR");
    expect(embed.description).toContain("The squad is assembling. Jett is locked."); // AI personality layer
    expect(embed.description).toContain(`Match #${match.id}`); // deterministic match line, built by the app
    expect(embed.fields).toHaveLength(2); // the enhanced reminder UI's attendance tallies are still there
    expect(payload.content).toBeUndefined();
    expect(payload.components).toBeUndefined(); // still a nudge-style message: no buttons

    const promptsForMatch = llmCallsFor(llm, tag);
    expect(promptsForMatch).toHaveLength(1);
    expect((promptsForMatch[0]![0] as { user: string }).user).toContain(`Ahmed-${tag} (DUELIST, Jett)`); // roster facts came from the DB
  });

  it("a non-closest nudge stays the plain deterministic nudge, and never calls the LLM", async () => {
    const llm = fakeLlm(() => teamJson("hype"));
    const { ctx, guildId, channelId, fakeD, tag } = await setup([180, 120, 60], llm);
    await ctx.repositories.matches.create({
      guildId,
      scheduledAt: new Date(Date.now() + 115 * MINUTE), // 180 (-65m) and 120 (-5m) are due now; 60 (+55m) is not
      timezone: "Africa/Cairo",
    });

    await runReminderCronJob(ctx, new Date());

    const calls = fakeD.callsForChannel(channelId);
    const [, payload] = calls.at(-1)!;
    expect(embedOf(payload).title).toContain("until kickoff"); // buildReminderNudgeMessage's plain header
    expect(embedOf(payload).title).not.toContain("🔥");
    expect(llmCallsFor(llm, tag)).toHaveLength(0);
  });

  it("falls back to the plain nudge when the LLM fails — the reminder still goes out (plan sections 48/66.8)", async () => {
    const llm = fakeLlm(() => {
      throw new Error("provider down");
    });
    const { ctx, guildId, channelId, fakeD, tag } = await setup([120, 60], llm);
    const match = await ctx.repositories.matches.create({
      guildId,
      scheduledAt: new Date(Date.now() + 65 * MINUTE),
      timezone: "Africa/Cairo",
    });

    await runReminderCronJob(ctx, new Date());
    await runReminderCronJob(ctx, new Date(Date.now() + 10 * MINUTE));

    const [, payload] = fakeD.callsForChannel(channelId).at(-1)!;
    expect(embedOf(payload).title).toContain("until kickoff");
    expect(embedOf(payload).title).not.toContain("🔥");

    const rows = await ctx.repositories.reminders.listByMatch(match.id);
    expect(rows.every((r) => r.status === "SENT")).toBe(true); // reminder recorded as sent despite AI failure
  });

  it("with AI disabled entirely, the closest nudge is the plain deterministic nudge (no hype header)", async () => {
    const { ctx, guildId, channelId, fakeD, tag } = await setup([120, 60], null);
    await ctx.repositories.matches.create({
      guildId,
      scheduledAt: new Date(Date.now() + 65 * MINUTE),
      timezone: "Africa/Cairo",
    });

    await runReminderCronJob(ctx, new Date());
    await runReminderCronJob(ctx, new Date(Date.now() + 10 * MINUTE));

    const [, payload] = fakeD.callsForChannel(channelId).at(-1)!;
    expect(embedOf(payload).title).toContain("until kickoff");
    expect(embedOf(payload).title).not.toContain("🔥");
  });

  it("a single-offset schedule never hypes: its only reminder is the announcement", async () => {
    const llm = fakeLlm(() => teamJson("hype"));
    const { ctx, guildId, channelId, fakeD, tag } = await setup([60], llm);
    await ctx.repositories.matches.create({
      guildId,
      scheduledAt: new Date(Date.now() + 30 * MINUTE),
      timezone: "Africa/Cairo",
    });

    await runReminderCronJob(ctx, new Date());

    const [, payload] = fakeD.callsForChannel(channelId).at(-1)!;
    expect(payload.components).toHaveLength(1); // the roster announcement with buttons
    expect(visibleText(payload)).not.toContain("🔥"); // the roster card carries no hype header
    expect(payload.embeds).toHaveLength(1); // ...it is the match card itself, not a nudge embed
    expect(llmCallsFor(llm, tag)).toHaveLength(0);
  });
});
