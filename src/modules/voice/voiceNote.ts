import { KeyPool, parseKeyList, type FailoverLogger } from "./keyPool.js";
import { encodeVoiceNote, type VoiceNoteAudio } from "./oggOpus.js";
import { BYTES_PER_FRAME, chunkForTts, firstSentenceFirst, languageOf, parseWav, samplesToDiscordPcm, toSpeechText, TTS_MAX_INPUT_CHARS } from "./speech.js";
import { DEFAULT_ARABIC_TTS_MODEL, DEFAULT_ARABIC_VOICE, DEFAULT_TTS_MODEL, synthesizeSpeech, TtsError, type TtsConfig } from "./tts.js";
import { DEFAULT_PITCH, clampPitch, directionFromEnv, pickVoice } from "./voiceSettings.js";

/** A voice note is capped like a spoken reply (toSpeechText cuts at MAX_SPOKEN_CHARS), so at most this many Orpheus requests. */
const MAX_NOTE_CHUNKS = 6;

export interface VoiceNoteSettings {
  groqKeys: KeyPool;
  voice: string;
  direction: string;
  pitch: number;
  tts: TtsConfig;
}

/**
 * The same env the live voice worker reads (GROQ_API_KEY, VOICE_NAME, VOICE_DIRECTION, VOICE_PITCH,
 * VOICE_TTS_MODEL, VOICE_ARABIC, VOICE_TTS_ARABIC_MODEL, VOICE_NAME_AR), so a voice note sounds like her live voice.
 * Returns null without a GROQ_API_KEY: /mari-voice then says voice isn't configured. NOTE: this runs in the
 * Vercel app, so those variables must be set there too, not only on the voice worker's host.
 */
export function loadVoiceNoteSettings(env: NodeJS.ProcessEnv = process.env): VoiceNoteSettings | null {
  const keys = parseKeyList(env.GROQ_API_KEY);
  if (keys.length === 0) return null;
  const off = ["0", "false", "no", "off"].includes((env.VOICE_ARABIC ?? "").trim().toLowerCase());
  const num = Number(env.VOICE_PITCH);
  return {
    groqKeys: new KeyPool(keys),
    voice: pickVoice(env.VOICE_NAME),
    direction: directionFromEnv(env.VOICE_DIRECTION),
    pitch: clampPitch(Number.isFinite(num) && num > 0 ? num : DEFAULT_PITCH, DEFAULT_PITCH),
    tts: {
      model: env.VOICE_TTS_MODEL?.trim() || DEFAULT_TTS_MODEL,
      arabic: { enabled: !off, model: env.VOICE_TTS_ARABIC_MODEL?.trim() || DEFAULT_ARABIC_TTS_MODEL, voice: env.VOICE_NAME_AR?.trim() || DEFAULT_ARABIC_VOICE },
    },
  };
}

export class VoiceNoteError extends Error {
  constructor(
    message: string,
    readonly kind: "empty" | "tts" | "encode",
  ) {
    super(message);
  }
}

/** Left channel of 48 kHz stereo s16le (what samplesToDiscordPcm yields) as mono samples. */
function stereoToMono(pcm: Buffer): Int16Array {
  const out = new Int16Array(Math.floor(pcm.length / BYTES_PER_FRAME));
  for (let i = 0; i < out.length; i++) out[i] = pcm.readInt16LE(i * BYTES_PER_FRAME);
  return out;
}

/**
 * Text -> a ready-to-send voice note. Each chunk (<= 200 chars) is spoken by the model for its script
 * (English or Arabic), pitch-shifted like her live voice, joined, and encoded to Ogg/Opus. If any chunk
 * fails the whole note fails (a half-spoken message would be worse than none).
 */
export async function buildVoiceNote(p: { text: string; settings: VoiceNoteSettings; logger?: FailoverLogger }): Promise<VoiceNoteAudio & { chunks: number; language: "ar" | "en" }> {
  const clean = toSpeechText(p.text);
  if (!clean) throw new VoiceNoteError("nothing speakable in that text", "empty");
  const room = Math.max(40, TTS_MAX_INPUT_CHARS - (p.settings.direction ? p.settings.direction.length + 3 : 0));
  const chunks = firstSentenceFirst(chunkForTts(clean, room)).slice(0, MAX_NOTE_CHUNKS);

  const parts: Int16Array[] = [];
  try {
    // Sequential: keeps the order trivially right and stays inside Groq's per-minute request limit.
    for (const chunk of chunks) {
      const wav = await synthesizeSpeech({ pool: p.settings.groqKeys, text: chunk, voice: p.settings.voice, direction: p.settings.direction, tts: p.settings.tts, logger: p.logger });
      const { samples, sampleRate } = parseWav(wav);
      parts.push(stereoToMono(samplesToDiscordPcm(samples, sampleRate, p.settings.pitch, 0.12)));
    }
  } catch (err) {
    if (err instanceof TtsError) throw new VoiceNoteError(`speech failed (HTTP ${err.status}${err.arabic ? ", Arabic model" : ""})`, "tts");
    throw new VoiceNoteError(err instanceof Error ? err.message : String(err), "tts");
  }

  const total = parts.reduce((n, a) => n + a.length, 0);
  const pcm = new Int16Array(total);
  let at = 0;
  for (const a of parts) {
    pcm.set(a, at);
    at += a.length;
  }
  try {
    return { ...encodeVoiceNote(pcm), chunks: chunks.length, language: languageOf(clean) };
  } catch (err) {
    throw new VoiceNoteError(err instanceof Error ? err.message : String(err), "encode");
  }
}
