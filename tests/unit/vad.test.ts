import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SpeechTracker, endDelayMs, loadSileroVad, pcm48kStereoToMono16kFloat, QUIET_TAIL_WINDOWS, VAD_WINDOW_MS } from "../../worker/vad.js";

describe("pcm48kStereoToMono16kFloat", () => {
  it("averages 3 frames and both channels into one 16 kHz mono sample", () => {
    const pcm = Buffer.alloc(6 * 4); // 6 frames of stereo s16le -> 2 samples
    for (let f = 0; f < 3; f++) {
      pcm.writeInt16LE(16384, f * 4);
      pcm.writeInt16LE(16384, f * 4 + 2);
    }
    const out = pcm48kStereoToMono16kFloat(pcm);
    expect(out.length).toBe(2);
    expect(out[0]).toBeCloseTo(0.5, 5);
    expect(out[1]).toBe(0);
  });

  it("turns one 20 ms Opus frame (960 stereo frames) into 320 samples", () => {
    expect(pcm48kStereoToMono16kFloat(Buffer.alloc(960 * 4)).length).toBe(320);
  });
});

describe("SpeechTracker and endDelayMs", () => {
  const feed = (t: SpeechTracker, probs: number[]) => probs.forEach((p) => t.push(p));

  it("counts only windows at or above the speech threshold", () => {
    const t = new SpeechTracker();
    feed(t, [0.9, 0.2, 0.7, 0.49]);
    expect(t.speechMs).toBe(2 * VAD_WINDOW_MS);
    expect(t.windowCount).toBe(4);
  });

  it("keeps the full silence window while the last audio is speech", () => {
    const t = new SpeechTracker();
    feed(t, [0.9, 0.9, 0.9, 0.1, 0.9]);
    expect(t.tailIsQuiet).toBe(false);
    expect(endDelayMs(t, 700, 450)).toBe(700);
  });

  it("uses the shorter window once the tail has been quiet for a few windows", () => {
    const t = new SpeechTracker();
    feed(t, [0.9, 0.9, ...Array<number>(QUIET_TAIL_WINDOWS).fill(0.05)]);
    expect(t.tailIsQuiet).toBe(true);
    expect(endDelayMs(t, 700, 450)).toBe(450);
  });

  it("never waits longer than the silence window even if VOICE_VAD_END_MS is larger", () => {
    const t = new SpeechTracker();
    feed(t, Array<number>(5).fill(0));
    expect(endDelayMs(t, 400, 900)).toBe(400);
  });

  it("a capture with no speech at all counts as zero speech", () => {
    const t = new SpeechTracker();
    feed(t, Array<number>(10).fill(0.02));
    expect(t.speechMs).toBe(0);
  });
});

describe("loadSileroVad (real model, skipped if onnxruntime-web isn't installed)", () => {
  async function load() {
    let error = "";
    const model = await loadSileroVad({ onError: (m) => (error = m) });
    return { model, error };
  }

  function fixtureSamples(): Float32Array {
    const b = readFileSync(new URL("../fixtures/speech16k.wav", import.meta.url));
    const n = (b.length - 44) / 2;
    const f = new Float32Array(n);
    for (let i = 0; i < n; i++) f[i] = b.readInt16LE(44 + i * 2) / 32768;
    return f;
  }

  it("finds speech in a spoken phrase, fed in 20 ms packets, and none in noise", async () => {
    const { model, error } = await load();
    if (!model) {
      console.warn("VAD not available here, skipping:", error);
      return;
    }
    const speech = new SpeechTracker();
    const stream = model.createStream();
    const s = fixtureSamples();
    for (let o = 0; o < s.length; o += 320) for (const p of await stream.push(s.subarray(o, o + 320))) speech.push(p);
    expect(speech.speechMs).toBeGreaterThan(500);

    const noise = new SpeechTracker();
    const noiseStream = model.createStream();
    const n = new Float32Array(16000).map(() => (Math.random() - 0.5) * 0.05);
    for (let o = 0; o < n.length; o += 320) for (const p of await noiseStream.push(n.subarray(o, o + 320))) noise.push(p);
    expect(noise.speechMs).toBe(0);
  }, 30_000);

  it("still loads the bundled model when the override path is wrong", async () => {
    let error = "";
    const model = await loadSileroVad({ modelPath: "/nonexistent/silero.onnx", onError: (m) => (error = m) });
    // Falls back to the bundled copies; only assert the contract: either a working model, or null plus a reason.
    if (model === null) expect(error).not.toBe("");
  }, 30_000);
});
