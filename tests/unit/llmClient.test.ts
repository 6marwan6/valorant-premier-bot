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
  const env = { LLM_API_KEY: "sk-supersecrettestkey", LLM_BASE_URL: "https://x/v1", LLM_MODEL: "m", LLM_EXTRA_BODY: undefined, LLM_TIMEOUT_MS: 1000, LLM_MAX_TOKENS: 100 };
  const fakeLogger = () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() });

  it("returns null unless key, base URL and model are all set", () => {
    expect(createLlmClient({ ...env, LLM_API_KEY: undefined })).toBeNull();
    expect(createLlmClient({ ...env, LLM_BASE_URL: undefined })).toBeNull();
    expect(createLlmClient({ ...env, LLM_MODEL: undefined })).toBeNull();
    expect(createLlmClient(env)?.model).toBe("m");
  });

  it("logs exactly which env var(s) are missing — this used to be completely silent", () => {
    const logger = fakeLogger();
    createLlmClient({ ...env, LLM_API_KEY: undefined }, logger);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "ai.config.missing", missing: ["LLM_API_KEY"] }),
      expect.stringContaining("LLM_API_KEY"),
    );

    const logger2 = fakeLogger();
    createLlmClient({ ...env, LLM_API_KEY: undefined, LLM_BASE_URL: undefined, LLM_MODEL: undefined }, logger2);
    expect(logger2.warn).toHaveBeenCalledWith(
      expect.objectContaining({ missing: ["LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL"] }),
      expect.any(String),
    );
  });

  it("never logs anything resembling the API key itself", () => {
    const logger = fakeLogger();
    createLlmClient(env, logger);
    const serialized = JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls]);
    expect(serialized).not.toContain(env.LLM_API_KEY);
  });

  it("disables AI (and logs) instead of throwing on malformed LLM_EXTRA_BODY", () => {
    const logger = fakeLogger();
    expect(createLlmClient({ ...env, LLM_EXTRA_BODY: "{nope" }, logger)).toBeNull();
    expect(createLlmClient({ ...env, LLM_EXTRA_BODY: "[1]" }, logger)).toBeNull();
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it("accepts a JSON object for LLM_EXTRA_BODY", () => {
    expect(createLlmClient({ ...env, LLM_EXTRA_BODY: '{"reasoning_effort":"low"}' })).not.toBeNull();
  });

  it("logs a one-line confirmation (model + host, no key) once AI is actually enabled", () => {
    const logger = fakeLogger();
    createLlmClient(env, logger);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "ai.config.enabled", model: "m", baseHost: "x" }),
      expect.any(String),
    );
  });

  it("works with no logger at all (logger is optional)", () => {
    expect(createLlmClient(env)).not.toBeNull();
    expect(createLlmClient({ ...env, LLM_API_KEY: undefined })).toBeNull();
  });
});
