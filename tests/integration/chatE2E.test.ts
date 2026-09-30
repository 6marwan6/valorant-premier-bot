import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatInputCommandInteraction } from "discord.js";
import { and, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import type { Pool } from "pg";
import { createDatabase, type Database } from "../../src/database/client.js";
import { buildAppContext, type AppContext } from "../../src/appContext.js";
import type { DiscordChannelMessage, DiscordRestClient, ReplyPayload } from "../../src/discord/discordRest.js";
import { dispatchCommand } from "../../src/discord/interactions/dispatchCommand.js";
import { deliverConversationReply } from "../../src/discord/consoleConversation.js";
import { runServerChatTurn } from "../../src/discord/serverChat.js";
import { runDmReplyPollJob } from "../../src/services/scheduling/dmReplyPollJob.js";
import { logger } from "../../src/config/logger.js";
import type { LlmClient } from "../../src/services/ai/llmClient.js";
import { CHAT_FALLBACK_MESSAGE, CHAT_IDLE_TIMEOUT_MS } from "../../src/modules/ai/conversationService.js";
import { aiConversations, aiMessages } from "../../src/database/schema/aiConversations.js";
import { memories } from "../../src/database/schema/memories.js";
import { memoryEvidence } from "../../src/database/schema/memoryEvidence.js";
import type { PlayerRow } from "../../src/database/schema/players.js";

/**
 * 2026-09-29 — the DM chat / server chat split, end to end against a real
 * Postgres: what `/mari` (public), the gateway worker's DM path
 * (`routeDmMessage` + `deliverConversationReply`, exactly what
 * worker/gateway.ts calls) and its `@Mari` path (`runServerChatTurn`) do to
 * the database, and — the point of the split — what each audience can and
 * cannot see.
 */

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

function fakeDiscord() {
  let nextId = 300_000_000_000_000_000n;
  const dms: Array<{ channelId: string; id: string; content: string; components?: unknown[] }> = [];
  const channelReplies: Array<{ channelId: string; content: string; replyTo: string }> = [];
  const raw = {
    createDmChannel: vi.fn(async (userId: string) => ({ id: `dm-${userId}` })),
    sendDirectMessage: vi.fn(async (channelId: string, payload: ReplyPayload) => {
      const id = String(++nextId);
      dms.push({ channelId, id, content: payload.content ?? "", components: payload.components });
      return { id };
    }),
    editChannelMessage: vi.fn(async () => undefined),
    editOriginalInteractionResponse: vi.fn(async () => undefined),
    sendInteractionFollowup: vi.fn(async () => undefined),
    deleteOriginalInteractionResponse: vi.fn(async () => undefined),
    sendChannelReply: vi.fn(async (channelId: string, payload: ReplyPayload, replyTo: string) => {
      channelReplies.push({ channelId, content: payload.content ?? "", replyTo });
      return { id: String(++nextId) };
    }),
    listChannelMessages: vi.fn(async (): Promise<DiscordChannelMessage[]> => []),
  };
  return { discord: raw as unknown as DiscordRestClient, raw, dms, channelReplies };
}
type FakeDiscord = ReturnType<typeof fakeDiscord>;

const chatJson = (response: string, candidates: Array<{ type: string; content: string }> = [], forget: number[] = []) =>
  JSON.stringify({ response, memory_candidates: candidates, forget_memory_ids: forget });

function fakeLlm(impl: (input: { system: string; user: string }) => string) {
  const llm = {
    model: "fake",
    complete: vi.fn(async (req: { system: string; user: string }) => ({ text: impl(req), model: "fake", inputTokens: 1, outputTokens: 1 })),
  } as unknown as LlmClient & { complete: ReturnType<typeof vi.fn> };
  const lastUser = () => (llm.complete.mock.calls.at(-1)![0] as { user: string }).user;
  return { llm, lastUser };
}

function mariInteraction(guildId: string, userId: string, message: string, id = `mari-${Math.random()}`) {
  const reply = vi.fn(async (_p: { content: string; ephemeral?: boolean }) => undefined);
  const editReply = vi.fn(async (_p: { content: string; suppressMentions?: boolean }) => undefined);
  const interaction = {
    id,
    commandName: "mari",
    guildId,
    user: { id: userId, username: userId },
    options: {
      getString: (n: string) => (n === "message" ? message : null),
      getBoolean: () => null, // private option omitted -> public server chat
    },
    reply,
    editReply,
    deferred: true,
    replied: false,
    isRepliable: () => true,
  };
  return { interaction: interaction as unknown as ChatInputCommandInteraction, reply, editReply };
}

describeIfDb("DM chat / server chat (2026-09-29)", () => {
  let db: Database;
  let pool: Pool;
  const guildId = `chat-guild-${Date.now()}`;
  let ahmed: PlayerRow;
  let omar: PlayerRow;
  let retired: PlayerRow;

  const ctxWith = (d: FakeDiscord, llm: LlmClient | null): AppContext =>
    buildAppContext({ discord: d.discord, db, env: { GATEWAY_WORKER: true } as never, logger, llm });

  const profile = {
    role: "DUELIST" as const,
    agents: ["Jett"],
    preferredAgent: "Jett",
    roastIntensity: 50,
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
    const boot = buildAppContext({ discord: fakeDiscord().discord, db, env: {} as never, logger, llm: null });
    await boot.repositories.serverConfig.upsert(guildId, { timezone: "Africa/Cairo", matchChannelId: "chan" });
    ahmed = (await boot.repositories.players.upsertByDiscordUserId(guildId, "u-ahmed", { ...profile, displayName: "Ahmed" })).player;
    omar = (await boot.repositories.players.upsertByDiscordUserId(guildId, "u-omar", { ...profile, displayName: "Omar", protectedTopics: ["Health"] })).player;
    retired = (await boot.repositories.players.upsertByDiscordUserId(guildId, "u-retired", { ...profile, displayName: "Retired" })).player;
    const { players } = await import("../../src/database/schema/players.js");
    await db.update(players).set({ active: false }).where(eq(players.id, retired.id));
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await db.update(aiConversations).set({ endedAt: new Date(), endReason: "COMPLETED" }).where(isNull(aiConversations.endedAt));
    await db.delete(memories).where(inArray(memories.playerId, [ahmed.id, omar.id]));
  });

  async function memoriesOf(player: PlayerRow) {
    return db.select().from(memories).where(eq(memories.playerId, player.id));
  }

  /** What worker/gateway.ts does for a typed DM: route it, then deliver the reply. */
  async function workerDm(ctx: AppContext, player: PlayerRow, text: string, messageId: string, now?: Date) {
    const routed = await ctx.services.conversations.routeDmMessage({
      guildId,
      player,
      dmChannelId: `dm-${player.discordUserId}`,
      discordMessageId: messageId,
      text,
      now,
    });
    if (routed.kind === "routed" && routed.outcome.kind === "reply") {
      await deliverConversationReply(ctx, { conversation: routed.outcome.conversation, dmChannelId: `dm-${player.discordUserId}`, outcome: routed.outcome });
    }
    return routed;
  }

  // ------------------------------------------------------------ server chat

  it("/mari answers publicly through the interaction (never a DM), as a SERVER_CHAT, and saves what the player said as TEAM", async () => {
    const d = fakeDiscord();
    const { llm } = fakeLlm(() => chatJson("Jett main, respect.", [{ type: "VALORANT_PREFERENCE", content: "Ahmed mains Jett." }]));
    const ctx = ctxWith(d, llm);
    const { interaction, editReply, reply } = mariInteraction(guildId, "u-ahmed", "I main Jett btw");

    await dispatchCommand(interaction, ctx);

    expect(editReply).toHaveBeenCalledWith({ content: "Jett main, respect.", suppressMentions: true });
    expect(reply).not.toHaveBeenCalled();
    expect(d.raw.sendDirectMessage).not.toHaveBeenCalled();

    const [conv] = await db.select().from(aiConversations).where(and(eq(aiConversations.playerId, ahmed.id), isNull(aiConversations.endedAt)));
    expect(conv!.mode).toBe("SERVER_CHAT");
    expect(conv!.matchId).toBeNull();

    const saved = await memoriesOf(ahmed);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ visibility: "TEAM", type: "VALORANT_PREFERENCE", confidence: 1, aiUsable: true });
    expect(saved[0]!.content).toBe("Ahmed mains Jett.");
    // Silent: the public reply carries no notice.
    expect(editReply.mock.calls[0]![0].content).not.toMatch(/remember|noted|forget/i);
  });

  it("a second /mari continues the same server conversation; the model can't end it", async () => {
    const d = fakeDiscord();
    const { llm } = fakeLlm(() => chatJson("ok"));
    const ctx = ctxWith(d, llm);
    await dispatchCommand(mariInteraction(guildId, "u-ahmed", "one").interaction, ctx);
    await dispatchCommand(mariInteraction(guildId, "u-ahmed", "two").interaction, ctx);
    const open = await db.select().from(aiConversations).where(and(eq(aiConversations.playerId, ahmed.id), isNull(aiConversations.endedAt)));
    expect(open).toHaveLength(1);
    const msgs = await db.select().from(aiMessages).where(eq(aiMessages.conversationId, open[0]!.id));
    expect(msgs.filter((m) => m.role === "USER").map((m) => m.content)).toEqual(["one", "two"]);
  });

  it("only ACTIVE roster players are answered — a soft-removed player gets a private refusal and no AI call", async () => {
    const d = fakeDiscord();
    const { llm } = fakeLlm(() => chatJson("hi"));
    const ctx = ctxWith(d, llm);
    const { interaction, reply, editReply } = mariInteraction(guildId, "u-retired", "hello?");
    await dispatchCommand(interaction, ctx);
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
    expect(editReply).not.toHaveBeenCalled();
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it("server chat context: admin PUBLIC lore + teammates' TEAM memories + the chatter's own TEAM memories are visible; every PRIVATE one is not", async () => {
    const d = fakeDiscord();
    const { llm, lastUser } = fakeLlm(() => chatJson("ok"));
    const ctx = ctxWith(d, llm);
    const m = ctx.services.memories;
    await m.createFromAdminEntry({ playerId: ahmed.id, type: "RUNNING_JOKE", content: "ADMIN-LORE-AHMED says he is him.", visibility: "PUBLIC", adminDiscordUserId: "admin" });
    await ctx.repositories.memories.create({ playerId: ahmed.id, type: "HABIT", content: "AHMED-SERVER-TEAM-FACT", confidence: 1, visibility: "TEAM", aiUsable: true, evidence: [] });
    await ctx.repositories.memories.create({ playerId: ahmed.id, type: "HABIT", content: "AHMED-DM-PRIVATE-SECRET", confidence: 1, visibility: "PRIVATE", aiUsable: true, evidence: [] });
    await ctx.repositories.memories.create({ playerId: omar.id, type: "TEAM_JOKE", content: "OMAR-TEAM-JOKE", confidence: 1, visibility: "TEAM", aiUsable: true, evidence: [] });
    await ctx.repositories.memories.create({ playerId: omar.id, type: "HABIT", content: "OMAR-PRIVATE-SECRET", confidence: 1, visibility: "PRIVATE", aiUsable: true, evidence: [] });
    await ctx.repositories.memories.create({ playerId: omar.id, type: "HABIT", content: "OMAR-PROTECTED-FACT", confidence: 1, visibility: "PROTECTED", aiUsable: true, evidence: [] });

    await dispatchCommand(mariInteraction(guildId, "u-ahmed", "what do you know about the team?").interaction, ctx);
    const prompt = lastUser();

    expect(prompt).toContain("ADMIN-LORE-AHMED");
    expect(prompt).toContain("AHMED-SERVER-TEAM-FACT");
    expect(prompt).toContain("OMAR-TEAM-JOKE");
    expect(prompt).not.toContain("AHMED-DM-PRIVATE-SECRET");
    expect(prompt).not.toContain("OMAR-PRIVATE-SECRET");
    expect(prompt).not.toContain("OMAR-PROTECTED-FACT");
    // Public room -> everyone's protected topics apply, not just the chatter's.
    expect(prompt).toContain("- Family");
    expect(prompt).toContain("- Health");
    expect(prompt).toContain("Roster:");
  });

  it("server chat can't forget a PRIVATE (DM-learned) memory: it is never shown to the model, so a guessed id is ignored", async () => {
    const d = fakeDiscord();
    const priv = await buildAppContext({ discord: d.discord, db, env: {} as never, logger, llm: null }).repositories.memories.create({
      playerId: ahmed.id, type: "HABIT", content: "Told Mari privately he hates mornings.", confidence: 1, visibility: "PRIVATE", aiUsable: true, evidence: [],
    });
    const { llm, lastUser } = fakeLlm(() => chatJson("Done, forgotten.", [], [priv.id]));
    const ctx = ctxWith(d, llm);
    await dispatchCommand(mariInteraction(guildId, "u-ahmed", "forget everything you know about me").interaction, ctx);
    expect(lastUser()).not.toContain("hates mornings");
    expect(await memoriesOf(ahmed)).toHaveLength(1); // still there
  });

  it("@Mari (worker path): replies threaded to the message, records the reply, and is idempotent for the same Discord message", async () => {
    const d = fakeDiscord();
    const { llm } = fakeLlm(() => chatJson("Present."));
    const ctx = ctxWith(d, llm);
    const run = () =>
      runServerChatTurn(ctx, {
        guildId,
        player: ahmed,
        text: "you there?",
        sourceRef: "message:9001",
        deliver: async (text) => {
          await d.discord.sendChannelReply("chan", { content: text }, "9001");
        },
      });
    expect((await run()).kind).toBe("replied");
    expect((await run()).kind).toBe("ignored"); // same source_ref -> claimed already (plan section 50)
    expect(d.channelReplies).toEqual([{ channelId: "chan", content: "Present.", replyTo: "9001" }]);
    expect(llm.complete).toHaveBeenCalledTimes(1);
  });

  it("a failed post leaves no assistant row, so asking again works", async () => {
    const d = fakeDiscord();
    const { llm } = fakeLlm(() => chatJson("hi"));
    const ctx = ctxWith(d, llm);
    const failed = await runServerChatTurn(ctx, {
      guildId, player: ahmed, text: "hello", sourceRef: "message:1",
      deliver: async () => { throw new Error("discord down"); },
    });
    expect(failed.kind).toBe("failed");
    const [conv] = await db.select().from(aiConversations).where(and(eq(aiConversations.playerId, ahmed.id), isNull(aiConversations.endedAt)));
    const msgs = await db.select().from(aiMessages).where(eq(aiMessages.conversationId, conv!.id));
    expect(msgs.map((m) => m.role)).toEqual(["USER"]);
  });

  // ---------------------------------------------------------------- DM chat

  it("typing to the bot in a DM opens a DIRECT_CHAT, answers with NO Reply button (worker mode), and records PRIVATE memories silently", async () => {
    const d = fakeDiscord();
    const { llm } = fakeLlm(() => chatJson("Nice.", [{ type: "PLAYER_PREFERENCE", content: "Ahmed likes playing late at night." }]));
    const ctx = ctxWith(d, llm);

    const routed = await workerDm(ctx, ahmed, "I love playing late at night", "5001");
    expect(routed.kind).toBe("routed");

    const [conv] = await db.select().from(aiConversations).where(and(eq(aiConversations.playerId, ahmed.id), isNull(aiConversations.endedAt)));
    expect(conv).toMatchObject({ mode: "DIRECT_CHAT", matchId: null, dmChannelId: "dm-u-ahmed" });

    expect(d.dms).toHaveLength(1);
    expect(d.dms[0]!.content).toBe("Nice.");
    expect(d.dms[0]!.components ?? []).toHaveLength(0);
    expect(d.raw.editChannelMessage).not.toHaveBeenCalled();

    const saved = await memoriesOf(ahmed);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ visibility: "PRIVATE", content: "Ahmed likes playing late at night." });
  });

  it("a DM chat keeps going across many messages and remembers within the chat (transcript in the prompt)", async () => {
    const d = fakeDiscord();
    const { llm, lastUser } = fakeLlm(() => chatJson("mhm"));
    const ctx = ctxWith(d, llm);
    await workerDm(ctx, ahmed, "first thing I said", "5101");
    await workerDm(ctx, ahmed, "second thing I said", "5102");
    await workerDm(ctx, ahmed, "third thing I said", "5103");
    const open = await db.select().from(aiConversations).where(and(eq(aiConversations.playerId, ahmed.id), isNull(aiConversations.endedAt), eq(aiConversations.mode, "DIRECT_CHAT")));
    expect(open).toHaveLength(1);
    expect(lastUser()).toContain("first thing I said");
    expect(lastUser()).toContain("[M.A.R.I.] mhm");
  });

  it("the DM chat sees everything not PROTECTED — server-learned TEAM, admin PUBLIC and its own PRIVATE — but not teammates' memories", async () => {
    const d = fakeDiscord();
    const { llm, lastUser } = fakeLlm(() => chatJson("ok"));
    const ctx = ctxWith(d, llm);
    const repo = ctx.repositories.memories;
    await repo.create({ playerId: ahmed.id, type: "HABIT", content: "FROM-SERVER-TEAM", confidence: 1, visibility: "TEAM", aiUsable: true, evidence: [] });
    await repo.create({ playerId: ahmed.id, type: "HABIT", content: "FROM-ADMIN-PUBLIC", confidence: 1, visibility: "PUBLIC", aiUsable: true, evidence: [] });
    await repo.create({ playerId: ahmed.id, type: "HABIT", content: "FROM-DM-PRIVATE", confidence: 1, visibility: "PRIVATE", aiUsable: true, evidence: [] });
    await repo.create({ playerId: ahmed.id, type: "HABIT", content: "ADMIN-FENCED-PROTECTED", confidence: 1, visibility: "PROTECTED", aiUsable: true, evidence: [] });
    await repo.create({ playerId: omar.id, type: "HABIT", content: "OMARS-TEAM-FACT", confidence: 1, visibility: "TEAM", aiUsable: true, evidence: [] });

    await workerDm(ctx, ahmed, "hey", "5201");
    const prompt = lastUser();
    for (const fact of ["FROM-SERVER-TEAM", "FROM-ADMIN-PUBLIC", "FROM-DM-PRIVATE"]) expect(prompt).toContain(fact);
    expect(prompt).not.toContain("ADMIN-FENCED-PROTECTED");
    expect(prompt).not.toContain("OMARS-TEAM-FACT");
  });

  it("after 5 idle hours the next DM opens a NEW chat that starts from the memory table only — the old transcript is not carried over", async () => {
    const d = fakeDiscord();
    const { llm, lastUser } = fakeLlm(() => chatJson("noted", [{ type: "HABIT", content: "Ahmed streams on Sundays." }]));
    const ctx = ctxWith(d, llm);
    const before = (await db.select().from(aiConversations).orderBy(desc(aiConversations.id)).limit(1))[0]?.id ?? 0;
    const chatRows = () =>
      db.select().from(aiConversations).where(and(eq(aiConversations.playerId, ahmed.id), eq(aiConversations.mode, "DIRECT_CHAT"), gt(aiConversations.id, before))).orderBy(aiConversations.id);
    // Idleness is measured from the row's last activity against the real clock, so age the row in the database.
    const ageChat = (id: number, ms: number) =>
      db.update(aiConversations).set({ lastActivityAt: new Date(Date.now() - ms) }).where(eq(aiConversations.id, id));

    await workerDm(ctx, ahmed, "OLD-TRANSCRIPT-LINE I stream on Sundays", "5301");
    const [first] = await chatRows();

    // Just under 5 hours of silence: still the same chat, transcript intact.
    await ageChat(first!.id, CHAT_IDLE_TIMEOUT_MS - 60_000);
    await workerDm(ctx, ahmed, "still here", "5302");
    expect(await chatRows()).toHaveLength(1);
    expect(lastUser()).toContain("OLD-TRANSCRIPT-LINE");

    // Just over 5 hours: the old chat is closed for idleness and a fresh one starts.
    await ageChat(first!.id, CHAT_IDLE_TIMEOUT_MS + 60_000);
    await workerDm(ctx, ahmed, "back after a long break", "5303");
    const chats = await chatRows();
    expect(chats).toHaveLength(2);
    expect(chats[0]!.endReason).toBe("IDLE_TIMEOUT");
    expect(chats[1]!.endedAt).toBeNull();

    const prompt = lastUser();
    expect(prompt).not.toContain("OLD-TRANSCRIPT-LINE"); // the transcript is gone...
    expect(prompt).not.toContain("still here");
    expect(prompt).toContain("Ahmed streams on Sundays."); // ...but the fact survived, as a memory
    expect(prompt).toContain("back after a long break");
  });

  it("the same fact told twice is stored once (with a second piece of evidence); a fact told in the server after a DM gets its own TEAM copy", async () => {
    const d = fakeDiscord();
    const fact = [{ type: "VALORANT_PREFERENCE", content: "Ahmed mains Jett." }];
    const { llm } = fakeLlm(() => chatJson("ok", fact));
    const ctx = ctxWith(d, llm);

    await workerDm(ctx, ahmed, "I main Jett", "5401");
    await workerDm(ctx, ahmed, "yeah still Jett", "5402");
    let rows = await memoriesOf(ahmed);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.visibility).toBe("PRIVATE");
    expect(await db.select().from(memoryEvidence).where(eq(memoryEvidence.memoryId, rows[0]!.id))).toHaveLength(2);

    // Same fact, now said publicly: the private copy can never surface in the server, so the public statement is saved as TEAM.
    await dispatchCommand(mariInteraction(guildId, "u-ahmed", "I main Jett, everyone").interaction, ctx);
    rows = await memoriesOf(ahmed);
    expect(rows.map((r) => r.visibility).sort()).toEqual(["PRIVATE", "TEAM"]);
    // ...and saying it in the server again does not add a third.
    await dispatchCommand(mariInteraction(guildId, "u-ahmed", "seriously Jett").interaction, ctx);
    expect(await memoriesOf(ahmed)).toHaveLength(2);
  });

  it("memory usage OFF: nothing is ever saved, even if the model proposes it", async () => {
    const d = fakeDiscord();
    const { llm } = fakeLlm(() => chatJson("ok", [{ type: "HABIT", content: "Should never be stored." }]));
    const ctx = ctxWith(d, llm);
    const { players } = await import("../../src/database/schema/players.js");
    await db.update(players).set({ memoryUsageEnabled: false }).where(eq(players.id, ahmed.id));
    try {
      const off = { ...ahmed, memoryUsageEnabled: false };
      await workerDm(ctx, off, "I only play at 3am", "5501");
    } finally {
      await db.update(players).set({ memoryUsageEnabled: true }).where(eq(players.id, ahmed.id));
    }
    expect(await memoriesOf(ahmed)).toHaveLength(0);
  });

  // ------------------------------------------------------------------ forget

  it("'forget that' in a DM: the model names the id, the backend validates and deletes it, and Mari's reply is delivered", async () => {
    const d = fakeDiscord();
    const ctx0 = ctxWith(d, null);
    const target = await ctx0.repositories.memories.create({ playerId: ahmed.id, type: "MATCH_EVENT", content: "Ahmed had an exam on Sunday.", confidence: 1, visibility: "PRIVATE", aiUsable: true, evidence: [] });
    const keep = await ctx0.repositories.memories.create({ playerId: ahmed.id, type: "HABIT", content: "Ahmed streams on Fridays.", confidence: 1, visibility: "PRIVATE", aiUsable: true, evidence: [] });
    const { llm, lastUser } = fakeLlm(() => chatJson("Done — forgotten.", [], [target.id]));
    const ctx = ctxWith(d, llm);

    await workerDm(ctx, ahmed, "please forget that I have an exam", "5601");

    expect(lastUser()).toContain("MEMORIES YOU CAN FORGET");
    expect(lastUser()).toContain(`[${target.id}]`);
    const left = (await memoriesOf(ahmed)).map((m) => m.id);
    expect(left).toEqual([keep.id]);
    expect(d.dms.at(-1)!.content).toContain("Done — forgotten.");
  });

  it("a forget id that belongs to ANOTHER player is never deleted (plan section 44 rule 4)", async () => {
    const d = fakeDiscord();
    const ctx0 = ctxWith(d, null);
    const omars = await ctx0.repositories.memories.create({ playerId: omar.id, type: "HABIT", content: "Omar's own fact.", confidence: 1, visibility: "TEAM", aiUsable: true, evidence: [] });
    await ctx0.repositories.memories.create({ playerId: ahmed.id, type: "HABIT", content: "Ahmed's own fact.", confidence: 1, visibility: "PRIVATE", aiUsable: true, evidence: [] });
    const { llm } = fakeLlm(() => chatJson("Done.", [], [omars.id]));
    const ctx = ctxWith(d, llm);

    await workerDm(ctx, ahmed, "forget Omar's stuff", "5701");

    expect(await memoriesOf(omar)).toHaveLength(1);
    expect(await memoriesOf(ahmed)).toHaveLength(1);
  });

  it("defense in depth: even if a foreign id got past the prompt-level filter, the repository's ownership check refuses to delete it", async () => {
    const d = fakeDiscord();
    const ctx = ctxWith(d, null);
    const omars = await ctx.repositories.memories.create({ playerId: omar.id, type: "HABIT", content: "Omar's fact.", confidence: 1, visibility: "TEAM", aiUsable: true, evidence: [] });
    const mine = await ctx.repositories.memories.create({ playerId: ahmed.id, type: "HABIT", content: "Ahmed's fact.", confidence: 1, visibility: "PRIVATE", aiUsable: true, evidence: [] });

    const removed = await ctx.services.memories.forgetForPlayer({ playerId: ahmed.id, memoryIds: [omars.id, mine.id] });

    expect(removed).toEqual([mine.id]);
    expect(await memoriesOf(omar)).toHaveLength(1);
    expect(await memoriesOf(ahmed)).toHaveLength(0);
  });

  it("without a forget request in the message, forget ids from the model are ignored", async () => {
    const d = fakeDiscord();
    const ctx0 = ctxWith(d, null);
    const m = await ctx0.repositories.memories.create({ playerId: ahmed.id, type: "HABIT", content: "Keep me.", confidence: 1, visibility: "PRIVATE", aiUsable: true, evidence: [] });
    const { llm } = fakeLlm(() => chatJson("sure", [], [m.id]));
    await workerDm(ctxWith(d, llm), ahmed, "what should I play tonight", "5801");
    expect(await memoriesOf(ahmed)).toHaveLength(1);
  });

  // --------------------------------------------------------- failure / misc

  it("a model failure mid-chat gives a 'say that again' and the chat STAYS open (unlike CONSOLE); a protected-topic reply is treated the same", async () => {
    const d = fakeDiscord();
    let mode: "throw" | "family" | "ok" = "throw";
    const { llm } = fakeLlm(() => {
      if (mode === "throw") throw new Error("llm down");
      if (mode === "family") return chatJson("How is your family doing?");
      return chatJson("back!");
    });
    const ctx = ctxWith(d, llm);

    await workerDm(ctx, ahmed, "hello", "5901");
    expect(d.dms.at(-1)!.content).toContain(CHAT_FALLBACK_MESSAGE);
    mode = "family";
    await workerDm(ctx, ahmed, "again", "5902");
    expect(d.dms.at(-1)!.content).toContain(CHAT_FALLBACK_MESSAGE);
    mode = "ok";
    await workerDm(ctx, ahmed, "third try", "5903");
    expect(d.dms.at(-1)!.content).toBe("back!");

    const open = await db.select().from(aiConversations).where(and(eq(aiConversations.playerId, ahmed.id), isNull(aiConversations.endedAt), eq(aiConversations.mode, "DIRECT_CHAT")));
    expect(open).toHaveLength(1);
  });

  it("a player can have a DM chat and a server chat open at the same time", async () => {
    const d = fakeDiscord();
    const { llm } = fakeLlm(() => chatJson("ok"));
    const ctx = ctxWith(d, llm);
    await workerDm(ctx, ahmed, "dm hello", "6001");
    await dispatchCommand(mariInteraction(guildId, "u-ahmed", "server hello").interaction, ctx);
    const open = await db.select().from(aiConversations).where(and(eq(aiConversations.playerId, ahmed.id), isNull(aiConversations.endedAt)));
    expect(open.map((c) => c.mode).sort()).toEqual(["DIRECT_CHAT", "SERVER_CHAT"]);
  });

  it("the cron poller does not answer a message the gateway worker already handled", async () => {
    const d = fakeDiscord();
    const { llm } = fakeLlm(() => chatJson("instant reply"));
    const ctx = ctxWith(d, llm);
    await workerDm(ctx, ahmed, "typed once", "7001");
    expect(llm.complete).toHaveBeenCalledTimes(1);

    d.raw.listChannelMessages.mockResolvedValue([
      { id: "7001", content: "typed once", author: { id: "u-ahmed", bot: false } } as DiscordChannelMessage,
    ]);
    const summary = await runDmReplyPollJob(ctx);
    expect(summary.repliesSent).toBe(0);
    expect(llm.complete).toHaveBeenCalledTimes(1);
  });

  it("a DM chat closes at the backend's length cap, never earlier, and the next message starts a fresh chat", async () => {
    const d = fakeDiscord();
    const { llm } = fakeLlm(() => chatJson("ok"));
    const ctx = ctxWith(d, llm);
    const { MAX_CHAT_PLAYER_TURNS } = await import("../../src/modules/ai/conversationService.js");
    const before = (await db.select().from(aiConversations).orderBy(desc(aiConversations.id)).limit(1))[0]?.id ?? 0;
    for (let i = 1; i <= MAX_CHAT_PLAYER_TURNS; i++) await workerDm(ctx, ahmed, `msg ${i}`, `8${String(i).padStart(3, "0")}`);
    const chats = await db.select().from(aiConversations).where(and(eq(aiConversations.playerId, ahmed.id), eq(aiConversations.mode, "DIRECT_CHAT"), gt(aiConversations.id, before)));
    expect(chats).toHaveLength(1);
    expect(chats[0]!.endReason).toBe("TURN_LIMIT");
    expect(d.dms.at(-1)!.content).toMatch(/fresh chat/i);

    await workerDm(ctx, ahmed, "new chat please", "8999");
    const after = await db.select().from(aiConversations).where(and(eq(aiConversations.playerId, ahmed.id), eq(aiConversations.mode, "DIRECT_CHAT"), gt(aiConversations.id, before)));
    expect(after).toHaveLength(2);
  }, 60_000);
});
