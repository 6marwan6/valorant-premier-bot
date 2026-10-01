import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import OpusScript from "opusscript";
import type { Client } from "discord.js";
import type { AppContext } from "../../src/appContext.js";
import { VoiceManager, type VoiceConfig } from "../../worker/voice.js";

/** 20 ms Opus packets (48 kHz stereo) made from 16 kHz mono float samples, like what a Discord client sends. */
function opusPackets(samples16k: Float32Array): Buffer[] {
  const enc = new OpusScript(48_000, 2, OpusScript.Application.AUDIO);
  const packets: Buffer[] = [];
  const frames = Math.floor((samples16k.length * 3) / 960);
  for (let f = 0; f < frames; f++) {
    const pcm = Buffer.alloc(960 * 4);
    for (let i = 0; i < 960; i++) {
      const s = samples16k[Math.floor((f * 960 + i) / 3)] ?? 0;
      const v = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
      pcm.writeInt16LE(v, i * 4);
      pcm.writeInt16LE(v, i * 4 + 2);
    }
    packets.push(Buffer.from(enc.encode(pcm, 960)));
  }
  enc.delete();
  return packets;
}

function speechFixture(): Float32Array {
  const b = readFileSync(new URL("../fixtures/speech16k.wav", import.meta.url));
  const n = (b.length - 44) / 2;
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = b.readInt16LE(44 + i * 2) / 32768;
  return f;
}

const cfg: VoiceConfig = { groqApiKey: "k", guildId: "g1", channelId: null, voice: "hannah", ttsModel: "m", direction: "", pitch: 1, language: "en", debug: false, vad: true, silenceMs: 700, vadEndMs: 450 };

async function setup(useVad: boolean) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const ctx = { logger, repositories: {} } as unknown as AppContext;
  const manager = await VoiceManager.create({ isReady: () => true } as unknown as Client, ctx, { ...cfg, vad: useVad });
  const subscribeOptions: unknown[] = [];
  let stream!: EventEmitter & { destroy: () => void };
  const session = {
    connection: {
      receiver: {
        subscribe: (_id: string, opts: unknown) => {
          subscribeOptions.push(opts);
          stream = Object.assign(new EventEmitter(), {
            destroy() {
              queueMicrotask(() => stream.emit("close"));
            },
          });
          return stream;
        },
      },
    },
  };
  const capture = (userId = "u1") =>
    (manager as unknown as { capture: (s: unknown, u: string) => Promise<{ pcm: Buffer; speechMs: number | null; endWaitMs: number }> }).capture(session, userId);
  return { manager, capture, subscribeOptions, push: (p: Buffer) => stream.emit("data", p), end: () => stream.emit("end"), vadLoaded: Boolean((manager as unknown as { vad: unknown }).vad) };
}

describe("VoiceManager.capture with the local VAD", () => {
  it("hands the end of the stream to the VAD timer, hears the speech, and ends on the short window", async () => {
    const t = await setup(true);
    if (!t.vadLoaded) return; // onnxruntime-web not installed here
    const done = t.capture();
    // Paced like a live call (a little faster than 20 ms so the test is quick, still slower than the VAD).
    for (const p of opusPackets(speechFixture())) {
      t.push(p);
      await new Promise((r) => setTimeout(r, 5));
    }
    const result = await done;
    expect(result.speechMs).toBeGreaterThan(500);
    expect(result.pcm.length).toBeGreaterThan(0);
    // The fixture ends in non-speech, so the 450 ms window applies instead of the full 700 ms.
    expect(result.endWaitMs).toBeGreaterThanOrEqual(400);
    expect(result.endWaitMs).toBeLessThan(650);
    expect((t.subscribeOptions[0] as { end: { behavior: number } }).end.behavior).toBe(0); // EndBehaviorType.Manual
  }, 30_000);

  it("reports zero speech for noise, so the utterance can be dropped before STT", async () => {
    const t = await setup(true);
    if (!t.vadLoaded) return;
    const done = t.capture();
    const noise = new Float32Array(16000).map(() => (Math.random() - 0.5) * 0.05);
    for (const p of opusPackets(noise)) t.push(p);
    const result = await done;
    expect(result.speechMs).toBe(0);
  }, 30_000);

  it("without VAD it keeps Discord's own AfterSilence window and reports no speech measurement", async () => {
    const t = await setup(false);
    const done = t.capture();
    for (const p of opusPackets(speechFixture())) t.push(p);
    t.end(); // Discord's receiver ends the stream itself in this mode
    const result = await done;
    expect((t.subscribeOptions[0] as { end: unknown }).end).toEqual({ behavior: 1, duration: 700 }); // AfterSilence, 700 ms
    expect(result.speechMs).toBeNull();
    expect(result.pcm.length).toBeGreaterThan(0);
  }, 30_000);
});
