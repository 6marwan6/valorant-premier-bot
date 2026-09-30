import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../src/config/logger.js";
import {
  MAX_CHAT_TRANSCRIPT_ENTRIES,
  buildDirectChatContext,
  buildServerChatContext,
  looksLikeForgetRequest,
} from "../../src/modules/ai/conversationContextBuilder.js";
import { parseChatOutput } from "../../src/modules/ai/aiOutput.js";
import { AiService } from "../../src/modules/ai/aiService.js";
import { isSameFact, visibilityForChat } from "../../src/modules/memories/memoryService.js";
import {
  MAX_RETRIEVED_CHAT_MEMORIES,
  MAX_RETRIEVED_MEMORIES,
  keywordOverlap,
  listEligible,
  retrieveMemories,
} from "../../src/modules/memories/memoryRetrieval.js";
import { shouldDeferPublicly } from "../../src/discord/handleDiscordInteraction.js";
import type { ServerChatFacts } from "../../src/modules/ai/teamFactsService.js";
import type { LlmClient } from "../../src/services/ai/llmClient.js";
import { makeMemory, makePlayer } from "./helpers/aiFixtures.js";

const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

describe("parseChatOutput (2026-09-29 free-form chat contract)", () => {
  it("accepts a plain reply with no candidates and no forget ids", () => {
    const r = parseChatOutput('{"response":"sup"}', []);
    expect(r).toEqual({ ok: true, value: { response: "sup", memoryCandidates: [], forgetMemoryIds: [] } });
  });

  it("keeps valid candidates on any turn, drops malformed / forbidden ones without sinking the reply", () => {
    const raw = JSON.stringify({
      response: "nice",
      memory_candidates: [
        { type: "VALORANT_PREFERENCE", content: "Ahmed mains Jett." },
        { type: "NOT_A_TYPE", content: "bad type" },
        { type: "HABIT", content: "Talks about his family a lot." },
        "garbage",
      ],
    });
    const r = parseChatOutput(raw, ["Family"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.memoryCandidates).toEqual([{ type: "VALORANT_PREFERENCE", content: "Ahmed mains Jett." }]);
  });

  it("caps candidates at 3 and forget ids at 10, ignoring non-integer ids and duplicates", () => {
    const raw = JSON.stringify({
      response: "ok",
      memory_candidates: Array.from({ length: 6 }, (_, i) => ({ type: "HABIT", content: `fact ${i}` })),
      forget_memory_ids: [1, 1, "2", 3.5, -4, ...Array.from({ length: 20 }, (_, i) => 100 + i)],
    });
    const r = parseChatOutput(raw, []);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.memoryCandidates).toHaveLength(3);
      expect(r.value.forgetMemoryIds).toHaveLength(10);
      expect(r.value.forgetMemoryIds[0]).toBe(1);
      expect(r.value.forgetMemoryIds).not.toContain(3.5);
    }
  });

  it("rejects a reply that touches a protected topic, and neutralizes @mentions", () => {
    expect(parseChatOutput('{"response":"how is your family?"}', ["Family"])).toEqual({ ok: false, reason: "protected_topic" });
    const r = parseChatOutput('{"response":"hey @everyone and <@123>"}', []);
    expect(r.ok && r.value.response).not.toMatch(/@everyone|<@123>/);
  });

  it("rejects non-JSON", () => {
    expect(parseChatOutput("just text", [])).toEqual({ ok: false, reason: "invalid_json" });
  });
});

describe("chat context builders", () => {
  const facts: ServerChatFacts = {
    roster: [{ displayName: "Omar", role: "CONTROLLER", agents: ["Omen"], preferredAgent: null }],
    nextMatch: {
      id: 7,
      scheduledAt: new Date("2026-10-02T16:00:00Z"),
      timezone: "Africa/Cairo",
      status: "CONFIRMATION_OPEN",
      playing: ["Omar"],
      cannotPlay: [],
      wantsButCannot: ["Ali"],
      noResponse: ["Hassan"],
    },
    lastMatch: { id: 6, scheduledAt: new Date("2026-09-25T16:00:00Z"), timezone: "Africa/Cairo", result: "WIN", events: [{ type: "CLUTCH", description: "1v3 on round 19", playerName: "Omar" }] },
    sharedMemories: [{ ownerName: "Omar", type: "RUNNING_JOKE", content: "Says he is him." }],
    rosterForbiddenTopics: ["Health"],
  };
  const player = makePlayer();

  it("server chat: public rules, database facts, teammates' shared memories, no should_follow_up", () => {
    const ctx = buildServerChatContext({ player, transcript: [{ role: "USER", content: "who's playing?" }], facts, forbiddenTopics: ["Family", "Health"] });
    expect(ctx.mode).toBe("SERVER_CHAT");
    expect(ctx.system).toMatch(/PUBLIC server channel/);
    expect(ctx.user).toContain("Playing: Omar");
    expect(ctx.user).toContain("No response yet: Hassan");
    expect(ctx.user).toContain("Last completed match");
    expect(ctx.user).toContain("Omar: Says he is him.");
    expect(ctx.user).toContain("- Health");
    expect(ctx.system).not.toContain("should_follow_up");
  });

  it("DM chat says it is private and never lists teammates' shared memories", () => {
    const ctx = buildDirectChatContext({ player, transcript: [{ role: "USER", content: "hey" }], facts: { ...facts, sharedMemories: [] } });
    expect(ctx.system).toMatch(/private/i);
    expect(ctx.user).not.toContain("Says he is him.");
  });

  it("only the newest transcript entries are sent, with an omitted count", () => {
    const transcript = Array.from({ length: MAX_CHAT_TRANSCRIPT_ENTRIES + 6 }, (_, i) => ({
      role: (i % 2 === 0 ? "USER" : "ASSISTANT") as "USER" | "ASSISTANT",
      content: `line-${i}`,
    }));
    const ctx = buildDirectChatContext({ player, transcript });
    expect(ctx.user).toContain("(6 earlier messages omitted)");
    expect(ctx.user).not.toContain("line-0]");
    expect(ctx.user).toContain(`line-${MAX_CHAT_TRANSCRIPT_ENTRIES + 5}`);
  });

  it("memories carry their ids; the forgettable list appears only when passed", () => {
    const m = makeMemory({ id: 4242, content: "Has an exam Sunday." });
    const without = buildDirectChatContext({ player, transcript: [{ role: "USER", content: "hi" }], memories: [m] });
    expect(without.user).toContain("[4242]");
    expect(without.user).not.toContain("MEMORIES YOU CAN FORGET");
    const withList = buildDirectChatContext({ player, transcript: [{ role: "USER", content: "forget the exam" }], memories: [m], forgetCandidates: [m] });
    expect(withList.user).toContain("MEMORIES YOU CAN FORGET");
  });

  it("looksLikeForgetRequest", () => {
    expect(looksLikeForgetRequest("please forget that I have an exam")).toBe(true);
    expect(looksLikeForgetRequest("delete what I told you about Jett")).toBe(true);
    expect(looksLikeForgetRequest("I forgot my mouse lol")).toBe(false);
    expect(looksLikeForgetRequest("what should I play")).toBe(false);
  });
});

describe("retrieval for chats", () => {
  it("uses a wider window for chat modes than for one-shot modes", () => {
    const many = Array.from({ length: 15 }, (_, i) => makeMemory({ content: `fact number ${i}`, visibility: "PRIVATE" }));
    expect(retrieveMemories({ memories: many, mode: "DIRECT_CHAT", forbiddenTopics: [] })).toHaveLength(MAX_RETRIEVED_CHAT_MEMORIES);
    expect(retrieveMemories({ memories: many, mode: "CONSOLE", forbiddenTopics: [] })).toHaveLength(MAX_RETRIEVED_MEMORIES);
  });

  it("keyword overlap floats the relevant memory up when the player's message mentions it", () => {
    const exam = makeMemory({ content: "Has an exam on Sunday.", visibility: "PRIVATE", importance: 10, createdAt: new Date("2026-01-01") });
    const filler = Array.from({ length: 12 }, (_, i) => makeMemory({ content: `Unrelated preference ${i}`, visibility: "PRIVATE", importance: 60 }));
    const top = retrieveMemories({ memories: [...filler, exam], mode: "DIRECT_CHAT", forbiddenTopics: [], queryText: "how did my exam go", limit: 3 });
    expect(top.map((m) => m.id)).toContain(exam.id);
    expect(keywordOverlap("Has an exam on Sunday.", "how did my exam go")).toBeGreaterThan(0);
    expect(keywordOverlap("Has an exam on Sunday.", undefined)).toBe(0);
  });

  it("server chat never sees PRIVATE memories; a DM chat sees TEAM and PRIVATE but never PROTECTED", () => {
    const memories = [
      makeMemory({ visibility: "PRIVATE", content: "dm secret" }),
      makeMemory({ visibility: "TEAM", content: "said in server" }),
      makeMemory({ visibility: "PUBLIC", content: "admin lore" }),
      makeMemory({ visibility: "PROTECTED", content: "fenced off" }),
    ];
    const server = listEligible({ memories, mode: "SERVER_CHAT", forbiddenTopics: [] }).map((m) => m.content).sort();
    const dm = listEligible({ memories, mode: "DIRECT_CHAT", forbiddenTopics: [] }).map((m) => m.content).sort();
    expect(server).toEqual(["admin lore", "said in server"]);
    expect(dm).toEqual(["admin lore", "dm secret", "said in server"]);
  });
});

describe("memory writer rules", () => {
  it("visibility follows where the fact was said", () => {
    expect(visibilityForChat("DIRECT_CHAT")).toBe("PRIVATE");
    expect(visibilityForChat("SERVER_CHAT")).toBe("TEAM");
  });

  it("isSameFact: exact after normalizing, or near-identical long facts; different facts are not", () => {
    expect(isSameFact("Ahmed mains Jett.", "ahmed mains jett")).toBe(true);
    expect(isSameFact("Ahmed has an exam on Sunday morning at university", "Ahmed has an exam Sunday morning at university")).toBe(true);
    expect(isSameFact("Ahmed mains Jett", "Ahmed mains Raze")).toBe(false);
  });
});

describe("AiService.respondInConversation — chat modes (2026-09-29)", () => {
  const player = makePlayer();
  const llmReturning = (text: string): LlmClient => ({
    model: "m",
    complete: vi.fn(async () => ({ text, model: "m", inputTokens: 1, outputTokens: 1 })),
  }) as unknown as LlmClient;

  it("drops candidates when Memory usage is off, regardless of what the model returned", async () => {
    const llm = llmReturning(JSON.stringify({ response: "ok", memory_candidates: [{ type: "HABIT", content: "Plays at night." }] }));
    const service = new AiService(llm, noopLogger);
    const out = await service.respondInConversation({
      player: makePlayer({ memoryUsageEnabled: false }),
      match: null,
      chatMode: "DIRECT_CHAT",
      conversationId: 1,
      transcript: [{ role: "USER", content: "I play at night" }],
    });
    expect(out.source === "ai" && out.memoryCandidates).toEqual([]);
  });

  it("forget ids are honored only when the player actually asked to forget, and only for ids that were shown", async () => {
    const shown = makeMemory({ id: 900, playerId: player.id, visibility: "PRIVATE", content: "Has an exam." });
    const hidden = makeMemory({ id: 901, playerId: player.id, visibility: "PROTECTED", content: "Fenced off." });
    const repo = { listByPlayer: vi.fn(async () => [shown, hidden]), touchLastUsed: vi.fn(async () => undefined) } as never;
    const reply = JSON.stringify({ response: "Done.", forget_memory_ids: [900, 901, 999] });

    const asked = await new AiService(llmReturning(reply), noopLogger, repo).respondInConversation({
      player, match: null, chatMode: "DIRECT_CHAT", conversationId: 1,
      transcript: [{ role: "USER", content: "forget the exam thing" }],
    });
    expect(asked.source === "ai" && asked.forgetMemoryIds).toEqual([900]);

    const notAsked = await new AiService(llmReturning(reply), noopLogger, repo).respondInConversation({
      player, match: null, chatMode: "DIRECT_CHAT", conversationId: 1,
      transcript: [{ role: "USER", content: "what should I play" }],
    });
    expect(notAsked.source === "ai" && notAsked.forgetMemoryIds).toEqual([]);
  });

  it("a server chat's prompt never contains a PRIVATE memory of the chatter", async () => {
    const priv = makeMemory({ playerId: player.id, visibility: "PRIVATE", content: "TOP-SECRET-DM-FACT" });
    const pub = makeMemory({ playerId: player.id, visibility: "TEAM", content: "Said in the server." });
    const repo = { listByPlayer: vi.fn(async () => [priv, pub]), touchLastUsed: vi.fn(async () => undefined) } as never;
    const llm = llmReturning('{"response":"hi"}');
    await new AiService(llm, noopLogger, repo).respondInConversation({
      player, match: null, chatMode: "SERVER_CHAT", conversationId: 1,
      transcript: [{ role: "USER", content: "hello" }],
    });
    const sent = (llm.complete as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { user: string };
    expect(sent.user).toContain("Said in the server.");
    expect(sent.user).not.toContain("TOP-SECRET-DM-FACT");
  });

  it("an LLM failure is a fallback, never a throw", async () => {
    const llm = { model: "m", complete: vi.fn(async () => { throw new Error("boom"); }) } as unknown as LlmClient;
    const out = await new AiService(llm, noopLogger).respondInConversation({
      player, match: null, chatMode: "SERVER_CHAT", conversationId: 1, transcript: [{ role: "USER", content: "hi" }],
    });
    expect(out).toEqual({ source: "fallback" });
  });
});

describe("/mari deferral visibility", () => {
  const mari = (options?: Array<{ name: string; value: unknown }>) =>
    ({ type: 2, data: { name: "mari", options: [{ name: "message", value: "hi" }, ...(options ?? [])] } }) as never;

  it("defers publicly by default, ephemerally with private:true, and never for other commands", () => {
    expect(shouldDeferPublicly(mari())).toBe(true);
    expect(shouldDeferPublicly(mari([{ name: "private", value: false }]))).toBe(true);
    expect(shouldDeferPublicly(mari([{ name: "private", value: true }]))).toBe(false);
    expect(shouldDeferPublicly({ type: 2, data: { name: "player" } } as never)).toBe(false);
    expect(shouldDeferPublicly({ type: 3, data: { custom_id: "x" } } as never)).toBe(false);
  });
});
