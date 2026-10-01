import { describe, expect, it } from "vitest";
import {
  JOIN_GRACE_MS,
  TTS_MAX_INPUT_CHARS,
  chunkForTts,
  decideJoin,
  loadVoiceConfig,
  parseWav,
  pickVoice,
  samplesToDiscordPcm,
  toSpeechText,
} from "../../worker/voice.js";

/** Builds a WAV like the ones a TTS API returns. */
function makeWav(opts: { rate: number; channels?: number; samples: number[]; bits?: 16 | 32; float?: boolean; streamedLength?: boolean; extraChunk?: boolean }): Buffer {
  const channels = opts.channels ?? 1;
  const bits = opts.bits ?? 16;
  const bytes = bits / 8;
  const data = Buffer.alloc(opts.samples.length * bytes);
  opts.samples.forEach((v, i) => {
    if (opts.float) data.writeFloatLE(v, i * bytes);
    else data.writeInt16LE(Math.round(v * 32767), i * bytes);
  });
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0);
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(opts.float ? 3 : 1, 8);
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(opts.rate, 12);
  fmt.writeUInt32LE(opts.rate * channels * bytes, 16);
  fmt.writeUInt16LE(channels * bytes, 20);
  fmt.writeUInt16LE(bits, 22);
  const extra = opts.extraChunk ? Buffer.concat([Buffer.from("LIST"), Buffer.from([5, 0, 0, 0]), Buffer.from("abcde"), Buffer.from([0])]) : Buffer.alloc(0);
  const dataHeader = Buffer.alloc(8);
  dataHeader.write("data", 0);
  dataHeader.writeUInt32LE(opts.streamedLength ? 0xffffffff : data.length, 4);
  const body = Buffer.concat([Buffer.from("WAVE"), fmt, extra, dataHeader, data]);
  const riff = Buffer.alloc(8);
  riff.write("RIFF", 0);
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

describe("parseWav", () => {
  it("reads 16-bit mono PCM and its sample rate", () => {
    const { samples, sampleRate } = parseWav(makeWav({ rate: 24000, samples: [0, 0.5, -0.5, 1] }));
    expect(sampleRate).toBe(24000);
    expect(Array.from(samples).map((v) => Math.round(v * 100) / 100)).toEqual([0, 0.5, -0.5, 1]);
  });

  it("downmixes stereo to mono", () => {
    const { samples } = parseWav(makeWav({ rate: 48000, channels: 2, samples: [0.5, -0.5, 1, 1] }));
    expect(samples.length).toBe(2);
    expect(samples[0]).toBeCloseTo(0, 2);
    expect(samples[1]).toBeCloseTo(1, 2);
  });

  it("reads 32-bit float", () => {
    const { samples } = parseWav(makeWav({ rate: 24000, bits: 32, float: true, samples: [0.25, -0.75] }));
    expect(Array.from(samples)).toEqual([0.25, -0.75]);
  });

  it("skips unknown chunks and tolerates a streamed (0xFFFFFFFF) data length", () => {
    const { samples } = parseWav(makeWav({ rate: 24000, samples: [0.5, 0.5, 0.5], streamedLength: true, extraChunk: true }));
    expect(samples.length).toBe(3);
  });

  it("rejects non-WAV bodies (e.g. a JSON error page)", () => {
    expect(() => parseWav(Buffer.from('{"error":{"message":"nope"}}'))).toThrow(/not a WAV/);
  });
});

describe("samplesToDiscordPcm", () => {
  it("resamples 24 kHz mono to 48 kHz stereo (about 2x frames) plus the tail", () => {
    const samples = new Float32Array(2400).fill(0.5); // 0.1 s at 24 kHz
    const pcm = samplesToDiscordPcm(samples, 24000, 1, 0);
    expect(pcm.length / 4).toBeGreaterThanOrEqual(4790);
    expect(pcm.length / 4).toBeLessThanOrEqual(4800);
    expect(pcm.readInt16LE(0)).toBe(pcm.readInt16LE(2)); // left == right
  });

  it("adds the requested silent tail", () => {
    const samples = new Float32Array(2400).fill(0.5);
    const a = samplesToDiscordPcm(samples, 24000, 1, 0);
    const b = samplesToDiscordPcm(samples, 24000, 1, 0.15);
    expect((b.length - a.length) / 4).toBe(7200);
  });
});

describe("chunkForTts", () => {
  it("returns nothing for empty text and one chunk for short text", () => {
    expect(chunkForTts("   ")).toEqual([]);
    expect(chunkForTts("Hi there!")).toEqual(["Hi there!"]);
  });

  it("never exceeds the Groq 200-character limit and never loses words", () => {
    const text =
      "Okay so listen, that was honestly the best round we have played all week, and I am not just saying that because Jett finally hit a shot. " +
      "Also, somebody please remind Omar that smoking Heaven is not optional. Anyway, good luck tonight, you absolute legends!";
    const chunks = chunkForTts(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(TTS_MAX_INPUT_CHARS);
    expect(chunks.join(" ").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " "));
  });

  it("splits a single very long sentence at commas/spaces", () => {
    const text = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    const chunks = chunkForTts(text);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(TTS_MAX_INPUT_CHARS);
    expect(chunks.join(" ")).toBe(text);
  });

  it("hard-cuts an unbroken run as a last resort", () => {
    const chunks = chunkForTts("a".repeat(450));
    expect(chunks.map((c) => c.length)).toEqual([200, 200, 50]);
  });

  it("respects a smaller limit (room left for a vocal direction)", () => {
    const chunks = chunkForTts("One two three four five. Six seven eight nine ten.", 30);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(30);
  });
});

describe("toSpeechText", () => {
  it("strips [bracketed] text so chat can't inject Orpheus vocal directions", () => {
    expect(toSpeechText("Nice one [whisper] legend")).toBe("Nice one legend");
  });

  it("still strips emoji, links and markdown", () => {
    expect(toSpeechText("**GG** https://x.com 💀 see you")).toBe("GG see you");
  });

  it("caps very long replies so they need at most a few TTS requests", () => {
    const long = "This is a sentence. ".repeat(100);
    expect(toSpeechText(long).length).toBeLessThanOrEqual(400);
  });
});

describe("voice config", () => {
  it("falls back to hannah for unknown / old Kokoro voice names", () => {
    expect(pickVoice("af_heart")).toBe("hannah");
    expect(pickVoice(undefined)).toBe("hannah");
    expect(pickVoice(" Troy ")).toBe("troy");
  });

  it("is off without a key, and sane defaults with one", () => {
    expect(loadVoiceConfig("g", {} as NodeJS.ProcessEnv)).toBeNull();
    expect(loadVoiceConfig("g", { VOICE_CHANNEL_ID: "c" } as NodeJS.ProcessEnv)).toBeNull();
    const cfg = loadVoiceConfig("g", { GROQ_API_KEY: "k" } as NodeJS.ProcessEnv);
    expect(cfg).toMatchObject({ channelId: null, voice: "hannah", ttsModel: "canopylabs/orpheus-v1-english", direction: "", pitch: 1 });
  });

  it("VOICE_CHANNEL_ID is optional: it only names the default auto-join channel", () => {
    const cfg = loadVoiceConfig("g", { GROQ_API_KEY: "k", VOICE_CHANNEL_ID: " 123 " } as NodeJS.ProcessEnv);
    expect(cfg?.channelId).toBe("123");
  });

  it("sanitises VOICE_DIRECTION to plain words", () => {
    const cfg = loadVoiceConfig("g", { GROQ_API_KEY: "k", VOICE_CHANNEL_ID: "c", VOICE_DIRECTION: "[cheer]ful!!" } as NodeJS.ProcessEnv);
    expect(cfg?.direction).toBe("cheerful");
  });
});

describe("decideJoin (/mari-join)", () => {
  const joinAt = new Date("2026-10-01T19:00:00Z");
  const at = (ms: number) => new Date(joinAt.getTime() + ms);

  it("joins once the time has come and someone is in the channel", () => {
    expect(decideJoin({ joinAt, now: at(0), humans: 1 })).toBe("join");
    expect(decideJoin({ joinAt, now: at(5 * 60_000), humans: 3 })).toBe("join");
  });

  it("waits while the channel is empty (never sits alone) and before the time", () => {
    expect(decideJoin({ joinAt, now: at(0), humans: 0 })).toBe("wait");
    expect(decideJoin({ joinAt, now: at(-1000), humans: 5 })).toBe("wait");
  });

  it("joins late arrivals inside the grace window, then expires", () => {
    expect(decideJoin({ joinAt, now: at(JOIN_GRACE_MS), humans: 1 })).toBe("join");
    expect(decideJoin({ joinAt, now: at(JOIN_GRACE_MS + 1), humans: 1 })).toBe("expire");
    expect(decideJoin({ joinAt, now: at(JOIN_GRACE_MS + 1), humans: 0 })).toBe("expire");
  });
});
