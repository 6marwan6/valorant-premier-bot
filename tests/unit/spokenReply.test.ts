import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../src/config/logger.js";
import { OpenAiCompatibleLlmClient, type LlmClient } from "../../src/services/ai/llmClient.js";
import { AiService } from "../../src/modules/ai/aiService.js";
import { SPOKEN_REPLY_LINE, buildServerChatContext } from "../../src/modules/ai/conversationContextBuilder.js";
import { makePlayer } from "./helpers/aiFixtures.js";

const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
const ok = () => new Response(JSON.stringify({ model: "x", choices: [{ message: { content: "hi" } }] }), { status: 200 });
const cfg = { apiKey: "k", baseUrl: "https://api.example.com/v1", model: "big-model", extraBody: {}, timeoutMs: 1000, maxTokens: 512 };

describe("LlmRequest overrides (spoken replies)", () => {
  it("uses a per-request model and output cap when given", async () => {
    const fetchImpl = vi.fn(async () => ok());
    await new OpenAiCompatibleLlmClient({ ...cfg, fetchImpl: fetchImpl as never }).complete({ system: "s", user: "u", model: "fast-model", maxTokens: 120 });
    const body = JSON.parse(((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string));
    expect(body.model).toBe("fast-model");
    expect(body.max_tokens).toBe(120);
  });

  it("keeps the configured model and cap otherwise", async () => {
    const fetchImpl = vi.fn(async () => ok());
    await new OpenAiCompatibleLlmClient({ ...cfg, fetchImpl: fetchImpl as never }).complete({ system: "s", user: "u" });
    const body = JSON.parse(((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string));
    expect(body.model).toBe("big-model");
    expect(body.max_tokens).toBe(512);
  });
});

describe("spoken chat replies", () => {
  const player = makePlayer();
  const transcript = [{ role: "USER" as const, content: "what do you think about tonight" }];

  it("a spoken turn adds the short-and-plain data line; a typed turn does not", () => {
    const spoken = buildServerChatContext({ player, transcript, spoken: true });
    const typed = buildServerChatContext({ player, transcript });
    expect(spoken.user).toContain(SPOKEN_REPLY_LINE);
    expect(spoken.user.indexOf("REPLY MEDIUM")).toBeLessThan(spoken.user.indexOf("</application_data>"));
    expect(typed.user).not.toContain("REPLY MEDIUM");
  });

  it("passes the voice model/cap to the LLM, still validates the output, and a typed turn passes none", async () => {
    const complete = vi.fn(async () => ({ text: JSON.stringify({ response: "ok then" }), model: "fast", inputTokens: 1, outputTokens: 1 }));
    const llm = { model: "big", complete } as unknown as LlmClient;
    const service = new AiService(llm, noopLogger);
    const base = { player, match: null, chatMode: "SERVER_CHAT" as const, conversationId: 1, transcript };

    const spoken = await service.respondInConversation({ ...base, voice: { model: "fast", maxTokens: 150 } });
    expect(spoken.source === "ai" && spoken.text).toBe("ok then");
    expect(complete).toHaveBeenLastCalledWith(expect.objectContaining({ model: "fast", maxTokens: 150 }));
    expect((complete.mock.calls[0] as unknown as [{ user: string }])[0].user).toContain("REPLY MEDIUM");

    await service.respondInConversation(base);
    expect(complete).toHaveBeenLastCalledWith(expect.objectContaining({ model: undefined, maxTokens: undefined }));
    expect((complete.mock.calls[1] as unknown as [{ user: string }])[0].user).not.toContain("REPLY MEDIUM");
  });

  it("a spoken reply that trips a protected topic is rejected just like a typed one (nothing unvalidated gets spoken)", async () => {
    const llm = { model: "big", complete: vi.fn(async () => ({ text: JSON.stringify({ response: "how is your family doing" }), model: "m", inputTokens: 1, outputTokens: 1 })) } as unknown as LlmClient;
    const out = await new AiService(llm, noopLogger).respondInConversation({
      player: makePlayer({ protectedTopics: ["family"] }),
      match: null, chatMode: "SERVER_CHAT", conversationId: 1, transcript,
      voice: {},
    });
    expect(out.source).toBe("fallback");
  });
});

describe("replies follow the player's language (English or Arabic)", () => {
  it("typed and spoken chat contexts both carry the language rule, inside the data block", async () => {
    const { LANGUAGE_LINE } = await import("../../src/modules/ai/conversationContextBuilder.js");
    const transcript = [{ role: "USER" as const, content: "ازيك يا ماري" }];
    for (const spoken of [false, true]) {
      const ctx = buildServerChatContext({ player: makePlayer(), transcript, spoken });
      expect(ctx.user).toContain(LANGUAGE_LINE);
      expect(ctx.user.indexOf(LANGUAGE_LINE)).toBeLessThan(ctx.user.indexOf("</application_data>"));
    }
    expect(LANGUAGE_LINE).toMatch(/Arabic/);
    expect(LANGUAGE_LINE).toMatch(/protected-topics rule applies in every language/);
  });
});
