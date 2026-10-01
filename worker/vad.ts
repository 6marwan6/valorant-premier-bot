/**
 * Voice activity detection for the voice worker (2026-10-01).
 *
 * Silero VAD (MIT, ~2 MB ONNX model, `worker/models/silero_vad.onnx`) run through `onnxruntime-web`
 * (WASM: no native add-on and no install-time download, which `onnxruntime-node` needs). It is
 * OPTIONAL: if the package or the model is missing, `loadSileroVad` returns null, the worker logs it
 * and uses its fixed-silence window exactly as before (plan design principle #8: nothing else
 * depends on it). The model runs locally, so no audio leaves the machine for this step; nothing is
 * stored (plan sections 44/51).
 *
 * What it is used for (worker/voice.ts):
 *   1. Noise gate. An utterance with (almost) no actual speech never reaches Whisper. This matters
 *      more now that she answers a lone player without hearing her name: a cough or keyboard burst
 *      must not become a reply, and it saves Groq's free STT quota.
 *   2. Earlier end of turn. If the last ~100 ms of what the client sent were not speech, the turn is
 *      over sooner than the fixed silence window. Discord clients stop sending audio when you stop
 *      talking, so the audio itself rarely contains the silence; VAD cannot tell a pause between two
 *      sentences from the end of a turn, so the shorter wait applies only when the tail was not speech.
 */
import { readFileSync } from "node:fs";

/** Silero v5 at 16 kHz: 512-sample windows (32 ms), each preceded by the last 64 samples of the previous one. */
export const VAD_WINDOW = 512;
export const VAD_CONTEXT = 64;
export const VAD_WINDOW_MS = 32;
export const SPEECH_THRESHOLD = 0.5;
/** A window this far back that was not speech means the tail is quiet (3 windows = 96 ms). */
export const QUIET_TAIL_WINDOWS = 3;

const DISCORD_FRAME_BYTES = 4; // 16-bit stereo
const RATIO = 3; // 48 kHz -> 16 kHz

/** 48 kHz stereo s16le (what the Opus decoder yields) -> 16 kHz mono float in [-1, 1]. Averages each group of 3 frames. */
export function pcm48kStereoToMono16kFloat(pcm: Buffer): Float32Array {
  const frames = Math.floor(pcm.length / DISCORD_FRAME_BYTES);
  const out = new Float32Array(Math.floor(frames / RATIO));
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    for (let k = 0; k < RATIO; k++) {
      const at = (i * RATIO + k) * DISCORD_FRAME_BYTES;
      sum += pcm.readInt16LE(at) + pcm.readInt16LE(at + 2);
    }
    out[i] = sum / (RATIO * 2 * 32768);
  }
  return out;
}

/** Counts speech windows and how long the tail has been quiet. Pure, so the end-of-turn rule is unit-testable. */
export class SpeechTracker {
  private windows = 0;
  private speech = 0;
  private quietTail = 0;

  push(probability: number): void {
    this.windows++;
    if (probability >= SPEECH_THRESHOLD) {
      this.speech++;
      this.quietTail = 0;
    } else {
      this.quietTail++;
    }
  }

  get speechMs(): number {
    return this.speech * VAD_WINDOW_MS;
  }

  get windowCount(): number {
    return this.windows;
  }

  /** True once the most recent windows were not speech (also true for a capture that never contained any). */
  get tailIsQuiet(): boolean {
    return this.windows >= QUIET_TAIL_WINDOWS && this.quietTail >= QUIET_TAIL_WINDOWS;
  }
}

/** How long to keep waiting after the last audio packet before sending the utterance. */
export function endDelayMs(tracker: SpeechTracker, silenceMs: number, vadEndMs: number): number {
  return tracker.tailIsQuiet ? Math.min(vadEndMs, silenceMs) : silenceMs;
}

// ---------------------------------------------------------------------------
// Silero through onnxruntime-web
// ---------------------------------------------------------------------------

/** The slice of onnxruntime-web this file uses (the package is loaded lazily and may be absent). */
interface OrtTensor {
  data: ArrayLike<number>;
}
interface OrtLike {
  env: { wasm: { numThreads: number } };
  Tensor: new (type: string, data: Float32Array | BigInt64Array, dims: number[]) => OrtTensor;
  InferenceSession: {
    create(model: Uint8Array, options?: Record<string, unknown>): Promise<{
      run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
    }>;
  };
}

export interface VadStream {
  /** Feeds 16 kHz mono samples; resolves with one speech probability per completed 512-sample window, in order. */
  push(samples: Float32Array): Promise<number[]>;
}

export interface VadModel {
  /** A fresh recurrent state for one utterance. */
  createStream(): VadStream;
}

function candidateModelPaths(override?: string): URL[] {
  const urls: URL[] = [];
  if (override) urls.push(new URL(`file://${override.startsWith("/") ? "" : "/"}${override}`));
  urls.push(new URL("./silero_vad.onnx", import.meta.url)); // dist/ next to the bundled gateway.js
  urls.push(new URL("./models/silero_vad.onnx", import.meta.url)); // worker/models when run from source
  return urls;
}

/** Returns null (and says why through `onError`) instead of throwing: VAD is an enhancement, never a requirement. */
export async function loadSileroVad(opts: { modelPath?: string; onError?: (message: string) => void } = {}): Promise<VadModel | null> {
  try {
    // A variable specifier keeps both TypeScript and esbuild from resolving (or bundling) the package.
    const pkg = "onnxruntime-web";
    const ort = (await import(pkg)) as OrtLike;
    ort.env.wasm.numThreads = 1;

    let bytes: Uint8Array | null = null;
    for (const url of candidateModelPaths(opts.modelPath)) {
      try {
        bytes = readFileSync(url);
        break;
      } catch {
        /* try the next location */
      }
    }
    if (!bytes) throw new Error("silero_vad.onnx not found next to the worker");

    const session = await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"], graphOptimizationLevel: "basic" });

    // One run at a time on the shared session; each stream queues behind the previous call.
    let lock: Promise<unknown> = Promise.resolve();
    const run = <T>(job: () => Promise<T>): Promise<T> => {
      const next = lock.then(job, job);
      lock = next.catch(() => undefined);
      return next;
    };
    const sr = new ort.Tensor("int64", BigInt64Array.from([16000n]), []);

    const model: VadModel = {
      createStream(): VadStream {
        let state = new ort.Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
        let context = new Float32Array(VAD_CONTEXT);
        let pending = new Float32Array(0);
        return {
          async push(samples: Float32Array): Promise<number[]> {
            const merged = new Float32Array(pending.length + samples.length);
            merged.set(pending, 0);
            merged.set(samples, pending.length);
            const probs: number[] = [];
            let offset = 0;
            while (merged.length - offset >= VAD_WINDOW) {
              const x = new Float32Array(VAD_CONTEXT + VAD_WINDOW);
              x.set(context, 0);
              x.set(merged.subarray(offset, offset + VAD_WINDOW), VAD_CONTEXT);
              context = x.slice(VAD_WINDOW);
              const out = await run(() => session.run({ input: new ort.Tensor("float32", x, [1, VAD_CONTEXT + VAD_WINDOW]), state, sr }));
              state = out.stateN as OrtTensor;
              probs.push(Number((out.output as OrtTensor).data[0]));
              offset += VAD_WINDOW;
            }
            pending = merged.slice(offset);
            return probs;
          },
        };
      },
    };

    // First inference is the slow one; pay for it at startup, not on the first utterance.
    await model.createStream().push(new Float32Array(VAD_WINDOW));
    return model;
  } catch (err) {
    opts.onError?.(err instanceof Error ? err.message : String(err));
    return null;
  }
}
