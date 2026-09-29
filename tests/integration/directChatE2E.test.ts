import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatInputCommandInteraction } from "discord.js";
import { eq, isNull } from "drizzle-orm";
import type { Pool } from "pg";
import { createDatabase, type Database } from "../../src/database/client.js";
import { buildAppContext, type AppContext } from "../../src/appContext.js";
import type { DiscordChannelMessage, DiscordRestClient, ReplyPayload } from "../../src/discord/discordRest.js";
import { dispatchCommand } from "../../src/discord/interactions/dispatchCommand.js";
import { dispatchButton } from "../../src/discord/interactions/dispatchButton.js";
import { handleConsoleReplyModal } from "../../src/discord/consoleConversation.js";
import { logger } from "../../src/config/logger.js";
import type { LlmClient } from "../../src/services/ai/llmClient.js";
import { MAX_PLAYER_TURNS } from "../../src/modules/ai/conversationContextBuilder.js";
import { aiConversations, aiMessages } from "../../src/database/schema/aiConversations.js";
import { memories } from "../../src/database/schema/memories.js";
import type { ButtonInteraction } from "discord.js";
import { InteractionType } from "discord-api-types/v10";

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

// ---------------------------------------------------------------- fakes

function fakeDiscord(opts: { dmFails?: boolean } = {}) {
  let nextId = 200_000_000_000_000_000n;
  const channels = new Map<string, Array<DiscordChannelMessage & { components?: unknown[] }>>();
  const mentions: Array<{ channelId: string; text: string; userId: string }> = [];
  const channelMessages: ReplyPayload[] = [];

  const discord = {
    createDmChannel: vi.fn(async (userId: string) => {
      if (opts.dmFails) throw Object.assign(new Error("Cannot send messages to this user"), { code: 50007 });
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
      const list = channels.get(channelId) ?? [];
      const msg = list.find((m) => m.id === messageId);
      if (msg) Object.assign(msg, { content: payload.content ?? "", components: payload.components });
    }),
    editOriginalInteractionResponse: vi.fn(async () => undefined),
    sendInteractionFollowup: vi.fn(async () => undefined),
    sendChannelMessage: vi.fn(async (_channelId: string, payload: ReplyPayload) => {
      channelMessages.push(payload);
      return { id: String(++nextId) };
    }),
    sendMentionMessage: vi.fn(async (channelId: string, text: string, userId: string) => {
      mentions.push({ channelId, text, userId });
    }),
  };

  return {
    discord: discord as unknown as DiscordRestClient,
    raw: discord,
    mentions,
    channelMessages,
    dm(userId: string) {
      return channels.get(`dm-${userId}`) ?? [];
    },
  };
}

type FakeDiscord = ReturnType<typeof fakeDiscord>;

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
  return { llm };
}

const json = (
  response: string,
  follow = false,
  candidate: { type: string; content: string; requires_confirmation: boolean } | null = null,
) =>
  JSON.stringify({ response, should_follow_up: follow, memory_candidate: candidate });

function fakeMariInteraction(guildId: string | null, userId: string, message: string, interactionId = `mari-${Date.now()}-${Math.random()}`) {
  const reply = vi.fn(async (_payload: { content: string; ephemeral?: boolean }) => undefined);
  const interaction = {
    id: interactionId,
    commandName: "mari",
    guildId,
    user: { id: userId, username: userId },
    options: {
      getString: (name: string, required?: boolean) => {
        if (name !== "message") {
          if (required) throw new Error(`unexpected required option ${name}`);
          return null;
        }
        return message;
      },
    },
    reply,
    deferred: false,
    replied: false,
    isRepliable: () => true,
  };
  return { interaction: interaction as unknown as ChatInputCommandInteraction, reply };
}

function fakeButton(customId: string, guildId: string, userId: string, displayName: string) {
  const followUp = vi.fn(async () => undefined);
  const interaction = {
    customId,
    guildId,
    user: { id: userId, username: userId, globalName: displayName },
    member: { displayName },
    update: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    followUp,
    deferred: true,
    replied: false,
    isRepliable: () => true,
  };
  return { interaction: interaction as unknown as ButtonInteraction, followUp };
}

function modalSubmit(params: { conversationId: number; userId: string; text: string; interactionId: string }) {
  return {
    id: params.interactionId,
    token: `tok-${params.interactionId}`,
    type: InteractionType.ModalSubmit,
    user: { id: params.userId, username: params.userId, global_name: params.userId },
    channel_id: `dm-${params.userId}`,
    message: { content: "previous bot message\n\n-# 💬 Tap **Reply** to answer" },
    data: {
      custom_id: `console:modal:${params.conversationId}`,
      components: [{ type: 18, component: { type: 4, custom_id: "reply", value: params.text } }],
    },
  } as never;
}

// ---------------------------------------------------------------- suite

describeIfDb("/mari — direct chat with Mari (plan section 63's `/ai`, pulled forward, 2026-09-28)", () => {
  let db: Database;
  let pool: Pool;
  const guildId = `direct-chat-guild-${Date.now()}`;

  function ctxWith(discord: FakeDiscord, llm: LlmClient | null): AppContext {
    return buildAppContext({ discord: discord.discord, db, env: {} as never, logger, llm });
  }

  const profile = {
    displayName: "Ahmed",
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
    const boot = ctxWith(fakeDiscord(), null);
    await boot.repositories.serverConfig.upsert(guildId, { timezone: "Africa/Cairo", matchChannelId: "chan" });
    await boot.repositories.players.upsertByDiscordUserId(guildId, "player-a", profile);
  });

  afterAll(async () => {
    await pool.end();
  });

  // Fresh open-conversation slate per test — same reasoning as phase7's suite.
  beforeEach(async () => {
    await db.update(aiConversations).set({ endedAt: new Date(), endReason: "COMPLETED" }).where(isNull(aiConversations.endedAt));
  });

  async function openDirectChat(userId = "player-a") {
    const player = await new (await import("../../src/database/repositories/playerRepository.js")).PlayerRepository(db).getByDiscordUserId(
      guildId,
      userId,
    );
    const rows = await db
      .select()
      .from(aiConversations)
      .where(eq(aiConversations.playerId, player!.id))
      .orderBy(aiConversations.id);
    // Every prior test's DIRECT_CHAT row for this player is still in the
    // table (beforeEach only ENDS them, per the suite-wide convention —
    // see phase7's own openConversation helper), and unlike CONSOLE there
    // is no per-match id to naturally tell them apart, so the open-ness
    // check has to be explicit here.
    return rows.filter((r) => r.matchId === null && r.mode === "DIRECT_CHAT" && r.endedAt === null);
  }

  async function transcript(conversationId: number) {
    return (await db.select().from(aiMessages).where(eq(aiMessages.conversationId, conversationId)).orderBy(aiMessages.id)).map((m) => ({
      role: m.role,
      content: m.content,
    }));
  }

  it("an unregistered Discord user gets a plain rejection — no DM, no AI call", async () => {
    const d = fakeDiscord();
    const { llm } = fakeLlm(() => json("hi"));
    const ctx = ctxWith(d, llm);
    const { interaction, reply } = fakeMariInteraction(guildId, "stranger", "hey mari");

    await dispatchCommand(interaction, ctx);

    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
    expect(llm.complete).not.toHaveBeenCalled();
    expect(d.raw.createDmChannel).not.toHaveBeenCalled();
  });

  it("the first /mari message opens a DIRECT_CHAT conversation, DMs a reply that echoes it, and replies ephemeral", async () => {
    const d = fakeDiscord();
    const { llm } = fakeLlm(() => json("Sup! What's on your mind?", true));
    const ctx = ctxWith(d, llm);

    const { interaction, reply } = fakeMariInteraction(guildId, "player-a", "yo mari, how's it going");
    await dispatchCommand(interaction, ctx);

    expect(reply).toHaveBeenCalledWith({ content: "Started a chat with Mari 👋 Check your DMs!", ephemeral: true });
    const dm = d.dm("player-a");
    expect(dm).toHaveLength(1);
    expect(dm[0]!.content).toContain("> yo mari, how's it going");
    expect(dm[0]!.content).toContain("Sup! What's on your mind?");
    expect(dm[0]!.components).toBeDefined(); // should_follow_up true -> Reply button

    const [conv] = await openDirectChat();
    expect(conv!.mode).toBe("DIRECT_CHAT");
    expect(conv!.matchId).toBeNull();
    const msgs = await transcript(conv!.id);
    expect(msgs.map((m) => m.role)).toEqual(["USER", "ASSISTANT"]);
    expect(msgs[0]!.content).toBe("yo mari, how's it going");

    // Never touches attendance or any public channel — this is a private, standalone chat.
    expect(d.mentions).toHaveLength(0);
    expect(d.raw.sendChannelMessage).not.toHaveBeenCalled();
  });

  it("a second /mari continues the SAME conversation rather than starting a new one", async () => {
    const d = fakeDiscord();
    const { llm } = fakeLlm(() => json("ok", true));
    const ctx = ctxWith(d, llm);

    await dispatchCommand(fakeMariInteraction(guildId, "player-a", "first message").interaction, ctx);
    const { interaction, reply } = fakeMariInteraction(guildId, "player-a", "second message");
    await dispatchCommand(interaction, ctx);

    expect(reply).toHaveBeenCalledWith({ content: "Sent! Check your DMs 💬", ephemeral: true });
    const open = await openDirectChat();
    expect(open).toHaveLength(1); // still just one open conversation
    const msgs = await transcript(open[0]!.id);
    expect(msgs.filter((m) => m.role === "USER").map((m) => m.content)).toEqual(["first message", "second message"]);
  });

  it("the 💬 Reply button/modal also continues a DIRECT_CHAT conversation — the delivery path is mode-agnostic", async () => {
    const d = fakeDiscord();
    const { llm } = fakeLlm(() => json("got it", true));
    const ctx = ctxWith(d, llm);

    await dispatchCommand(fakeMariInteraction(guildId, "player-a", "opening line").interaction, ctx);
    const [conv] = await openDirectChat();

    await handleConsoleReplyModal(modalSubmit({ conversationId: conv!.id, userId: "player-a", text: "via the reply button", interactionId: "dm-1" }), ctx);

    const msgs = await transcript(conv!.id);
    expect(msgs.filter((m) => m.role === "USER").map((m) => m.content)).toEqual(["opening line", "via the reply button"]);
  });

  it('replies "isn\'t available" and touches nothing when the AI is off', async () => {
    const d = fakeDiscord();
    const ctx = ctxWith(d, null);
    const { interaction, reply } = fakeMariInteraction(guildId, "player-a", "hello?");

    await dispatchCommand(interaction, ctx);

    expect(reply).toHaveBeenCalledWith({ content: "Mari isn't available right now — try again later.", ephemeral: true });
    expect(d.raw.createDmChannel).not.toHaveBeenCalled();
    expect(await openDirectChat()).toHaveLength(0); // nothing left half-open
  });

  it("closed DMs: the conversation is abandoned so a later /mari can start fresh instead of being stuck", async () => {
    const dFailing = fakeDiscord({ dmFails: true });
    const { llm: llm1 } = fakeLlm(() => json("hi", true));
    const ctxFailing = ctxWith(dFailing, llm1);
    const { interaction, reply } = fakeMariInteraction(guildId, "player-a", "hello");

    await dispatchCommand(interaction, ctxFailing);
    expect(reply).toHaveBeenCalledWith({ content: "I couldn't DM you — please allow DMs from server members, then try again.", ephemeral: true });
    expect((await openDirectChat())).toHaveLength(0); // abandoned, not left "open"

    const dWorking = fakeDiscord();
    const { llm: llm2 } = fakeLlm(() => json("hey there", true));
    const ctxWorking = ctxWith(dWorking, llm2);
    const retry = fakeMariInteraction(guildId, "player-a", "trying again");
    await dispatchCommand(retry.interaction, ctxWorking);
    expect(retry.reply).toHaveBeenCalledWith({ content: "Started a chat with Mari 👋 Check your DMs!", ephemeral: true });
  });

  it("the turn limit ends the conversation and drops the Reply button, same as CONSOLE", async () => {
    const d = fakeDiscord();
    const { llm } = fakeLlm(() => json("keep going", true)); // model always wants to continue; the backend caps it anyway
    const ctx = ctxWith(d, llm);

    await dispatchCommand(fakeMariInteraction(guildId, "player-a", "turn 1").interaction, ctx);
    const [conv] = await openDirectChat();
    for (let i = 2; i <= MAX_PLAYER_TURNS; i++) {
      await handleConsoleReplyModal(modalSubmit({ conversationId: conv!.id, userId: "player-a", text: `turn ${i}`, interactionId: `turn-${i}` }), ctx);
    }

    const ended = (await db.select().from(aiConversations).where(eq(aiConversations.id, conv!.id)))[0]!;
    expect(ended.endedAt).not.toBeNull();
    expect(ended.endReason).toBe("TURN_LIMIT");
    const last = d.dm("player-a").at(-1)!;
    expect(last.components).toEqual([]);
  });

  it("a memory candidate on the wrap-up turn auto-saves with a Forget button — the same Phase 8 pipeline, unmodified", async () => {
    const d = fakeDiscord();
    const { llm } = fakeLlm(() =>
      json("Noted, good luck!", false, { type: "PLAYER_PREFERENCE", content: "Ahmed prefers playing in the evening.", requires_confirmation: true }),
    );
    const ctx = ctxWith(d, llm);

    await dispatchCommand(fakeMariInteraction(guildId, "player-a", "I usually only play in the evening").interaction, ctx);

    const player = await new (await import("../../src/database/repositories/playerRepository.js")).PlayerRepository(db).getByDiscordUserId(guildId, "player-a");
    const saved = await db.select().from(memories).where(eq(memories.playerId, player!.id));
    expect(saved.some((m) => m.content === "Ahmed prefers playing in the evening.")).toBe(true);

    const last = d.dm("player-a").at(-1)!;
    expect(last.content).toContain("I'll remember that");
    expect(last.components).toBeDefined();
  });

  it("a DIRECT_CHAT conversation and a match's CONSOLE conversation coexist independently for the same player", async () => {
    const d = fakeDiscord();
    const { llm } = fakeLlm(({ system }) => (system.includes("TURN: OPENING") ? json("What happened?") : json("free chat reply", true)));
    const ctx = ctxWith(d, llm);

    await dispatchCommand(fakeMariInteraction(guildId, "player-a", "just chatting").interaction, ctx);

    const match = await ctx.repositories.matches.create({
      guildId,
      scheduledAt: new Date(Date.now() + 86_400_000),
      timezone: "Africa/Cairo",
    } as never);
    await ctx.services.attendance.recordAnnouncement(match.id, "chan", "msg");
    const b = fakeButton(`attendance:${match.id}:WANTS_TO_BUT_CANNOT`, guildId, "player-a", "Ahmed");
    await dispatchButton(b.interaction, ctx);

    const direct = await openDirectChat();
    const consoleRows = await db
      .select()
      .from(aiConversations)
      .where(eq(aiConversations.matchId, match.id));

    expect(direct).toHaveLength(1);
    expect(consoleRows).toHaveLength(1);
    expect(consoleRows[0]!.mode).toBe("CONSOLE");
    expect(direct[0]!.id).not.toBe(consoleRows[0]!.id);
  });
});
