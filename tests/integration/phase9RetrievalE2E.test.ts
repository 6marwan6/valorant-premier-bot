import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ButtonInteraction } from "discord.js";
import { eq, isNull } from "drizzle-orm";
import type { Pool } from "pg";
import { createDatabase, type Database } from "../../src/database/client.js";
import { buildAppContext, type AppContext } from "../../src/appContext.js";
import type { DiscordChannelMessage, DiscordRestClient, ReplyPayload } from "../../src/discord/discordRest.js";
import { dispatchButton } from "../../src/discord/interactions/dispatchButton.js";
import { logger } from "../../src/config/logger.js";
import type { LlmClient } from "../../src/services/ai/llmClient.js";
import { aiConversations } from "../../src/database/schema/aiConversations.js";
import { memories } from "../../src/database/schema/memories.js";

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

// ---------------------------------------------------------------- fakes
// Same shapes as phase6/phase7/phase8's own local fakes — this codebase
// duplicates these per integration test file rather than sharing a helpers
// module, so this file follows that same convention.

function fakeDiscord() {
  let nextId = 200_000_000_000_000_000n;
  const channels = new Map<string, Array<DiscordChannelMessage & { components?: unknown[] }>>();
  const mentions: Array<{ channelId: string; text: string; discordUserId: string }> = [];

  const discord = {
    createDmChannel: vi.fn(async (userId: string) => {
      const id = `dm-${userId}`;
      if (!channels.has(id)) channels.set(id, []);
      return { id };
    }),
    sendDirectMessage: vi.fn(async (channelId: string, payload: ReplyPayload) => {
      const id = String(++nextId);
      const list = channels.get(channelId) ?? [];
      list.push({ id, content: payload.content ?? "", author: { id: "bot", bot: true }, components: payload.components });
      channels.set(channelId, list);
      return { id };
    }),
    editChannelMessage: vi.fn(async () => undefined),
    // Phase 9's public-audience tests need this — CELEBRATE/ROAST post here now, not as an ephemeral followUp (section 18/19's revision).
    sendMentionMessage: vi.fn(async (channelId: string, text: string, discordUserId: string) => {
      mentions.push({ channelId, text, discordUserId });
    }),
    listChannelMessages: vi.fn(async () => []),
    editOriginalInteractionResponse: vi.fn(async () => undefined),
    sendInteractionFollowup: vi.fn(async () => undefined),
  };

  return { discord: discord as unknown as DiscordRestClient, mentions };
}
type FakeDiscord = ReturnType<typeof fakeDiscord>;

function fakeLlm(impl: (input: { system: string; user: string }) => Promise<string> | string) {
  const prompts: Array<{ system: string; user: string }> = [];
  const llm: LlmClient & { complete: ReturnType<typeof vi.fn> } = {
    model: "fake-model",
    complete: vi.fn(async (req: { system: string; user: string }) => {
      prompts.push(req);
      return { text: await impl(req), model: "fake-model", inputTokens: 1, outputTokens: 1 };
    }),
  };
  return { llm, prompts };
}

const json = (response: string, follow = false) => JSON.stringify({ response, should_follow_up: follow, memory_candidate: null });

function fakeButton(customId: string, userId: string, guildId: string | null) {
  const interaction = {
    customId,
    guildId,
    user: { id: userId, username: userId, globalName: userId },
    update: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    deferred: true,
    replied: false,
    isRepliable: () => true,
  };
  return interaction as unknown as ButtonInteraction;
}

// ---------------------------------------------------------------- suite

describeIfDb("Phase 9 — retrieval (integration)", () => {
  let db: Database;
  let pool: Pool;
  const guildId = `phase9-guild-${Date.now()}`;
  let seq = 0;

  function ctxWith(discord: FakeDiscord, llm: LlmClient | null): AppContext {
    return buildAppContext({ discord: discord.discord, db, env: {} as never, logger, llm });
  }

  async function openMatch(ctx: AppContext) {
    const match = await ctx.repositories.matches.create({
      guildId,
      scheduledAt: new Date(Date.now() + 86_400_000 + ++seq * 60_000), // unique per call: the instant is the only dedup key now
      timezone: "Africa/Cairo",
    } as never);
    await ctx.services.attendance.recordAnnouncement(match.id, "chan", "msg");
    return match;
  }

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
    protectedTopics: ["Family"],
  };

  beforeAll(async () => {
    ({ db, pool } = createDatabase({ DATABASE_URL: databaseUrl! }));
    const ctx0 = ctxWith(fakeDiscord(), null);
    await ctx0.repositories.serverConfig.upsert(guildId, { timezone: "Africa/Cairo", matchChannelId: "chan" });
    await ctx0.repositories.players.upsertByDiscordUserId(guildId, "player-a", { ...profile, displayName: "Ahmed" });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    // Same reasoning as phase7/phase8's own note: a leftover open CONSOLE
    // conversation from a previous test would make a fresh WANTS_TO_BUT_CANNOT
    // click resume it instead of opening a new one.
    await db.update(aiConversations).set({ endedAt: new Date(), endReason: "COMPLETED" }).where(isNull(aiConversations.endedAt));
  });

  it("a PUBLIC memory reaches a real public CELEBRATE post; a PRIVATE memory for the same player never does (plan section 44 rule 1)", async () => {
    const d = fakeDiscord();
    const { llm, prompts } = fakeLlm(() => json("LET'S GOOO"));
    const ctx = ctxWith(d, llm);
    ctx.services.ai.memorySpotlightOneIn = 1; // every reaction gets the memory block, so "reached the prompt" is deterministic
    const match = await openMatch(ctx);
    const player = await ctx.repositories.players.getByDiscordUserId(guildId, "player-a");

    await ctx.repositories.memories.create({
      playerId: player!.id,
      type: "RUNNING_JOKE",
      content: 'Ahmed jokes that he is "him".',
      visibility: "PUBLIC",
      evidence: [{ sourceType: "AI_CONVERSATION", sourceId: "9001" }],
    });
    await ctx.repositories.memories.create({
      playerId: player!.id,
      type: "HABIT",
      content: "A private detail that must never go public.",
      visibility: "PRIVATE",
      evidence: [{ sourceType: "AI_CONVERSATION", sourceId: "9002" }],
    });

    await dispatchButton(fakeButton(`attendance:${match.id}:PLAYING`, "player-a", guildId), ctx);

    // The response actually went out publicly (plan sections 18/19's revision), not as an ephemeral followUp.
    expect(d.mentions).toHaveLength(1);
    expect(d.mentions[0]).toMatchObject({ channelId: "chan", text: "LET'S GOOO", discordUserId: "player-a" });

    const sentPrompt = prompts.at(-1)!;
    expect(sentPrompt.user).toContain("RELEVANT MEMORIES");
    expect(sentPrompt.user).toContain('Ahmed jokes that he is "him".');
    expect(sentPrompt.user).not.toContain("A private detail that must never go public.");
  });

  it("last_used_at is actually persisted for a memory that was retrieved into a real request", async () => {
    const d = fakeDiscord();
    const { llm } = fakeLlm(() => json("Nice."));
    const ctx = ctxWith(d, llm);
    ctx.services.ai.memorySpotlightOneIn = 1;
    const match = await openMatch(ctx);
    const player = await ctx.repositories.players.getByDiscordUserId(guildId, "player-a");

    const memory = await ctx.repositories.memories.create({
      playerId: player!.id,
      type: "VALORANT_PREFERENCE",
      content: "Ahmed mains Jett.",
      visibility: "PUBLIC",
      evidence: [{ sourceType: "AI_CONVERSATION", sourceId: "9003" }],
    });
    expect(memory.lastUsedAt).toBeNull();

    await dispatchButton(fakeButton(`attendance:${match.id}:PLAYING`, "player-a", guildId), ctx);

    const [after] = await db.select().from(memories).where(eq(memories.id, memory.id));
    expect(after!.lastUsedAt).not.toBeNull();
  });

  it("a CONSOLE conversation (a real private DM) can use the player's own PRIVATE memories — once what they say connects to one, not before", async () => {
    const d = fakeDiscord();
    const { llm, prompts } = fakeLlm(({ system }) => (system.includes("TURN: OPENING") ? json("What happened?", true) : json("Noted.")));
    const ctx = ctxWith(d, llm);
    const match = await openMatch(ctx);
    const player = await ctx.repositories.players.getByDiscordUserId(guildId, "player-a");

    await ctx.repositories.memories.create({
      playerId: player!.id,
      type: "PLAYER_PREFERENCE",
      content: "A private preference, fine to surface in Ahmed's own DM.",
      visibility: "PRIVATE",
      evidence: [{ sourceType: "AI_CONVERSATION", sourceId: "9004" }],
    });

    await dispatchButton(fakeButton(`attendance:${match.id}:WANTS_TO_BUT_CANNOT`, "player-a", guildId), ctx);

    // The opening has nothing from the player to connect a memory to (2026-09-30 relevance gate).
    expect(prompts.at(-1)!.user).not.toContain("A private preference, fine to surface in Ahmed's own DM.");

    const conversation = await ctx.repositories.aiConversations.getOpenForPlayerMatch(player!.id, match.id);
    expect(conversation).toBeDefined();
    await ctx.services.conversations.handlePlayerReply({
      conversationId: conversation!.id,
      discordUserId: "player-a",
      text: "what is my private preference again?",
      sourceRef: `p9-console-reply-${match.id}`,
    });
    expect(prompts.at(-1)!.user).toContain("A private preference, fine to surface in Ahmed's own DM.");
  });
});
