import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ButtonInteraction, ChatInputCommandInteraction } from "discord.js";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Pool } from "pg";
import { createDatabase, type Database } from "../../src/database/client.js";
import { buildAppContext, type AppContext } from "../../src/appContext.js";
import type { DiscordChannelMessage, DiscordRestClient, ReplyPayload } from "../../src/discord/discordRest.js";
import { dispatchButton } from "../../src/discord/interactions/dispatchButton.js";
import { handleConsoleReplyModal } from "../../src/discord/consoleConversation.js";
import { logger } from "../../src/config/logger.js";
import type { LlmClient } from "../../src/services/ai/llmClient.js";
import memoriesCommand from "../../src/discord/commands/memories.js";
import { aiConversations, aiMessages } from "../../src/database/schema/aiConversations.js";
import { memories } from "../../src/database/schema/memories.js";
import { memoryEvidence } from "../../src/database/schema/memoryEvidence.js";

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

// ---------------------------------------------------------------- fakes

/** Same shape as phase7ConversationE2E.test.ts's fakeDiscord, plus editChannelMessage (Phase 8's follow-up button edit). */
function fakeDiscord() {
  let nextId = 200_000_000_000_000_000n;
  const channels = new Map<string, Array<DiscordChannelMessage & { components?: unknown[] }>>();
  const edits: Array<{ channelId: string; messageId: string; payload: ReplyPayload }> = [];

  const discord = {
    createDmChannel: vi.fn(async (userId: string) => {
      const id = `dm-${userId}`;
      if (!channels.has(id)) channels.set(id, []);
      return { id };
    }),
    sendDirectMessage: vi.fn(async (channelId: string, payload: ReplyPayload) => {
      const id = String(++nextId);
      const list = channels.get(channelId) ?? [];
      list.push({ id, content: payload.content, author: { id: "bot", bot: true }, components: payload.components });
      channels.set(channelId, list);
      return { id };
    }),
    editChannelMessage: vi.fn(async (channelId: string, messageId: string, payload: ReplyPayload) => {
      edits.push({ channelId, messageId, payload });
      const list = channels.get(channelId) ?? [];
      const msg = list.find((m) => m.id === messageId);
      if (msg) {
        msg.content = payload.content ?? msg.content;
        msg.components = payload.components;
      }
    }),
    listChannelMessages: vi.fn(async (channelId: string, o: { after?: string | null } = {}) => {
      const list = channels.get(channelId) ?? [];
      return list.filter((m) => !o.after || BigInt(m.id) > BigInt(o.after));
    }),
    editOriginalInteractionResponse: vi.fn(async () => undefined),
    sendInteractionFollowup: vi.fn(async () => undefined),
  };

  return {
    discord: discord as unknown as DiscordRestClient,
    raw: discord,
    edits,
    dm(userId: string) {
      return channels.get(`dm-${userId}`) ?? [];
    },
  };
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

/** Unlike phase7's `json()`, this one can carry a memory_candidate (Phase 8's whole point). */
const json = (response: string, follow: boolean, candidate: { type: string; content: string } | null = null) =>
  JSON.stringify({
    response,
    should_follow_up: follow,
    memory_candidate: candidate ? { ...candidate, requires_confirmation: true } : null,
  });

function fakeButton(customId: string, userId: string, guildId: string | null = null) {
  const followUp = vi.fn(async () => undefined);
  const update = vi.fn(async () => undefined);
  const interaction = {
    customId,
    guildId,
    user: { id: userId, username: userId, globalName: userId },
    update,
    reply: vi.fn(async () => undefined),
    followUp,
    deferred: true,
    replied: false,
    isRepliable: () => true,
  };
  return { interaction: interaction as unknown as ButtonInteraction, followUp, update };
}

function fakeCommand(guildId: string, userId: string) {
  const reply = vi.fn(async () => undefined);
  const interaction = { guildId, user: { id: userId }, reply };
  return { interaction: interaction as unknown as ChatInputCommandInteraction, reply };
}

// ---------------------------------------------------------------- suite

describeIfDb("Phase 8 — memory approval, storage, and /memories (integration)", () => {
  let db: Database;
  let pool: Pool;
  const guildId = `phase8-guild-${Date.now()}`;
  let seq = 0;

  function ctxWith(discord: FakeDiscord, llm: LlmClient | null): AppContext {
    return buildAppContext({ discord: discord.discord, db, env: {} as never, logger, llm });
  }

  async function openMatch(ctx: AppContext) {
    const match = await ctx.repositories.matches.create({
      guildId,
      opponent: `Team P8-${++seq}`,
      scheduledAt: new Date(Date.now() + 86_400_000),
      timezone: "Africa/Cairo",
    } as never);
    await ctx.services.attendance.recordAnnouncement(match.id, "chan", "msg");
    return match;
  }

  async function click(ctx: AppContext, matchId: number, userId: string) {
    const b = fakeButton(`attendance:${matchId}:WANTS_TO_BUT_CANNOT`, userId, guildId);
    await dispatchButton(b.interaction, ctx);
  }

  async function latestConversation(userId: string) {
    const player = await ctx0.repositories.players.getByDiscordUserId(guildId, userId);
    const rows = await db.select().from(aiConversations).where(eq(aiConversations.playerId, player!.id));
    return rows.at(-1)!;
  }

  /** The most recent ASSISTANT turn — the one a memory candidate (if any) rides on. */
  async function lastAssistantMessage(conversationId: number) {
    const rows = await db
      .select()
      .from(aiMessages)
      .where(and(eq(aiMessages.conversationId, conversationId), eq(aiMessages.role, "ASSISTANT")))
      .orderBy(desc(aiMessages.id))
      .limit(1);
    return rows[0]!;
  }

  async function reply(ctx: AppContext, conversationId: number, userId: string, text: string, interactionId: string) {
    await handleConsoleReplyModal(
      {
        id: interactionId,
        token: `tok-${interactionId}`,
        type: 5,
        user: { id: userId, username: userId, global_name: userId },
        channel_id: `dm-${userId}`,
        message: { content: "previous bot message\n\n-# 💬 Tap **Reply** to answer" },
        data: {
          custom_id: `console:modal:${conversationId}`,
          components: [{ type: 18, component: { type: 4, custom_id: "reply", value: text } }],
        },
      } as never,
      ctx,
    );
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

  let ctx0: AppContext;

  beforeAll(async () => {
    ({ db, pool } = createDatabase({ DATABASE_URL: databaseUrl! }));
    ctx0 = ctxWith(fakeDiscord(), null);
    await ctx0.repositories.serverConfig.upsert(guildId, { timezone: "Africa/Cairo", matchChannelId: "chan" });
    await ctx0.repositories.players.upsertByDiscordUserId(guildId, "player-a", { ...profile, displayName: "Ahmed" });
    await ctx0.repositories.players.upsertByDiscordUserId(guildId, "player-b", { ...profile, displayName: "Omar", protectedTopics: [] });
    await ctx0.repositories.players.upsertByDiscordUserId(guildId, "player-nomem", {
      ...profile,
      displayName: "Ali",
      memoryUsageEnabled: false,
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    // Clean slate of open conversations (see phase7's own note on why).
    await db.update(aiConversations).set({ endedAt: new Date(), endReason: "COMPLETED" }).where(isNull(aiConversations.endedAt));
  });

  it("a wrap-up candidate gets buttons attached via a follow-up edit, and Remember creates the memory + its evidence", async () => {
    const d = fakeDiscord();
    let turn = 0;
    const { llm } = fakeLlm(({ system }) => {
      turn++;
      if (system.includes("TURN: OPENING")) return json("What happened?", true);
      return json("Go destroy that exam. Want me to remember that?", false, {
        type: "MATCH_EVENT",
        content: "Ahmed had an exam that prevented him from playing.",
      });
    });
    const ctx = ctxWith(d, llm);
    const match = await openMatch(ctx);
    await click(ctx, match.id, "player-a");
    const conv = await latestConversation("player-a");

    await reply(ctx, conv.id, "player-a", "I have an exam tomorrow.", "r-1");

    // The DM went out once, then got a follow-up edit adding the buttons —
    // never a race where the candidate's row id had to exist before sending.
    expect(d.dm("player-a")).toHaveLength(2);
    expect(d.edits).toHaveLength(1);
    const wrapUp = d.dm("player-a")[1]!;
    expect(wrapUp.content).toContain("Want me to remember that?");
    expect(wrapUp.components).toHaveLength(1);

    const assistantRow = await lastAssistantMessage(conv.id);
    expect(assistantRow!.memoryCandidateStatus).toBe("PENDING");

    // Click Remember.
    const b = fakeButton(`memory:remember:${assistantRow!.id}`, "player-a", null);
    await dispatchButton(b.interaction, ctx);

    const created = await db.select().from(memories).where(eq(memories.playerId, (await ctx.repositories.players.getByDiscordUserId(guildId, "player-a"))!.id));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      type: "MATCH_EVENT",
      content: "Ahmed had an exam that prevented him from playing.",
      confidence: 1,
      visibility: "PRIVATE",
      aiUsable: true,
    });
    const evidence = await db.select().from(memoryEvidence).where(eq(memoryEvidence.memoryId, created[0]!.id));
    expect(evidence).toEqual([expect.objectContaining({ sourceType: "AI_CONVERSATION", sourceId: String(conv.id) })]);

    expect(b.update).toHaveBeenCalledTimes(1);
    const [updatePayload] = b.update.mock.calls[0] as unknown as [{ content: string; components: unknown[] }];
    expect(updatePayload.content).toContain("Got it — I'll remember that.");
    expect(updatePayload.components).toEqual([]);

    // A second click on the SAME button is a no-op, not a second memory.
    const b2 = fakeButton(`memory:remember:${assistantRow!.id}`, "player-a", null);
    await dispatchButton(b2.interaction, ctx);
    expect(b2.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringMatching(/already handled/i) }));
    const stillOne = await db.select().from(memories).where(eq(memories.playerId, created[0]!.playerId));
    expect(stillOne).toHaveLength(1);
  });

  it("Don't Remember creates nothing", async () => {
    const d = fakeDiscord();
    let turn = 0;
    const { llm } = fakeLlm(({ system }) => {
      turn++;
      if (system.includes("TURN: OPENING")) return json("What happened?", true);
      return json("No worries!", false, { type: "HABIT", content: "Omar forgot about the match." });
    });
    const ctx = ctxWith(d, llm);
    const match = await openMatch(ctx);
    await click(ctx, match.id, "player-b");
    const conv = await latestConversation("player-b");
    await reply(ctx, conv.id, "player-b", "totally forgot, my bad", "r-2");

    const assistantRow = await lastAssistantMessage(conv.id);

    const b = fakeButton(`memory:decline:${assistantRow!.id}`, "player-b", null);
    await dispatchButton(b.interaction, ctx);

    const player = await ctx.repositories.players.getByDiscordUserId(guildId, "player-b");
    const created = await db.select().from(memories).where(eq(memories.playerId, player!.id));
    expect(created).toHaveLength(0);
    const [updatePayload] = b.update.mock.calls[0] as unknown as [{ content: string }];
    expect(updatePayload.content).toContain("Okay, I won't remember that.");
  });

  it("plan section 44: another player can't decide someone else's candidate", async () => {
    const d = fakeDiscord();
    let turn = 0;
    const { llm } = fakeLlm(({ system }) => {
      turn++;
      if (system.includes("TURN: OPENING")) return json("What happened?", true);
      return json("Noted.", false, { type: "HABIT", content: "some private fact" });
    });
    const ctx = ctxWith(d, llm);
    const match = await openMatch(ctx);
    await click(ctx, match.id, "player-a");
    const conv = await latestConversation("player-a");
    await reply(ctx, conv.id, "player-a", "reasons", "r-3");
    const assistantRow = await lastAssistantMessage(conv.id);

    const playerA = await ctx.repositories.players.getByDiscordUserId(guildId, "player-a");
    const before = await db.select().from(memories).where(eq(memories.playerId, playerA!.id));

    // player-b tries to approve player-a's candidate.
    const b = fakeButton(`memory:remember:${assistantRow!.id}`, "player-b", null);
    await dispatchButton(b.interaction, ctx);
    expect(b.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringMatching(/couldn't find/i) }));
    expect(b.update).not.toHaveBeenCalled();

    // No new memory for player-a came out of the forbidden attempt — in
    // particular, never the candidate's own content ("some private fact").
    const after = await db.select().from(memories).where(eq(memories.playerId, playerA!.id));
    expect(after).toHaveLength(before.length);
    expect(after.some((m) => m.content === "some private fact")).toBe(false);
  });

  it("plan section 9: memory_usage_enabled = false drops the candidate entirely — no PENDING row, no buttons, even if the model tries anyway", async () => {
    const d = fakeDiscord();
    let turn = 0;
    const { llm } = fakeLlm(({ system }) => {
      turn++;
      if (system.includes("TURN: OPENING")) return json("What happened?", true);
      // A misbehaving model ignores the "Memory usage: disabled" data line.
      return json("Okay!", false, { type: "HABIT", content: "should never be stored" });
    });
    const ctx = ctxWith(d, llm);
    const match = await openMatch(ctx);
    await click(ctx, match.id, "player-nomem");
    const conv = await latestConversation("player-nomem");
    await reply(ctx, conv.id, "player-nomem", "whatever", "r-4");

    expect(d.edits).toHaveLength(0);
    const assistantRow = await lastAssistantMessage(conv.id);
    expect(assistantRow!.memoryCandidate).toBeNull();
    expect(assistantRow!.memoryCandidateStatus).toBeNull();
  });

  it("/memories lists the approved fact under its category with a delete button, and the button removes it", async () => {
    const d = fakeDiscord();
    let turn = 0;
    const { llm } = fakeLlm(({ system }) => {
      turn++;
      if (system.includes("TURN: OPENING")) return json("What happened?", true);
      return json("Got it.", false, { type: "MATCH_EVENT", content: "Omar had a family thing come up." });
    });
    const ctx = ctxWith(d, llm);
    const match = await openMatch(ctx);
    await click(ctx, match.id, "player-b");
    const conv = await latestConversation("player-b");
    await reply(ctx, conv.id, "player-b", "family thing", "r-5");
    const assistantRow = await lastAssistantMessage(conv.id);
    // Approve it via the button flow, same as the happy-path test above.
    await dispatchButton(fakeButton(`memory:remember:${assistantRow!.id}`, "player-b", null).interaction, ctx);

    const cmd = fakeCommand(guildId, "player-b");
    await memoriesCommand.execute(cmd.interaction, ctx);
    expect(cmd.reply).toHaveBeenCalledTimes(1);
    const [payload] = cmd.reply.mock.calls[0] as unknown as [{ content: string; components: unknown[]; ephemeral: boolean }];
    expect(payload.ephemeral).toBe(true);
    expect(payload.content).toContain("Match events");
    expect(payload.content).toContain("Omar had a family thing come up.");
    expect(payload.components).toHaveLength(1);

    const player = await ctx.repositories.players.getByDiscordUserId(guildId, "player-b");
    const [memory] = await db.select().from(memories).where(eq(memories.playerId, player!.id));

    const delBtn = fakeButton(`memory:del:${memory!.id}`, "player-b", guildId);
    await dispatchButton(delBtn.interaction, ctx);
    expect(delBtn.update).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringMatching(/forgotten/i) }));
    expect(await db.select().from(memories).where(eq(memories.id, memory!.id))).toHaveLength(0);
    // Cascade: evidence goes with it.
    expect(await db.select().from(memoryEvidence).where(eq(memoryEvidence.memoryId, memory!.id))).toHaveLength(0);
  });

  it("a player with nothing remembered gets a plain message, not an empty list", async () => {
    const d = fakeDiscord();
    const ctx = ctxWith(d, null);
    await ctx.repositories.players.upsertByDiscordUserId(guildId, "player-empty", { ...profile, displayName: "Fresh" });
    const cmd = fakeCommand(guildId, "player-empty");
    await memoriesCommand.execute(cmd.interaction, ctx);
    const [payload] = cmd.reply.mock.calls[0] as unknown as [{ content: string }];
    expect(payload.content).toMatch(/don't have anything remembered/i);
  });
});
