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

/** Same shape as phase7ConversationE2E.test.ts's fakeDiscord, plus editChannelMessage (Phase 8's follow-up button edit) and sendMentionMessage (the public CELEBRATE/ROAST post — needed for Phase 9's public-audience retrieval tests below). */
function fakeDiscord() {
  let nextId = 200_000_000_000_000_000n;
  const channels = new Map<string, Array<DiscordChannelMessage & { components?: unknown[] }>>();
  const edits: Array<{ channelId: string; messageId: string; payload: ReplyPayload }> = [];
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
    editChannelMessage: vi.fn(async (channelId: string, messageId: string, payload: ReplyPayload) => {
      edits.push({ channelId, messageId, payload });
      const list = channels.get(channelId) ?? [];
      const msg = list.find((m) => m.id === messageId);
      if (msg) {
        msg.content = payload.content ?? msg.content;
        msg.components = payload.components;
      }
    }),
    sendMentionMessage: vi.fn(async (channelId: string, text: string, discordUserId: string) => {
      mentions.push({ channelId, text, discordUserId });
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
    mentions,
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

function fakeButton(customId: string, userId: string, guildId: string | null = null, messageContent = "") {
  const followUp = vi.fn(async () => undefined);
  const update = vi.fn(async () => undefined);
  const interaction = {
    customId,
    guildId,
    user: { id: userId, username: userId, globalName: userId },
    message: { content: messageContent },
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

describeIfDb("Phase 8 — memory auto-save, storage, and /memories (integration)", () => {
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
      scheduledAt: new Date(Date.now() + 86_400_000 + ++seq * 60_000), // unique per call: the instant is the only dedup key now
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
    // ORDER BY is essential: without it Postgres returns rows in heap order, which shifts once earlier
    // tests UPDATE (end) their conversations — so "last" could be an old, already-ended conversation.
    const rows = await db.select().from(aiConversations).where(eq(aiConversations.playerId, player!.id)).orderBy(desc(aiConversations.id)).limit(1);
    return rows[0]!;
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

  it("a wrap-up candidate is saved automatically, and the DM gets a follow-up edit adding a single Forget button (plan section 21, revised)", async () => {
    const d = fakeDiscord();
    let turn = 0;
    const { llm } = fakeLlm(({ system }) => {
      turn++;
      if (system.includes("TURN: OPENING")) return json("What happened?", true);
      return json("Go destroy that exam.", false, {
        type: "MATCH_EVENT",
        content: "Ahmed had an exam that prevented him from playing.",
      });
    });
    const ctx = ctxWith(d, llm);
    const match = await openMatch(ctx);
    await click(ctx, match.id, "player-a");
    const conv = await latestConversation("player-a");

    await reply(ctx, conv.id, "player-a", "I have an exam tomorrow.", "r-1");

    // The DM went out once, then got a follow-up edit adding the note +
    // Forget button — never a race where the memory's own id had to exist
    // before the reply reached the player.
    expect(d.dm("player-a")).toHaveLength(2);
    expect(d.edits).toHaveLength(1);
    const wrapUp = d.dm("player-a")[1]!;
    expect(wrapUp.content).toContain("Go destroy that exam.");
    expect(wrapUp.content).toMatch(/noted/i);
    expect(wrapUp.components).toHaveLength(1);

    // Saved the same turn — no player decision to wait for anymore.
    const assistantRow = await lastAssistantMessage(conv.id);
    expect(assistantRow!.memoryCandidateStatus).toBe("APPROVED");

    const player = await ctx.repositories.players.getByDiscordUserId(guildId, "player-a");
    const created = await db.select().from(memories).where(eq(memories.playerId, player!.id));
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

    // The Forget button's custom_id points at the real memory row, and
    // works from the DM it's actually sent in (no guildId — plan section
    // 44's ownership check has to resolve without one).
    const forgetRow = wrapUp.components![0] as { toJSON: () => { components: Array<{ custom_id: string }> } };
    expect(forgetRow.toJSON().components.map((c) => c.custom_id)).toEqual([`memory:del:${created[0]!.id}`]);

    const b = fakeButton(`memory:del:${created[0]!.id}`, "player-a", null, wrapUp.content);
    await dispatchButton(b.interaction, ctx);
    expect(b.update).toHaveBeenCalledTimes(1);
    const [updatePayload] = b.update.mock.calls[0] as unknown as [{ content: string; components: unknown[] }];
    expect(updatePayload.content).toContain("Go destroy that exam."); // original text preserved, not replaced
    expect(updatePayload.content).toMatch(/forgotten/i);
    expect(updatePayload.components).toEqual([]);
    expect(await db.select().from(memories).where(eq(memories.id, created[0]!.id))).toHaveLength(0);
  });

  it("clicking Forget a second time reports it's already gone rather than erroring", async () => {
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

    const player = await ctx.repositories.players.getByDiscordUserId(guildId, "player-b");
    const [memory] = await db.select().from(memories).where(eq(memories.playerId, player!.id));

    await dispatchButton(fakeButton(`memory:del:${memory!.id}`, "player-b", null).interaction, ctx);
    const second = fakeButton(`memory:del:${memory!.id}`, "player-b", null);
    await dispatchButton(second.interaction, ctx);
    const [updatePayload] = second.update.mock.calls[0] as unknown as [{ content: string }];
    expect(updatePayload.content).toMatch(/already gone/i);

    const stillGone = await db.select().from(memories).where(eq(memories.id, memory!.id));
    expect(stillGone).toHaveLength(0);
  });

  it("plan section 44: another player can't forget someone else's memory", async () => {
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

    const playerA = await ctx.repositories.players.getByDiscordUserId(guildId, "player-a");
    const [memory] = await db.select().from(memories).where(eq(memories.playerId, playerA!.id));

    // player-b tries to forget player-a's memory (a spoofed/crafted
    // custom_id — the server-side ownership check has to hold regardless
    // of how the click arrived, not just because the real button only
    // ever renders in player-a's own DM).
    const b = fakeButton(`memory:del:${memory!.id}`, "player-b", null);
    await dispatchButton(b.interaction, ctx);
    // Section 44 rule 4: forbidden and not-found look identical to the caller.
    const [updatePayload] = b.update.mock.calls[0] as unknown as [{ content: string }];
    expect(updatePayload.content).toMatch(/already gone/i);

    // Still there — the private fact was never removed, let alone exposed.
    const after = await db.select().from(memories).where(eq(memories.id, memory!.id));
    expect(after).toHaveLength(1);
    expect(after[0]!.content).toBe("some private fact");
  });

  it("plan section 9: memory_usage_enabled = false drops the candidate entirely — no PENDING row, no Forget button, even if the model tries anyway", async () => {
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

  it("/memories lists the auto-saved fact under its category with a delete button, and the button removes it", async () => {
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
