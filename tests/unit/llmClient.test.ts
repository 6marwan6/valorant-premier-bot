import { describe, expect, it, vi } from "vitest";
import { LlmError, OpenAiCompatibleLlmClient, createLlmClient } from "../../src/services/ai/llmClient.js";

const baseConfig = {
  apiKey: "k",
  baseUrl: "https://api.example.com/v1/",
  model: "m1",
  extraBody: {},
  timeoutMs: 50,
  maxTokens: 256,
};

function okResponse(content: unknown, extra: object = {}) {
  return new Response(JSON.stringify({ model: "m1", choices: [{ message: { content } }], usage: { prompt_tokens: 7, completion_tokens: 3 }, ...extra }), {
    status: 200,
  });
}

describe("OpenAiCompatibleLlmClient", () => {
  it("posts an OpenAI-style chat completion and maps the result", async () => {
    const fetchImpl = vi.fn(async () => okResponse("hello"));
    const client = new OpenAiCompatibleLlmClient({ ...baseConfig, extraBody: { reasoning_effort: "low" }, fetchImpl: fetchImpl as never });

    const result = await client.complete({ system: "sys", user: "usr" });

    expect(result).toEqual({ text: "hello", model: "m1", inputTokens: 7, outputTokens: 3 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer k");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      model: "m1",
      max_tokens: 256,
      reasoning_effort: "low",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "usr" },
      ],
    });
  });

  it("lets LLM_EXTRA_BODY override defaults", async () => {
    const fetchImpl = vi.fn(async () => okResponse("x"));
    const client = new OpenAiCompatibleLlmClient({ ...baseConfig, extraBody: { temperature: 0.2 }, fetchImpl: fetchImpl as never });
    await client.complete({ system: "s", user: "u" });
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.temperature).toBe(0.2);
  });

  it("throws LlmError(http) on non-2xx without leaking the body", async () => {
    const client = new OpenAiCompatibleLlmClient({
      ...baseConfig,
      fetchImpl: (async () => new Response("secret provider detail", { status: 429 })) as never,
    });
    const err = await client.complete({ system: "s", user: "u" }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err).toMatchObject({ kind: "http", status: 429 });
    expect(err.message).not.toContain("secret");
  });

  it("throws LlmError(empty) when content is missing or blank (e.g. thinking ate max_tokens)", async () => {
    for (const content of [null, "", "   ", undefined]) {
      const client = new OpenAiCompatibleLlmClient({ ...baseConfig, fetchImpl: (async () => okResponse(content)) as never });
      await expect(client.complete({ system: "s", user: "u" })).rejects.toMatchObject({ kind: "empty" });
    }
  });

  it("aborts a stalled request after timeoutMs", async () => {
    const fetchImpl = (async (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      })) as never;
    const client = new OpenAiCompatibleLlmClient({ ...baseConfig, fetchImpl });
    await expect(client.complete({ system: "s", user: "u" })).rejects.toMatchObject({ kind: "timeout" });
  });

  it("wraps network failures", async () => {
    const client = new OpenAiCompatibleLlmClient({
      ...baseConfig,
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as never,
    });
    await expect(client.complete({ system: "s", user: "u" })).rejects.toMatchObject({ kind: "network" });
  });
});

describe("createLlmClient", () => {
  const env = { LLM_API_KEY: "k", LLM_BASE_URL: "https://x/v1", LLM_MODEL: "m", LLM_EXTRA_BODY: undefined, LLM_TIMEOUT_MS: 1000, LLM_MAX_TOKENS: 100 };

  it("returns null unless key, base URL and model are all set", () => {
    expect(createLlmClient({ ...env, LLM_API_KEY: undefined })).toBeNull();
    expect(createLlmClient({ ...env, LLM_BASE_URL: undefined })).toBeNull();
    expect(createLlmClient({ ...env, LLM_MODEL: undefined })).toBeNull();
    expect(createLlmClient(env)?.model).toBe("m");
  });

  it("disables AI (and logs) instead of throwing on malformed LLM_EXTRA_BODY", () => {
    const logger = { error: vi.fn(), warn: vi.fn() };
    expect(createLlmClient({ ...env, LLM_EXTRA_BODY: "{nope" }, logger)).toBeNull();
    expect(createLlmClient({ ...env, LLM_EXTRA_BODY: "[1]" }, logger)).toBeNull();
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it("accepts a JSON object for LLM_EXTRA_BODY", () => {
    expect(createLlmClient({ ...env, LLM_EXTRA_BODY: '{"reasoning_effort":"low"}' })).not.toBeNull();
  });
});
