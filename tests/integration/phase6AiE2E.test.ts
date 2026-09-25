import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ButtonInteraction } from "discord.js";
import type { Pool } from "pg";
import { createDatabase, type Database } from "../../src/database/client.js";
import { buildAppContext, type AppContext } from "../../src/appContext.js";
import type { DiscordRestClient } from "../../src/discord/discordRest.js";
import { dispatchButton } from "../../src/discord/interactions/dispatchButton.js";
import { logger } from "../../src/config/logger.js";
import { LlmError, type LlmClient } from "../../src/services/ai/llmClient.js";
import { AI_FALLBACK_MESSAGE } from "../../src/modules/ai/aiService.js";

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

function fakeButton(customId: string, guildId: string, userId: string, displayName: string) {
  const update = vi.fn(async (_p: unknown) => undefined);
  const reply = vi.fn(async (_p: unknown) => undefined);
  const followUp = vi.fn(async (_p: { content: string; ephemeral?: boolean }) => undefined);
  const interaction = {
    customId,
    guildId,
    user: { id: userId, username: userId, globalName: displayName },
    member: { displayName },
    update,
    reply,
    followUp,
    deferred: true,
    replied: false,
    isRepliable: () => true,
  };
  return { interaction: interaction as unknown as ButtonInteraction, update, reply, followUp };
}

function fakeLlm(impl: (system: string) => Promise<string>): LlmClient & { complete: ReturnType<typeof vi.fn> } {
  return {
    model: "fake-model",
    complete: vi.fn(async ({ system }: { system: string }) => ({
      text: await impl(system),
      model: "fake-model",
      inputTokens: 1,
      outputTokens: 1,
    })),
  };
}

const json = (response: string) => JSON.stringify({ response, should_follow_up: false, memory_candidate: null });

describeIfDb("Phase 6 — attendance click -> private AI followup (integration)", () => {
  let db: Database;
  let pool: Pool;
  const guildId = `phase6-guild-${Date.now()}`;
  const discord = {} as DiscordRestClient;

  function ctxWith(llm: LlmClient | null): AppContext {
    return buildAppContext({ discord, db, env: {} as never, logger, llm });
  }

  async function openMatch(ctx: AppContext, opponent: string) {
    const match = await ctx.repositories.matches.create({
      guildId,
      opponent,
      scheduledAt: new Date(Date.now() + 86_400_000),
      timezone: "Africa/Cairo",
    } as never);
    await ctx.services.attendance.recordAnnouncement(match.id, "chan", "msg");
    return match;
  }

  beforeAll(async () => {
    ({ db, pool } = createDatabase({ DATABASE_URL: databaseUrl! }));
    const ctx = ctxWith(null);
    await ctx.repositories.serverConfig.upsert(guildId, { timezone: "Africa/Cairo", matchChannelId: "chan" });
    await ctx.repositories.players.upsertByDiscordUserId(guildId, "player-a", {
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
      protectedTopics: ["Family"],
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("first click -> AI followup in the right mode; identical re-click -> no second AI message; changed answer -> new mode", async () => {
    const llm = fakeLlm(async (system) => json(system.includes("MODE: CELEBRATE.") ? "hype!" : "roast!"));
    const ctx = ctxWith(llm);
    const match = await openMatch(ctx, "Team AI");

    const first = fakeButton(`attendance:${match.id}:PLAYING`, guildId, "player-a", "Ahmed");
    await dispatchButton(first.interaction, ctx);
    expect(first.update).toHaveBeenCalledTimes(1);
    expect(first.followUp).toHaveBeenCalledWith({ content: "hype!", ephemeral: true });

    const repeat = fakeButton(`attendance:${match.id}:PLAYING`, guildId, "player-a", "Ahmed");
    await dispatchButton(repeat.interaction, ctx);
    expect(repeat.update).toHaveBeenCalledTimes(1); // public roster still refreshed
    expect(repeat.followUp).not.toHaveBeenCalled();
    expect(llm.complete).toHaveBeenCalledTimes(1);

    const changed = fakeButton(`attendance:${match.id}:CANNOT_PLAY`, guildId, "player-a", "Ahmed");
    await dispatchButton(changed.interaction, ctx);
    expect(changed.followUp).toHaveBeenCalledWith({ content: "roast!", ephemeral: true });

    const rows = (await ctx.services.attendance.getMatchWithAttendance(guildId, match.id))!.attendanceRows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("CANNOT_PLAY");
  });

  it("LLM outage: attendance is still recorded and the player gets the safe fallback (plan section 48)", async () => {
    const ctx = ctxWith(
      fakeLlm(async () => {
        throw new LlmError("HTTP 500", "http", 500);
      }),
    );
    const match = await openMatch(ctx, "Team Outage");
    const click = fakeButton(`attendance:${match.id}:PLAYING`, guildId, "player-a", "Ahmed");
    await dispatchButton(click.interaction, ctx);

    expect(click.reply).not.toHaveBeenCalled();
    expect(click.followUp).toHaveBeenCalledWith({ content: AI_FALLBACK_MESSAGE, ephemeral: true });
    const rows = (await ctx.services.attendance.getMatchWithAttendance(guildId, match.id))!.attendanceRows;
    expect(rows.map((r) => r.status)).toEqual(["PLAYING"]);
  });

  it("a response that touches a protected topic never reaches the player", async () => {
    const ctx = ctxWith(fakeLlm(async () => json("how is your family?")));
    const match = await openMatch(ctx, "Team Protected");
    const click = fakeButton(`attendance:${match.id}:CANNOT_PLAY`, guildId, "player-a", "Ahmed");
    await dispatchButton(click.interaction, ctx);
    expect(click.followUp).toHaveBeenCalledWith({ content: AI_FALLBACK_MESSAGE, ephemeral: true });
  });

  it("AI not configured: click behaves exactly like Phase 5 (no followUp at all)", async () => {
    const ctx = ctxWith(null);
    const match = await openMatch(ctx, "Team NoAi");
    const click = fakeButton(`attendance:${match.id}:PLAYING`, guildId, "player-a", "Ahmed");
    await dispatchButton(click.interaction, ctx);
    expect(click.update).toHaveBeenCalledTimes(1);
    expect(click.followUp).not.toHaveBeenCalled();
  });
});
