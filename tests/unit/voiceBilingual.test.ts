import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "discord.js";
import type { AppContext } from "../../src/appContext.js";
import { VoiceManager, arabicRatio, chunkForTts, decideAnswer, firstSentenceFirst, hasWakeWord, isLikelyNoise, isSilenceTranscript, languageOf, loadVoiceConfig, type VoiceConfig } from "../../worker/voice.js";

afterEach(() => vi.restoreAllMocks());

describe("Arabic and English: her name, language, noise", () => {
  it("hears her name in Arabic spellings and in English", () => {
    for (const t of ["ماري انتي فين", "يا مارى تعالي", "ميري؟", "hey Mari", "Mary what's up"]) expect(hasWakeWord(t)).toBe(true);
    for (const t of ["مرحبا يا شباب", "يلا نلعب", "marinade"]) expect(hasWakeWord(t)).toBe(false);
  });

  it("detects the language of a chunk by script", () => {
    expect(languageOf("اهلا بيكم يا ابطال")).toBe("ar");
    expect(languageOf("let's go team")).toBe("en");
    expect(languageOf("لعبة Valorant النهاردة")).toBe("ar"); // mostly Arabic
    expect(languageOf("12345 !!!")).toBe("en");
    expect(arabicRatio("")).toBe(0);
  });

  it("drops Whisper's Arabic subtitle hallucinations like the English ones", () => {
    expect(isLikelyNoise("ترجمة نانسي قنقر")).toBe(true);
    expect(isLikelyNoise("اشتركوا في القناة")).toBe(true);
    expect(isLikelyNoise("يلا بينا نلعب")).toBe(false);
  });

  it("speech chunking understands Arabic punctuation", () => {
    const text = "انتي جاهزة للماتش؟ احنا هنكسب النهاردة ان شاء الله";
    expect(chunkForTts(text, 25).length).toBeGreaterThan(1);
    expect(firstSentenceFirst([text])[0]).toBe("انتي جاهزة للماتش؟");
  });
});

describe("follow-ups (no name needed right after she answered you)", () => {
  it("a follow-up is answered in group mode, but still not noise", () => {
    expect(decideAnswer({ transcript: "and what about tomorrow", humans: 4, listen: "name", followUp: true })).toEqual({ answer: true, reason: "followUp" });
    expect(decideAnswer({ transcript: "Thank you.", humans: 4, listen: "name", followUp: true })).toEqual({ answer: false, reason: "noise" });
    expect(decideAnswer({ transcript: "and what about tomorrow", humans: 4, listen: "name", followUp: false })).toEqual({ answer: false, reason: "noWakeWord" });
  });
});

describe("isSilenceTranscript (Whisper's own confidence)", () => {
  it("flags segments Whisper thinks were silence, or pure guesses", () => {
    expect(isSilenceTranscript([{ no_speech_prob: 0.9, avg_logprob: -1.4 }])).toBe(true);
    expect(isSilenceTranscript([{ no_speech_prob: 0.1, avg_logprob: -2.0 }])).toBe(true);
  });
  it("keeps real speech, quiet-but-confident speech, and missing data", () => {
    expect(isSilenceTranscript([{ no_speech_prob: 0.05, avg_logprob: -0.3 }])).toBe(false);
    expect(isSilenceTranscript([{ no_speech_prob: 0.7, avg_logprob: -0.4 }])).toBe(false);
    expect(isSilenceTranscript([{ no_speech_prob: 0.9, avg_logprob: -1.4 }, { no_speech_prob: 0.1, avg_logprob: -0.2 }])).toBe(false);
    expect(isSilenceTranscript(undefined)).toBe(false);
    expect(isSilenceTranscript([])).toBe(false);
  });
});

describe("config", () => {
  const env = (e: Record<string, string>) => ({ GROQ_API_KEY: "k", ...e }) as NodeJS.ProcessEnv;
  it("defaults: whisper-large-v3, English, Arabic voice available", () => {
    expect(loadVoiceConfig("g", env({}))).toMatchObject({
      sttModel: "whisper-large-v3",
      language: "en",
      arabic: { enabled: true, model: "canopylabs/orpheus-arabic-saudi", voice: "noura" },
    });
  });
  it("can be overridden", () => {
    const cfg = loadVoiceConfig("g", env({ VOICE_STT_MODEL: "whisper-large-v3-turbo", VOICE_STT_LANGUAGE: "ar", VOICE_LANGUAGE: "ar-EG", VOICE_ARABIC: "0", VOICE_NAME_AR: "lulwa" }));
    expect(cfg).toMatchObject({ sttModel: "whisper-large-v3-turbo", language: "en", arabic: { enabled: false, voice: "lulwa" } });
  });
});

// -- the actual requests -----------------------------------------------------

const baseCfg: VoiceConfig = { groqApiKey: "k", guildId: "g1", channelId: null, voice: "hannah", ttsModel: "canopylabs/orpheus-v1-english", direction: "flirty", pitch: 1, language: "en", debug: false, sttModel: "whisper-large-v3", arabic: { enabled: true, model: "canopylabs/orpheus-arabic-saudi", voice: "noura" } };

async function manager(cfg: Partial<VoiceConfig> = {}) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const m = await VoiceManager.create({} as Client, { logger, repositories: {} } as unknown as AppContext, { ...baseCfg, ...cfg });
  return { m, logger };
}
const settings = { voice: "hannah", direction: "flirty", pitch: 1, listen: "auto" as const, language: "en" as const };
const arabicSettings = { ...settings, language: "ar-EG" as const };
const wavResponse = () => new Response(new Uint8Array(44), { status: 200 });
type Priv = { synthesize: (t: string, s: typeof settings | typeof arabicSettings) => Promise<Buffer>; transcribe: (pcm: Buffer, language?: "en" | "ar-EG") => Promise<{ text: string | null; status: string; language?: string }> };

describe("text-to-speech picks the model by script", () => {
  it("English chunk: English model, chosen voice, [direction]", async () => {
    const { m } = await manager();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => wavResponse());
    await (m as unknown as Priv).synthesize("let's go", settings);
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toMatchObject({ model: "canopylabs/orpheus-v1-english", voice: "hannah", input: "[flirty] let's go" });
  });

  it("ar-EG session, Arabic chunk: Arabic model and voice, and no [direction] (it isn't supported there)", async () => {
    const { m } = await manager();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => wavResponse());
    await (m as unknown as Priv).synthesize("يلا بينا نلعب", arabicSettings);
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toMatchObject({ model: "canopylabs/orpheus-arabic-saudi", voice: "noura", input: "يلا بينا نلعب" });
  });

  it("an English session NEVER uses the Arabic voice, even for Arabic text: she speaks Arabic only when /mari-join said ar-EG", async () => {
    const { m } = await manager();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => wavResponse());
    await (m as unknown as Priv).synthesize("يلا بينا نلعب", settings);
    expect(JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string).model).toBe("canopylabs/orpheus-v1-english");
  });

  it("ar-EG session: an English chunk still goes to the English voice (mixed replies work)", async () => {
    const { m } = await manager();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => wavResponse());
    await (m as unknown as Priv).synthesize("let's go", arabicSettings);
    expect(JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string)).toMatchObject({ model: "canopylabs/orpheus-v1-english", input: "[flirty] let's go" });
  });

  it("with VOICE_ARABIC=0 Arabic text still goes to the English model, even in an ar-EG session", async () => {
    const { m } = await manager({ arabic: { enabled: false, model: "x", voice: "y" } });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => wavResponse());
    await (m as unknown as Priv).synthesize("يلا بينا نلعب", arabicSettings);
    expect(JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string).model).toBe("canopylabs/orpheus-v1-english");
  });

  it("explains once what to do when Groq refuses the Arabic model (terms not accepted)", async () => {
    const { m, logger } = await manager();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("model_terms_required", { status: 400 }));
    await expect((m as unknown as Priv).synthesize("يلا", arabicSettings)).rejects.toThrow(/400/);
    await expect((m as unknown as Priv).synthesize("يلا", arabicSettings)).rejects.toThrow(/400/);
    expect(logger.error.mock.calls.filter((c) => (c[0] as { event: string }).event === "voice.tts.arabicTerms")).toHaveLength(1);
  });
});

describe("speech-to-text request and robustness", () => {
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  const pcm = Buffer.alloc(48_000 * 4); // 1 s of silence-shaped PCM is enough for the request path

  it("asks for verbose_json with the configured model and both-script prompt, and the session language (never auto)", async () => {
    const { m } = await manager();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => json({ text: "hello", language: "english", segments: [{ no_speech_prob: 0.01, avg_logprob: -0.2 }] }));
    const out = await (m as unknown as Priv).transcribe(pcm);
    const form = (fetchSpy.mock.calls[0]![1] as RequestInit).body as FormData;
    expect(form.get("model")).toBe("whisper-large-v3");
    expect(form.get("response_format")).toBe("verbose_json");
    expect(form.get("language")).toBe("en");
    expect(String(form.get("prompt"))).toContain("ماري");
    expect(out).toMatchObject({ text: "hello", status: "ok", language: "english" });
  });

  it("an ar-EG session asks Whisper for Arabic", async () => {
    const { m } = await manager();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => json({ text: "ازيك", language: "arabic", segments: [] }));
    await (m as unknown as Priv).transcribe(pcm, "ar-EG");
    expect(((fetchSpy.mock.calls[0]![1] as RequestInit).body as FormData).get("language")).toBe("ar");
  });

  it("filters a transcript Whisper itself marks as silence", async () => {
    const { m } = await manager();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => json({ text: "Thank you.", segments: [{ no_speech_prob: 0.95, avg_logprob: -1.5 }] }));
    expect(await (m as unknown as Priv).transcribe(pcm)).toMatchObject({ text: null, status: "filtered" });
  });

  it("retries once after a 5xx and then succeeds", async () => {
    const { m, logger } = await manager();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => json({ error: "busy" }, 503)).mockImplementation(async () => json({ text: "ok then", segments: [] }));
    expect(await (m as unknown as Priv).transcribe(pcm)).toMatchObject({ text: "ok then", status: "ok" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(logger.warn.mock.calls.some((c) => (c[0] as { event: string }).event === "voice.stt.retry")).toBe(true);
  });

  it("retries once after a network error, and reports failed (not a crash) if it keeps failing", async () => {
    const { m } = await manager();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Promise.reject(new Error("socket hang up")));
    expect(await (m as unknown as Priv).transcribe(pcm)).toMatchObject({ text: null, status: "failed" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 429: every key was already tried, a second pass only burns requests", async () => {
    const { m } = await manager();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => json({ error: "rate limited" }, 429));
    expect(await (m as unknown as Priv).transcribe(pcm)).toMatchObject({ text: null, status: "failed" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 400 (a bad request won't get better)", async () => {
    const { m } = await manager();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => json({ error: "bad" }, 400));
    expect(await (m as unknown as Priv).transcribe(pcm)).toMatchObject({ text: null, status: "failed" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
