import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "discord.js";
import type { AppContext } from "../../src/appContext.js";
import { VoiceManager, loadVoiceConfig, pickSttProvider, type VoiceConfig } from "../../worker/voice.js";

afterEach(() => vi.restoreAllMocks());

const cfgBase: VoiceConfig = {
  groqApiKey: "g1", guildId: "g", channelId: null, voice: "hannah", ttsModel: "m", direction: "", pitch: 1, language: "auto", debug: false,
  sttModel: "whisper-large-v3", deepgramApiKey: "d1", sttProvider: "deepgram", deepgramModel: "nova-3",
};
async function manager(cfg: Partial<VoiceConfig> = {}) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const m = await VoiceManager.create({} as Client, { logger, repositories: {} } as unknown as AppContext, { ...cfgBase, ...cfg });
  return { m, logger };
}
type Priv = { transcribe: (pcm: Buffer) => Promise<{ text: string | null; status: string; language?: string }> };
const t = (m: VoiceManager) => (m as unknown as Priv).transcribe(Buffer.alloc(48_000 * 4));
const json = (o: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...headers } });
const dg = (transcript: string, extra: { confidence?: number; detected_language?: string } = {}) =>
  json({ results: { channels: [{ detected_language: extra.detected_language, alternatives: [{ transcript, confidence: extra.confidence ?? 0.97 }] }] } });
const groqOk = (text: string) => json({ text, language: "english", segments: [{ no_speech_prob: 0.01, avg_logprob: -0.2 }] });
const isDg = (u: unknown) => String(u).includes("api.deepgram.com");

describe("provider choice", () => {
  it("auto: Deepgram when a key exists, else Groq; groq forces Groq", () => {
    expect(pickSttProvider(undefined, "k")).toBe("deepgram");
    expect(pickSttProvider(undefined, undefined)).toBe("groq");
    expect(pickSttProvider("groq", "k")).toBe("groq");
    expect(pickSttProvider("deepgram", undefined)).toBe("groq"); // asked for it but has no key
    expect(pickSttProvider("auto", "k1,k2")).toBe("deepgram");
  });
  it("loadVoiceConfig reads the Deepgram settings", () => {
    const cfg = loadVoiceConfig("g", { GROQ_API_KEY: "g1,g2", DEEPGRAM_API_KEY: "d1" } as NodeJS.ProcessEnv);
    expect(cfg).toMatchObject({ groqApiKey: "g1,g2", deepgramApiKey: "d1", sttProvider: "deepgram", deepgramModel: "nova-3" });
  });
});

describe("Deepgram Nova-3 speech-to-text", () => {
  it("auto language: restricts detection to English + Arabic, sends keyterms and the Token header", async () => {
    const { m } = await manager();
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => dg("مرحبا يا ماري", { detected_language: "ar" }));
    const out = await t(m);
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    const q = new URL(url).searchParams;
    expect(q.get("model")).toBe("nova-3");
    expect(q.getAll("detect_language")).toEqual(["en", "ar"]);
    expect(q.get("language")).toBeNull();
    expect(q.getAll("keyterm")).toContain("ماري");
    expect((init.headers as Record<string, string>).Authorization).toBe("Token d1");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("audio/wav");
    expect(out).toEqual({ text: "مرحبا يا ماري", status: "ok", language: "ar" });
  });

  it("a fixed language is sent as `language` (e.g. Egyptian Arabic)", async () => {
    const { m } = await manager({ language: "ar-EG" });
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => dg("ازيك"));
    const out = await t(m);
    const q = new URL((spy.mock.calls[0] as unknown as [string])[0]).searchParams;
    expect(q.get("language")).toBe("ar-EG");
    expect(q.getAll("detect_language")).toEqual([]);
    expect(out).toMatchObject({ text: "ازيك", language: "ar-EG" });
  });

  it("an empty result is final (no Groq call); low confidence is filtered like noise", async () => {
    const { m } = await manager();
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => dg(""));
    expect(await t(m)).toMatchObject({ text: null, status: "empty" });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockImplementation(async () => dg("thank you", { confidence: 0.12 }));
    expect(await t(m)).toMatchObject({ text: null, status: "filtered" });
  });

  it("when Deepgram answers 400 \"Failed to parse query string\" to the language list, it steps down to detect_language=true and REMEMBERS it", async () => {
    const { m } = await manager();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url) => (new URL(String(url)).searchParams.getAll("detect_language").length === 2 ? json({ err_code: "Bad Request", err_msg: "Bad Request: Failed to parse query string" }, 400) : dg("hello mari", { detected_language: "en" })));
    expect(await t(m)).toMatchObject({ text: "hello mari", status: "ok" });
    expect(spy).toHaveBeenCalledTimes(3); // restricted+keyterms (400), restricted (400), detect_language=true (ok)
    expect(new URL((spy.mock.calls[2] as unknown as [string])[0]).searchParams.get("detect_language")).toBe("true");
    spy.mockClear();
    expect(await t(m)).toMatchObject({ text: "hello mari", status: "ok" });
    expect(spy).toHaveBeenCalledTimes(1); // the next utterance starts from the shape that works
  });

  it("if every shape is refused it reports failed (so Whisper takes over) and starts from the top next time", async () => {
    const { m } = await manager();
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => json({ err: "bad" }, 400));
    expect(await t(m)).toMatchObject({ text: null, status: "failed" }); // (the mocked Whisper fallback is refused too)
    expect(spy.mock.calls.filter((c) => isDg(c[0]))).toHaveLength(4);
  });

  it("a 400 is retried once without keyterms", async () => {
    const { m } = await manager();
    const spy = vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => json({ err: "keyterm" }, 400)).mockImplementation(async () => dg("hello there"));
    expect(await t(m)).toMatchObject({ text: "hello there", status: "ok" });
    expect(new URL((spy.mock.calls[1] as unknown as [string])[0]).searchParams.getAll("keyterm")).toEqual([]);
  });

  it("falls back to Groq Whisper when Deepgram fails, and says so", async () => {
    const { m, logger } = await manager();
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (u) => (isDg(u) ? json({ err: "down" }, 503) : groqOk("from groq")));
    expect(await t(m)).toMatchObject({ text: "from groq", status: "ok" });
    expect(spy.mock.calls.some((c) => !isDg(c[0]))).toBe(true);
    expect(logger.warn.mock.calls.some((c) => (c[0] as { event: string }).event === "voice.stt.fallback")).toBe(true);
  });

  it("falls back to Groq on a network error too", async () => {
    const { m } = await manager();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (u) => (isDg(u) ? Promise.reject(new Error("ECONNRESET")) : groqOk("still works")));
    expect(await t(m)).toMatchObject({ text: "still works" });
  });

  it("without a Deepgram key (or provider=groq) Deepgram is never called", async () => {
    for (const cfg of [{ deepgramApiKey: undefined, sttProvider: "groq" as const }, { sttProvider: "groq" as const }]) {
      const { m } = await manager(cfg);
      const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => groqOk("plain groq"));
      await t(m);
      expect(spy.mock.calls.every((c) => !isDg(c[0]))).toBe(true);
      spy.mockRestore();
    }
  });
});

describe("API key lists (failover)", () => {
  it("Deepgram: a key at its limit hands over to the next key, with no Groq fallback needed", async () => {
    const { m } = await manager({ deepgramApiKey: "d1, d2" });
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_u, init) => ((init?.headers as Record<string, string>).Authorization === "Token d1" ? json({}, 429) : dg("second key works")));
    expect(await t(m)).toMatchObject({ text: "second key works", status: "ok" });
    expect(spy.mock.calls.map((c) => (c[1]!.headers as Record<string, string>).Authorization)).toEqual(["Token d1", "Token d2"]);
    // the next utterance goes straight to d2
    spy.mockClear();
    await t(m);
    expect(spy.mock.calls.map((c) => (c[1]!.headers as Record<string, string>).Authorization)).toEqual(["Token d2"]);
  });

  it("Groq Whisper: the same, when Deepgram isn't used", async () => {
    const { m } = await manager({ sttProvider: "groq", groqApiKey: "g1,g2" });
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_u, init) => ((init?.headers as Record<string, string>).Authorization === "Bearer g1" ? json({}, 429) : groqOk("g2 answered")));
    expect(await t(m)).toMatchObject({ text: "g2 answered" });
    expect(spy.mock.calls.map((c) => (c[1]!.headers as Record<string, string>).Authorization)).toEqual(["Bearer g1", "Bearer g2"]);
  });

  it("Groq text-to-speech uses the pool too", async () => {
    const { m } = await manager({ groqApiKey: "g1,g2", arabic: undefined });
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_u, init) => ((init?.headers as Record<string, string>).Authorization === "Bearer g1" ? json({}, 429) : new Response(new Uint8Array(44))));
    await (m as unknown as { synthesize: (t: string, s: unknown) => Promise<Buffer> }).synthesize("hello", { voice: "hannah", direction: "", pitch: 1, listen: "auto" });
    expect(spy.mock.calls.map((c) => (c[1]!.headers as Record<string, string>).Authorization)).toEqual(["Bearer g1", "Bearer g2"]);
  });
});
