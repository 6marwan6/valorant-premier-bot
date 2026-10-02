import { KeyPool, fetchWithKeys, type FailoverLogger } from "./keyPool.js";
import { languageOf } from "./speech.js";

export const GROQ_TTS_URL = "https://api.groq.com/openai/v1/audio/speech";
export const DEFAULT_TTS_MODEL = "canopylabs/orpheus-v1-english";
export const DEFAULT_ARABIC_TTS_MODEL = "canopylabs/orpheus-arabic-saudi";
/** Orpheus Arabic voices: fahad, sultan (male); lulwa, noura (female). */
export const DEFAULT_ARABIC_VOICE = "noura";

export interface TtsConfig {
  /** English model. */
  model: string;
  /** Arabic speech: a chunk that is mostly Arabic script goes to this model and voice instead (it takes no [direction]). */
  arabic?: { enabled: boolean; model: string; voice: string };
}

export class TtsError extends Error {
  constructor(
    readonly status: number,
    readonly model: string,
    readonly body: string,
    readonly arabic: boolean,
  ) {
    super(`Groq TTS HTTP ${status}`);
  }
}

/**
 * One Groq Orpheus request, shared by the live voice worker and /mari-voice. Picks the Arabic model for an
 * Arabic-script chunk, the English one otherwise; sends `[direction]` only to the English model. Uses the key
 * pool, so one exhausted key moves to the next. Returns the WAV bytes; throws TtsError on a refusal.
 */
export async function synthesizeSpeech(p: {
  pool: KeyPool;
  text: string;
  voice: string;
  direction: string;
  tts: TtsConfig;
  logger?: FailoverLogger;
  timeoutMs?: number;
}): Promise<Buffer> {
  const arabic = p.tts.arabic !== undefined && p.tts.arabic.enabled && languageOf(p.text) === "ar";
  const model = arabic ? p.tts.arabic!.model : p.tts.model;
  const voice = arabic ? p.tts.arabic!.voice : p.voice;
  const input = !arabic && p.direction ? `[${p.direction}] ${p.text}` : p.text;
  const res = await fetchWithKeys(
    p.pool,
    (key) =>
      fetch(GROQ_TTS_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, voice, input, response_format: "wav" }),
        signal: AbortSignal.timeout(p.timeoutMs ?? 20_000),
      }),
    { service: "groq-tts", logger: p.logger },
  );
  if (!res.ok) throw new TtsError(res.status, model, (await res.text().catch(() => "")).slice(0, 300), arabic);
  return Buffer.from(await res.arrayBuffer());
}
