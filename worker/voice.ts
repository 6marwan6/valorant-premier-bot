/**
 * Voice — Mari joins a voice channel and talks with roster players.
 *
 * Runs inside the gateway worker only (a voice connection is a long-lived
 * socket, which the serverless app can't hold). The whole feature is OFF
 * unless GROQ_API_KEY is set, so the worker behaves exactly as before without it.
 *
 * Where and when she joins:
 *   - /mari-join (admin) stores a request in the database — a channel and a time;
 *     the worker polls for due requests (runScheduledJoins) and joins.
 *   - Optionally VOICE_CHANNEL_ID names a default channel she also joins on her own
 *     whenever a roster player walks into it.
 *   - She leaves when the channel has no humans left.
 *
 * The loop, per utterance:
 *   1. A roster player speaks. Anyone NOT on the active roster is never
 *      captured or transcribed at all (privacy + it saves the free STT quota).
 *   2. Their Opus packets are decoded, cut at ~0.7 s of silence, and sent to
 *      Groq's hosted Whisper (free plan, no card) for transcription.
 *   3. Whether she needs her name is the session's `listen` mode (plan section 4, 2026-10-01 (b)):
 *      "name" = only when "Mari, ..." is said (a group: she must not talk over match comms);
 *      "always" = answers everything the roster player says (just one person with her);
 *      "auto" (default) = "always" while exactly one human is in the channel, else "name".
 *      /mari-join sets it per session.
 *   4. The transcript goes through the SAME runServerChatTurn the `@Mari`
 *      mention uses (same persona, same memory filtering for a public
 *      audience); only `deliver` differs — it speaks instead of posting.
 *   5. The reply is turned into speech by Groq's hosted Orpheus TTS (same API
 *      key as the transcription). Orpheus accepts at most 200 characters per
 *      request, so the reply is split into sentence-sized chunks, synthesized
 *      in parallel and played back as one clip.
 *
 * Nothing is recorded or stored: audio lives in memory for the length of one
 * turn.  No FFmpeg and no local model are needed — Orpheus returns WAV, which
 * is parsed and resampled in JS and fed to @discordjs/voice as raw PCM (Opus
 * encoding via `opusscript`, pure JS). The host installs only ~14 MB of packages.
 *
 * Env (all optional except the first):
 *   GROQ_API_KEY        free key from console.groq.com
 *   VOICE_CHANNEL_ID    optional default channel she auto-joins when a roster player enters it
 *   VOICE_NAME          Orpheus voice: autumn, diana, hannah (default), austin, daniel, troy
 *   VOICE_TTS_MODEL     Groq TTS model (default canopylabs/orpheus-v1-english)
 *   VOICE_DIRECTION     delivery hint sent as [word] (default "flirty": a young, playful gamer girl);
 *                       "none" sends no direction
 *   VOICE_PITCH         pitch multiplier, 1 = unchanged (default 1.08; also a little faster)
 *   GROQ_API_KEY / DEEPGRAM_API_KEY / LLM_API_KEY   one key, or several separated by commas: when a key
 *                       hits its limit (429), runs out of credit (402) or is refused (401), the next one is used
 *   DEEPGRAM_API_KEY    Deepgram Nova-3 does the speech-to-text; Groq Whisper is the automatic fallback
 *   VOICE_STT_PROVIDER  auto (default: deepgram if a key is set) | deepgram | groq
 *   VOICE_DEEPGRAM_MODEL  default nova-3
 *   VOICE_STT_MODEL     Groq Whisper model (default whisper-large-v3; whisper-large-v3-turbo is a little faster)
 *   VOICE_STT_LANGUAGE  auto (default: English + Arabic) or a fixed code such as en / ar
 *   VOICE_ARABIC        0 = never speak Arabic (replies still come out in English-voice only)
 *   VOICE_TTS_ARABIC_MODEL / VOICE_NAME_AR   Arabic model and voice (default orpheus-arabic-saudi / noura)
 *   VOICE_LISTEN        auto (default) | name | always: whether she needs her name (see 3 above)
 *   VOICE_WARMUP        0 = skip the warm-up she does on joining; full = also warm Groq/Deepgram (costs requests every join; default: database only)
 *   VOICE_MIN_LEVEL     utterances quieter than this (RMS 0..32768, default 250) are dropped before speech-to-text; 0 = off
 *   VOICE_LLM_MODEL     optional faster model just for spoken replies (same provider as LLM_MODEL)
 *   VOICE_LLM_MAX_TOKENS optional output cap for spoken replies; leave unset unless replies get cut off
 *   VOICE_STT_LANGUAGE  ISO code for Whisper (default en; "auto" = detect)
 *   VOICE_SILENCE_MS    how long a player must be quiet before the utterance is sent (default 700,
 *                       300-2000). Lower = she answers sooner but may cut people off mid-sentence.
 *
 * VOICE_NAME / VOICE_DIRECTION / VOICE_PITCH are only the DEFAULTS: /mari-join can override
 * voice, direction and pitch per session (src/modules/voice/voiceSettings.ts), and re-running it
 * for the channel she is already in changes them live.
 *   VOICE_DEBUG         1 = verbose logs at every stage, she greets out loud on join
 *                       (plays the TTS end to end) and transcripts are logged. Turn off after testing.
 */
import { Readable } from "node:stream";
import type { AudioPlayer, VoiceConnection } from "@discordjs/voice";
import type { Client, VoiceBasedChannel, VoiceState } from "discord.js";
import type OpusScript from "opusscript";
import type { AppContext } from "../src/appContext.js";
import { runServerChatTurn } from "../src/discord/serverChat.js";
import { MAX_PLAYER_MESSAGE_CHARS } from "../src/modules/ai/conversationService.js";
import { normalizeText } from "../src/modules/ai/topicMatch.js";
import { KeyPool, fetchWithKeys, parseKeyList } from "../src/modules/voice/keyPool.js";
import { DEFAULT_ARABIC_TTS_MODEL, DEFAULT_ARABIC_VOICE, DEFAULT_TTS_MODEL, TtsError, synthesizeSpeech } from "../src/modules/voice/tts.js";
import {
  BYTES_PER_FRAME,
  DISCORD_RATE,
  MAX_SPOKEN_CHARS,
  TTS_MAX_INPUT_CHARS,
  arabicRatio,
  chunkForTts,
  firstSentenceFirst,
  languageOf,
  parseWav,
  samplesToDiscordPcm,
  toSpeechText,
  type SpokenLanguage,
} from "../src/modules/voice/speech.js";
export { TTS_MAX_INPUT_CHARS, arabicRatio, chunkForTts, firstSentenceFirst, languageOf, parseWav, samplesToDiscordPcm, toSpeechText, type SpokenLanguage };
import {
  DEFAULT_PITCH,
  ORPHEUS_VOICES,
  pickListen,
  type ListenMode,
  applyOverrides,
  directionFromEnv,
  hasOverrides,
  pickVoice,
  type VoiceOverrides,
  type VoiceSettings,
} from "../src/modules/voice/voiceSettings.js";

// Kept exported from here: the unit tests (and anything else) import them from the worker module.
export { ORPHEUS_VOICES, pickVoice };

const STT_RATE = 16_000;
/** Groq rejects TTS input longer than this (per request, directions included). */
/** Cap requests per reply so one long answer can't burn the free quota. */
const MAX_TTS_CHUNKS = 3;
const DEEPGRAM_URL = "https://api.deepgram.com/v1/listen";
/** Names and game words, in both scripts, that Nova-3 should lean toward. */
const DEEPGRAM_KEYTERMS = ["Mari", "ماري", "Valorant", "Premier", "Jett", "Sage", "Omen"];
/** Below this Deepgram is guessing (noise, a cough): treated like Whisper's no-speech case. */
const DEEPGRAM_MIN_CONFIDENCE = 0.35;
const GROQ_STT_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const DEFAULT_STT_MODEL = "whisper-large-v3";

/** Quiet time that ends an utterance. Was 900; 700 trims 0.2 s off every answer (VOICE_SILENCE_MS overrides). */
const DEFAULT_SILENCE_MS = 700;
/** Was 700, which silently dropped a short "Mari?" (about 500 ms of speech). Noise this short is filtered after transcription instead. */
const MIN_UTTERANCE_MS = 300;
/** After she answers someone, their next utterance within this long needs no name (a follow-up in a group). */
const FOLLOWUP_MS = 12_000;
const MAX_UTTERANCE_MS = 20_000;
/** Groq's free plan allows 20 requests/minute; stay under it. */
const STT_MAX_PER_MINUTE = 15;
/**
 * An utterance whose loudest 100 ms is quieter than this (RMS, 0..32768) is a breath, a key click or room noise:
 * it is dropped locally instead of costing a speech-to-text request. VOICE_MIN_LEVEL overrides it, 0 = off.
 */
const DEFAULT_MIN_LEVEL = 250;
/** Only a first chunk longer than this is split after its first sentence (faster first audio); shorter replies stay ONE TTS request. */
const SPLIT_FIRST_SENTENCE_OVER = 120;
const ROSTER_CACHE_MS = 60_000;
/** How often the worker looks for due /mari-join requests. */
const SCHEDULE_POLL_MS = 15_000;
/** One 20 ms Opus frame of 48 kHz 16-bit stereo PCM. */
const FRAME_BYTES = 960 * BYTES_PER_FRAME;
/** Rejoin attempts after a dropped voice connection (network blip, gateway reconnect, host stall) before she gives up. */
const RECOVER_ATTEMPTS = 4;
/** A timer that fires this much late means the whole process was stalled (host CPU starvation / suspend). */
const LOOP_LAG_WARN_MS = 1_500;

/** Whisper spells a name however it likes; accept the usual suspects. */
const WAKE_WORD = /\b(mari|marie|mary|maree|marry|maari|mahri)\b/i;
/** Arabic spellings of her name, compared as whole words after normalizeText (JS \b doesn't work on Arabic letters). */
const ARABIC_WAKE_WORDS = new Set(["ماري", "ماريه", "مارى", "ميري", "ماره"].map(normalizeText));

export function hasWakeWord(transcript: string): boolean {
  if (WAKE_WORD.test(transcript)) return true;
  return normalizeText(transcript)
    .split(/[^\p{L}\p{N}]+/u)
    .some((token) => ARABIC_WAKE_WORDS.has(token));
}



/** Whisper's well-known Arabic hallucinations on silence ("subtitles by...", "subscribe to the channel"). */
const ARABIC_HALLUCINATION_PARTS = ["ترجمه نانسي", "قنقر", "اشترك في القناه", "اشتركوا في القناه", "شكرا على المشاهده", "شكرا للمشاهده"].map(normalizeText);

/** What Whisper tends to "hear" in silence, breathing or a keyboard. Only consulted when she answers WITHOUT her name. */
const WHISPER_HALLUCINATIONS = new Set([
  "you",
  "thank you",
  "thanks",
  "thank you for watching",
  "thanks for watching",
  "bye",
  "bye bye",
  "okay",
  "uh",
  "um",
  "hmm",
  "mm",
]);

export function isLikelyNoise(transcript: string): boolean {
  const arabic = normalizeText(transcript);
  if (ARABIC_HALLUCINATION_PARTS.some((part) => arabic.includes(part))) return true;
  const t = transcript.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim();
  return t.length < 2 || WHISPER_HALLUCINATIONS.has(t);
}

export interface SttResult {
  text: string | null;
  status: "ok" | "empty" | "filtered" | "failed" | "rateLimited";
  language?: string;
}

export interface SttSegment {
  no_speech_prob?: number;
  avg_logprob?: number;
}

/**
 * Whisper's own confidence says "this was not speech" (its standard skip rule: no_speech_prob above 0.6 AND
 * avg_logprob below -1), or it was so unsure of every segment that the text is guesswork. Catches the invented
 * "thank you" / Arabic subtitle credits on silence in any language, without a word list.
 */
export function isSilenceTranscript(segments: SttSegment[] | undefined): boolean {
  if (!segments || segments.length === 0) return false;
  return segments.every((s) => ((s.no_speech_prob ?? 0) > 0.6 && (s.avg_logprob ?? 0) < -1) || (s.avg_logprob ?? 0) < -1.6);
}

export type AnswerDecision = { answer: true; reason: "wakeWord" | "alone" | "listenAll" | "followUp" } | { answer: false; reason: "noWakeWord" | "noise" };

/**
 * Should she answer this transcript? (2026-10-01 (b), plan section 4.) By the session's `listen` mode:
 *   - "name": only when her name was said, so she never talks over a group's match comms.
 *   - "always": whatever the roster player says (a single person with her).
 *   - "auto": "always" while exactly one human is in her channel, otherwise "name". `humans` unknown
 *     (null) counts as "several": the cautious reading.
 * The name always works. Without it, junk transcripts are dropped (isLikelyNoise).
 */
export function decideAnswer(p: { transcript: string; humans: number | null; listen?: ListenMode; followUp?: boolean }): AnswerDecision {
  if (hasWakeWord(p.transcript)) return { answer: true, reason: "wakeWord" };
  const listen = p.listen ?? "auto";
  // She just answered this person a moment ago: a follow-up needs no name (and a long answer split in two by a pause isn't lost).
  if (p.followUp) return isLikelyNoise(p.transcript) ? { answer: false, reason: "noise" } : { answer: true, reason: "followUp" };
  const withoutName = listen === "always" || (listen === "auto" && p.humans === 1);
  if (!withoutName) return { answer: false, reason: "noWakeWord" };
  if (isLikelyNoise(p.transcript)) return { answer: false, reason: "noise" };
  return { answer: true, reason: listen === "always" ? "listenAll" : "alone" };
}

/** Loudest 100 ms stretch of a captured utterance (48 kHz stereo s16le), as RMS on the 0..32768 scale. */
export function peakLevel(pcm: Buffer): number {
  const window = DISCORD_RATE / 10;
  const frames = Math.floor(pcm.length / BYTES_PER_FRAME);
  let best = 0;
  for (let start = 0; start < frames; start += window) {
    const end = Math.min(frames, start + window);
    let sum = 0;
    for (let i = start; i < end; i++) {
      const v = pcm.readInt16LE(i * BYTES_PER_FRAME);
      sum += v * v;
    }
    best = Math.max(best, Math.sqrt(sum / (end - start)));
  }
  return best;
}

export interface VoiceConfig {
  groqApiKey: string;
  guildId: string;
  /** Optional default channel for auto-join; null = she only joins through /mari-join. */
  channelId: string | null;
  voice: string;
  ttsModel: string;
  /** Groq Whisper model (VOICE_STT_MODEL). */
  sttModel?: string;
  /** Deepgram key(s) (DEEPGRAM_API_KEY, comma-separated for several). With one set, Deepgram Nova-3 does the speech-to-text and Groq Whisper is the fallback. */
  deepgramApiKey?: string;
  /** "deepgram" | "groq": who transcribes first. Default: deepgram when a key is set, else groq. */
  sttProvider?: "deepgram" | "groq";
  deepgramModel?: string;
  /** Arabic speech (2026-10-01 (c)): a chunk that is mostly Arabic script is spoken by this model and voice instead. */
  arabic?: { enabled: boolean; model: string; voice: string };
  /** Optional single vocal direction sent as "[direction]" before each chunk. */
  direction: string;
  pitch: number;
  language: string;
  debug: boolean;
  /** Silence that ends an utterance; omitted = DEFAULT_SILENCE_MS. */
  silenceMs?: number;
  /** Default listening mode for a session; /mari-join can override it. Omitted = "auto". */
  listen?: ListenMode;
  /** Warm the database (roster) when she joins. Omitted = off (tests); loadVoiceConfig turns it on. */
  warmup?: boolean;
  /** Also warm Groq/Deepgram (a /models call, a throw-away TTS word): costs requests on EVERY join, so only with VOICE_WARMUP=full. */
  warmupGroq?: boolean;
  /** Utterances quieter than this are dropped before speech-to-text. Omitted = off (tests); loadVoiceConfig defaults it to DEFAULT_MIN_LEVEL. */
  minLevel?: number;
  /** Optional model/output cap for spoken replies only (everything else keeps LLM_MODEL / LLM_MAX_TOKENS). */
  llmModel?: string;
  llmMaxTokens?: number;
}

export function pickSttProvider(raw: string | undefined, deepgramKey: string | undefined): "deepgram" | "groq" {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "groq") return "groq";
  if (v === "deepgram") return parseKeyList(deepgramKey).length > 0 ? "deepgram" : "groq";
  return parseKeyList(deepgramKey).length > 0 ? "deepgram" : "groq"; // auto
}

export function loadVoiceConfig(guildId: string, e: NodeJS.ProcessEnv = process.env): VoiceConfig | null {
  const groqApiKey = e.GROQ_API_KEY?.trim();
  const channelId = e.VOICE_CHANNEL_ID?.trim() || null;
  if (!groqApiKey) return null;
  const num = (v: string | undefined, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    groqApiKey,
    guildId,
    channelId,
    voice: pickVoice(e.VOICE_NAME),
    ttsModel: e.VOICE_TTS_MODEL?.trim() || DEFAULT_TTS_MODEL,
    sttModel: e.VOICE_STT_MODEL?.trim() || DEFAULT_STT_MODEL,
    deepgramApiKey: e.DEEPGRAM_API_KEY?.trim() || undefined,
    sttProvider: pickSttProvider(e.VOICE_STT_PROVIDER, e.DEEPGRAM_API_KEY),
    deepgramModel: e.VOICE_DEEPGRAM_MODEL?.trim() || "nova-3",
    arabic: {
      enabled: !["0", "false", "no", "off"].includes((e.VOICE_ARABIC ?? "").trim().toLowerCase()),
      model: e.VOICE_TTS_ARABIC_MODEL?.trim() || DEFAULT_ARABIC_TTS_MODEL,
      voice: e.VOICE_NAME_AR?.trim() || DEFAULT_ARABIC_VOICE,
    },
    direction: directionFromEnv(e.VOICE_DIRECTION),
    pitch: num(e.VOICE_PITCH, DEFAULT_PITCH),
    // "auto": she hears English and Arabic (a fixed "en" would turn Arabic speech into garbage).
    language: e.VOICE_STT_LANGUAGE?.trim() || "auto",
    debug: ["1", "true", "yes"].includes((e.VOICE_DEBUG ?? "").trim().toLowerCase()),
    silenceMs: Math.min(2_000, Math.max(300, Math.round(num(e.VOICE_SILENCE_MS, DEFAULT_SILENCE_MS)))),
    listen: pickListen(e.VOICE_LISTEN),
    warmup: !["0", "false", "no", "off"].includes((e.VOICE_WARMUP ?? "").trim().toLowerCase()),
    warmupGroq: (e.VOICE_WARMUP ?? "").trim().toLowerCase() === "full",
    minLevel: Number.isFinite(Number(e.VOICE_MIN_LEVEL)) && (e.VOICE_MIN_LEVEL ?? "").trim() !== "" && Number(e.VOICE_MIN_LEVEL) >= 0 ? Number(e.VOICE_MIN_LEVEL) : DEFAULT_MIN_LEVEL,
    llmModel: e.VOICE_LLM_MODEL?.trim() || undefined,
    llmMaxTokens: e.VOICE_LLM_MAX_TOKENS ? Math.round(num(e.VOICE_LLM_MAX_TOKENS, 0)) || undefined : undefined,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers (exported so they can be unit-tested)
// ---------------------------------------------------------------------------


/** 48 kHz stereo s16le -> 16 kHz mono WAV (small upload, all Whisper needs). */
export function pcmToWav16kMono(pcm: Buffer): Buffer {
  const frames = Math.floor(pcm.length / BYTES_PER_FRAME);
  const step = DISCORD_RATE / STT_RATE; // 3
  const outSamples = Math.floor(frames / step);
  const data = Buffer.allocUnsafe(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    let sum = 0;
    for (let k = 0; k < step; k++) {
      const f = (i * step + k) * BYTES_PER_FRAME;
      sum += pcm.readInt16LE(f) + pcm.readInt16LE(f + 2);
    }
    data.writeInt16LE(Math.round(sum / (step * 2)), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(STT_RATE, 24);
  header.writeUInt32LE(STT_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}





/**
 * Splits PCM into 20 ms frames (the last one zero-padded) so the Opus encoder is
 * fed on demand, one frame per pull, instead of encoding the entire clip in one
 * synchronous burst — on a CPU-starved host that burst blocks the event loop long
 * enough for Discord's heartbeats to time out.
 */
export function* pcmFrames(pcm: Buffer): Generator<Buffer> {
  for (let offset = 0; offset < pcm.length; offset += FRAME_BYTES) {
    const frame = pcm.subarray(offset, offset + FRAME_BYTES);
    yield frame.length === FRAME_BYTES ? frame : Buffer.concat([frame, Buffer.alloc(FRAME_BYTES - frame.length)]);
  }
}

/** After its join time a /mari-join request keeps waiting this long for someone to show up. */
export const JOIN_GRACE_MS = 30 * 60_000;

/**
 * What to do with a /mari-join request whose join time has arrived:
 *   join   - someone is in the channel and we're inside the grace window
 *   wait   - the channel is still empty (she never sits alone in an empty channel)
 *   expire - the grace window passed (nobody came, or the worker was down that long)
 */
export function decideJoin(p: { joinAt: Date; now: Date; humans: number }): "join" | "wait" | "expire" {
  const late = p.now.getTime() - p.joinAt.getTime();
  if (late < 0) return "wait";
  if (late > JOIN_GRACE_MS) return "expire";
  return p.humans > 0 ? "join" : "wait";
}

// ---------------------------------------------------------------------------
// Lazy dependencies
// ---------------------------------------------------------------------------

/**
 * The voice packages are loaded with dynamic import() and kept OUT of the
 * single-file bundle (native add-ons and a WASM file can't be inlined). Loading
 * them lazily also means a missing/broken install only switches voice off —
 * the worker still starts and keeps answering DMs and @Mari mentions.
 */
interface VoiceDeps {
  dv: typeof import("@discordjs/voice");
  Opus: typeof OpusScript;
}

async function loadVoiceDeps(): Promise<VoiceDeps> {
  const dv = await import("@discordjs/voice");
  const opusMod = (await import("opusscript")) as unknown as { default?: typeof OpusScript };
  const Opus = opusMod.default ?? (opusMod as unknown as typeof OpusScript);
  return { dv, Opus };
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

interface Session {
  channelId: string;
  connection: VoiceConnection;
  player: AudioPlayer;
  capturing: Set<string>;
  /** True while a turn is being transcribed / answered / spoken; new speech is ignored. */
  busy: boolean;
  /** True while a reconnect is being attempted, so a second 'disconnected' event doesn't start a second loop. */
  recovering?: boolean;
  /** What she speaks with in this session: the VOICE_* defaults, then whatever /mari-join chose. */
  settings: VoiceSettings;
  /** Answered turns so far in this session; the first one is logged so a cold start is visible in `voice.turn.timing`. */
  turns: number;
  /** userId -> until when their next utterance counts as a follow-up (no name needed). */
  addressedUntil: Map<string, number>;
}

/** Per-turn stage timings, logged without any message content (plan sections 51 and 58). */
interface TurnTiming {
  sttMs: number;
  /** Transcript in, reply text out: the language-model call plus database work. */
  brainMs: number | null;
  /** Reply text in, first audio playing: TTS of the first chunk plus joining the player. */
  firstAudioMs: number | null;
  chunks: number;
}

export class VoiceManager {
  private session: Session | null = null;
  private joining = false;
  private checkingJoins = false;
  private joinTimer: NodeJS.Timeout | null = null;
  private lagTimer: NodeJS.Timeout | null = null;
  /** Pause between reconnect attempts; a field so tests can zero it. */
  private recoverDelayMs = 2_000;
  /** Set when she left because she was kicked or couldn't stay connected: the poll must not drag her straight back in. Cleared once the channel empties or someone new walks in. */
  private suppressAutoJoin = false;
  private autoJoining = false;
  private warnedChannelMissing = false;
  private readonly sttTimes: number[] = [];
  private warnedArabicTerms = false;
  private warnedDeepgramRejected = false;
  private readonly groqPool: KeyPool;
  private readonly deepgramPool: KeyPool;
  private readonly rosterCache = new Map<string, { player: Awaited<ReturnType<VoiceManager["isActivePlayer"]>>; at: number }>();

  private constructor(
    private readonly client: Client,
    private readonly ctx: AppContext,
    private readonly cfg: VoiceConfig,
    private readonly deps: VoiceDeps,
  ) {
    this.groqPool = new KeyPool(parseKeyList(cfg.groqApiKey));
    this.deepgramPool = new KeyPool(parseKeyList(cfg.deepgramApiKey));
  }

  /** Throws if the voice packages aren't installed; the caller logs it and carries on without voice. */
  static async create(client: Client, ctx: AppContext, cfg: VoiceConfig): Promise<VoiceManager> {
    return new VoiceManager(client, ctx, cfg, await loadVoiceDeps());
  }

  /** Verbose stage logging, only with VOICE_DEBUG=1. */
  private dbg(event: string, fields: Record<string, unknown> = {}): void {
    if (this.cfg.debug) this.ctx.logger.info({ event, ...fields }, event);
  }

  /** The env defaults; /mari-join choices are layered on top per session. */
  private defaultSettings(): VoiceSettings {
    return { voice: this.cfg.voice, direction: this.cfg.direction, pitch: this.cfg.pitch, listen: this.cfg.listen ?? "auto" };
  }

  /** Applies /mari-join choices to a live session (anything left unspecified is kept). Returns whether anything changed. */
  private applySettings(session: Session, overrides: VoiceOverrides): boolean {
    if (!hasOverrides(overrides)) return false;
    const next = applyOverrides(session.settings, overrides);
    const changed = next.voice !== session.settings.voice || next.direction !== session.settings.direction || next.pitch !== session.settings.pitch || next.listen !== session.settings.listen;
    session.settings = next;
    this.ctx.logger.info({ event: "voice.settings.applied", changed, voice: next.voice, direction: next.direction, pitch: next.pitch, listen: next.listen }, "Voice settings updated from /mari-join");
    return changed;
  }

  /** Wire to Events.VoiceStateUpdate. */
  onVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): void {
    if (newState.guild.id !== this.cfg.guildId) return;
    const member = newState.member ?? oldState.member;
    if (!member || member.user.bot) return;

    const inDefault = this.cfg.channelId !== null && newState.channelId === this.cfg.channelId && oldState.channelId !== this.cfg.channelId;
    const sessionChannel = this.session?.channelId;
    if (inDefault) {
      this.suppressAutoJoin = false; // someone new walking in is a fresh signal
      void this.maybeJoin(newState.channel, member.id);
    } else if (sessionChannel && oldState.channelId === sessionChannel && newState.channelId !== sessionChannel) {
      void this.maybeLeave(oldState.channel);
    }
  }

  /** Starts polling for due /mari-join requests. Safe to call once after the client logs in. */
  start(): void {
    if (this.joinTimer) return;
    this.joinTimer = setInterval(() => {
      void this.runScheduledJoins();
      void this.autoJoinTick();
    }, SCHEDULE_POLL_MS);
    void this.runScheduledJoins();
    void this.autoJoinTick();
    if (!this.cfg.channelId) {
      this.ctx.logger.info({ event: "voice.autojoin.off" }, "VOICE_CHANNEL_ID is not set: Mari joins voice only through /mari-join. Set it to the voice channel's id and she joins by herself when a roster player is in it");
    }

    // Tells "the host froze the process" apart from "Discord closed the connection".
    let last = Date.now();
    this.lagTimer = setInterval(() => {
      const now = Date.now();
      const lag = now - last - 1_000;
      last = now;
      if (lag > LOOP_LAG_WARN_MS) {
        this.ctx.logger.warn({ event: "voice.loop.lag", lagMs: lag }, "The worker was frozen for a while (host CPU starvation or suspend?) — Discord connections time out when this happens");
      }
    }, 1_000);
    this.lagTimer.unref();
  }

  destroy(): void {
    if (this.joinTimer) clearInterval(this.joinTimer);
    if (this.lagTimer) clearInterval(this.lagTimer);
    this.joinTimer = null;
    this.lagTimer = null;
    this.leave();
  }

  // -- /mari-join requests ----------------------------------------------------

  private async fetchVoiceChannel(channelId: string): Promise<VoiceBasedChannel | null> {
    const ch = await this.client.channels.fetch(channelId).catch(() => null);
    if (!ch || ch.isDMBased() || !ch.isVoiceBased() || ch.guildId !== this.cfg.guildId) return null;
    return ch;
  }

  /** One polling tick. Each request is claimed atomically first (plan section 50), so two ticks can never both act on it. */
  async runScheduledJoins(): Promise<void> {
    if (this.checkingJoins || this.joining || !this.client.isReady()) return;
    this.checkingJoins = true;
    const repo = this.ctx.repositories.voiceJoins;
    try {
      const now = new Date();
      for (const req of await repo.listDue(this.cfg.guildId, now)) {
        const channel = await this.fetchVoiceChannel(req.channelId);
        if (!channel) {
          if (await repo.claim(req.id)) await repo.finish(req.id, "FAILED");
          this.ctx.logger.warn({ event: "voice.join.channelMissing", requestId: req.id, channelId: req.channelId }, "/mari-join channel not found, not a voice channel, or not visible to Mari");
          continue;
        }
        const humans = channel.members.filter((m) => !m.user.bot).size;
        const verdict = decideJoin({ joinAt: req.joinAt, now, humans });
        if (verdict === "wait") continue;
        if (verdict === "expire") {
          await repo.finish(req.id, "EXPIRED");
          this.ctx.logger.info({ event: "voice.join.expired", requestId: req.id, channelId: channel.id }, "/mari-join request expired: nobody came into the channel");
          continue;
        }
        if (!(await repo.claim(req.id))) continue;
        const overrides: VoiceOverrides = { voice: req.voice, direction: req.direction, pitch: req.pitch, listen: req.listen };
        if (this.session?.channelId === channel.id) {
          this.applySettings(this.session, overrides); // already there: just retune her voice
          await repo.finish(req.id, "DONE");
          continue;
        }
        if (this.session) this.leave(); // an explicit admin request moves her
        const ok = await this.connect(channel, overrides);
        await repo.finish(req.id, ok ? "DONE" : "FAILED");
        this.ctx.logger.info({ event: "voice.join.requested", requestId: req.id, channelId: channel.id, ok }, "/mari-join request handled");
      }
    } catch (err) {
      this.ctx.logger.error({ event: "voice.join.pollFailed", err: err instanceof Error ? err.message : String(err) }, "Checking /mari-join requests failed");
    } finally {
      this.checkingJoins = false;
    }
  }

  /**
   * Auto-join the default channel (VOICE_CHANNEL_ID) whenever a roster player is in it and she is not
   * in voice. The voice-state event alone (onVoiceStateUpdate) misses three cases that made her join
   * "only when called with the slash command": a player already in the channel when the worker started,
   * a join that failed once, and an event that arrived while she was busy joining. Reconciling every
   * poll tick (same self-healing idea as the reminders, plan section 13) covers all of them.
   */
  async autoJoinTick(): Promise<void> {
    const channelId = this.cfg.channelId;
    if (!channelId || this.session || this.joining || this.autoJoining || !this.client.isReady()) return;
    this.autoJoining = true;
    try {
      const channel = await this.fetchVoiceChannel(channelId);
      if (!channel) {
        if (!this.warnedChannelMissing) {
          this.warnedChannelMissing = true;
          this.ctx.logger.warn({ event: "voice.autojoin.channelMissing", channelId }, "VOICE_CHANNEL_ID is not a voice channel in this server, or Mari can't see it — auto-join is off until that is fixed");
        }
        return;
      }
      const humans = [...channel.members.values()].filter((m) => !m.user.bot);
      if (humans.length === 0) {
        this.suppressAutoJoin = false; // empty again: the next person to walk in may bring her back
        return;
      }
      if (this.suppressAutoJoin) return;
      // Someone has to be pending-free: an explicit /mari-join for the same moment is handled by runScheduledJoins.
      for (const member of humans) {
        if (await this.isActivePlayer(member.id)) {
          this.dbg("voice.autojoin.joining", { channelId, memberId: member.id });
          await this.connect(channel);
          return;
        }
      }
    } catch (err) {
      this.ctx.logger.warn({ event: "voice.autojoin.failed", err: err instanceof Error ? err.message : String(err) }, "Auto-join check failed");
    } finally {
      this.autoJoining = false;
    }
  }

  // -- joining / leaving ----------------------------------------------------

  private async maybeJoin(channel: VoiceBasedChannel | null, memberId: string): Promise<void> {
    if (!channel || this.session || this.joining) return;
    // Only a roster player walking in summons her.
    if (!(await this.isActivePlayer(memberId))) return;
    await this.connect(channel);
  }

  /** Joins `channel` and wires up listening. Returns false (and logs why) if she couldn't. */
  private async connect(channel: VoiceBasedChannel, overrides: VoiceOverrides = {}): Promise<boolean> {
    if (!channel.joinable) {
      this.ctx.logger.warn({ event: "voice.join.notJoinable", channelId: channel.id }, "Mari can't join that voice channel (check Connect/Speak permissions)");
      return false;
    }

    const { dv } = this.deps;
    this.joining = true;
    try {
      const connection = dv.joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
        // Without this the library never emits 'debug', so the WebSocket close code was invisible.
        debug: this.cfg.debug,
      });
      await dv.entersState(connection, dv.VoiceConnectionStatus.Ready, 20_000);

      // An EventEmitter with no 'error' listener throws and would take the whole worker down.
      connection.on("error", (err) => this.ctx.logger.warn({ event: "voice.conn.error", err: err.message }, "Voice connection error"));
      connection.on("stateChange", (o, n) => {
        const detail = n.status === dv.VoiceConnectionStatus.Disconnected ? { reason: n.reason, closeCode: "closeCode" in n ? n.closeCode : undefined } : {};
        this.dbg("voice.conn.state", { from: o.status, to: n.status, ...detail });
      });
      connection.on("debug", (m) => this.dbg("voice.conn.debug", { m }));

      const me = channel.guild.members.me;
      const perms = me ? channel.permissionsFor(me) : null;
      if (perms && !perms.has("Speak")) {
        this.ctx.logger.warn({ event: "voice.perm.noSpeak", channelId: channel.id }, "Mari has no Speak permission in this channel — she will be silent until you grant it");
      }
      this.dbg("voice.join.perms", { speak: perms?.has("Speak"), connect: perms?.has("Connect"), suppressed: me?.voice.suppress, serverMuted: me?.voice.serverMute });

      const player = dv.createAudioPlayer({ behaviors: { noSubscriber: dv.NoSubscriberBehavior.Pause } });
      player.on("error", (err) => this.ctx.logger.warn({ event: "voice.player.error", err: err.message }, "Audio player error"));
      player.on("stateChange", (o, n) => this.dbg("voice.player.state", { from: o.status, to: n.status }));
      connection.subscribe(player);
      const session: Session = { channelId: channel.id, connection, player, capturing: new Set(), busy: false, turns: 0, addressedUntil: new Map(), settings: applyOverrides(this.defaultSettings(), overrides) };
      this.session = session;

      connection.on(dv.VoiceConnectionStatus.Disconnected, () => void this.recover(session, connection));
      connection.receiver.speaking.on("start", (userId) => {
        this.dbg("voice.speaking.start", { userId });
        void this.onSpeechStart(session, userId);
      });

      this.ctx.logger.info({ event: "voice.joined", channelId: channel.id }, "Mari joined the voice channel");
      if (this.cfg.warmup) void this.warmUp(channel, session.settings);

      if (this.cfg.debug) {
        // Plays the whole TTS path straight away, so "she never speaks" can be told apart from "she never hears".
        session.busy = true;
        void this.speak(session, "Hi everyone! I'm here and listening. Say my name if you need me.").finally(() => {
          session.busy = false;
        });
      }
      return true;
    } catch (err) {
      this.ctx.logger.error({ event: "voice.join.failed", err: err instanceof Error ? err.message : String(err) }, "Mari failed to join voice");
      this.leave("failed");
      return false;
    } finally {
      this.joining = false;
    }
  }

  /**
   * The voice connection dropped. Two very different cases:
   *   - close code 4014: she was moved or removed. Discord signals a move on its own
   *     within seconds; if nothing happens she was kicked, so she leaves.
   *   - anything else (a network blip, the main gateway reconnecting, the host freezing
   *     the process for a while): wait for the main gateway, then rejoin, a few times.
   * Before this, any drop longer than 5 seconds made her leave for good.
   */
  async recover(session: Session, connection: VoiceConnection): Promise<void> {
    const { dv } = this.deps;
    if (session.recovering || this.session !== session) return;
    session.recovering = true;
    try {
      const state = connection.state as { status: string; reason?: number; closeCode?: number };
      this.ctx.logger.warn({ event: "voice.conn.disconnected", reason: state.reason, closeCode: state.closeCode, gatewayReady: this.client.isReady() }, "Voice connection dropped");

      if (state.closeCode === 4014) {
        try {
          await Promise.race([
            dv.entersState(connection, dv.VoiceConnectionStatus.Signalling, 5_000),
            dv.entersState(connection, dv.VoiceConnectionStatus.Connecting, 5_000),
          ]);
        } catch {
          this.leave("kicked");
        }
        return;
      }

      for (let attempt = 1; attempt <= RECOVER_ATTEMPTS; attempt++) {
        await this.waitForGateway(15_000);
        if (this.session !== session || connection.state.status === dv.VoiceConnectionStatus.Destroyed) return;
        // A failed attempt leaves the connection stuck in 'signalling' (nothing times it out), so ask again every time.
        if (connection.state.status !== dv.VoiceConnectionStatus.Ready) connection.rejoin();
        try {
          await dv.entersState(connection, dv.VoiceConnectionStatus.Ready, 10_000);
          this.ctx.logger.info({ event: "voice.conn.recovered", attempt }, "Voice connection recovered");
          return;
        } catch {
          this.ctx.logger.warn({ event: "voice.conn.recoverFailed", attempt }, "Voice rejoin attempt failed");
          await new Promise((r) => setTimeout(r, this.recoverDelayMs * attempt));
        }
      }
      this.leave("failed");
    } finally {
      session.recovering = false;
    }
  }

  /** Waits (up to `timeoutMs`) until the main Discord gateway connection is ready again. */
  private async waitForGateway(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.client.isReady() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
  }

  private async maybeLeave(channel: VoiceBasedChannel | null): Promise<void> {
    if (!this.session || !channel) return;
    const humans = channel.members.filter((m) => !m.user.bot).size;
    if (humans === 0) this.leave("empty");
  }

  /** "kicked"/"failed" stop the poll from rejoining until the channel empties or someone new walks in; other reasons rejoin freely. */
  private leave(reason: "empty" | "kicked" | "failed" | "other" = "other"): void {
    const s = this.session;
    this.session = null;
    if (!s) return;
    if (reason === "kicked" || reason === "failed") this.suppressAutoJoin = true;
    try {
      s.player.stop(true);
      s.connection.destroy();
    } catch {
      /* already gone */
    }
    this.ctx.logger.info({ event: "voice.left" }, "Mari left the voice channel");
  }

  /** Humans (not bots) currently in her channel; null if the channel isn't cached, which callers treat as "several". */
  private humansInSession(session: Session): number | null {
    const ch = this.client.channels.cache.get(session.channelId);
    if (!ch || ch.isDMBased() || !ch.isVoiceBased()) return null;
    return ch.members.filter((m) => !m.user.bot).size;
  }

  // -- listening --------------------------------------------------------------

  private async isActivePlayer(userId: string) {
    const player = await this.ctx.repositories.players.getByDiscordUserId(this.cfg.guildId, userId);
    return player && player.active ? player : null;
  }

  /**
   * Cached roster check: "speaking start" fires constantly and shouldn't hit the database each time.
   * Both answers are cached (60 s). Before, only "not on the roster" was, so a real player's every utterance
   * waited on a database round trip BEFORE recording started: after an idle spell (a scale-to-zero Postgres)
   * that wait swallowed the first words of the first sentence — one cause of the cold start. A player removed
   * with /remove-player can still be answered for up to a minute; their settings are re-read fresh each turn.
   */
  private async rosterPlayer(userId: string) {
    const cached = this.rosterCache.get(userId);
    if (cached && Date.now() - cached.at < ROSTER_CACHE_MS) return cached.player;
    const player = (await this.isActivePlayer(userId)) ?? null;
    this.rosterCache.set(userId, { player, at: Date.now() });
    return player;
  }

  private async onSpeechStart(session: Session, userId: string): Promise<void> {
    if (this.session !== session) return;
    if (session.busy) {
      // She is thinking or speaking: this utterance is not captured. Say so, so "she didn't answer" is explainable.
      this.outcome("busy", { userId });
      return;
    }
    if (session.capturing.has(userId)) return;
    if (userId === this.client.user?.id) return;
    session.capturing.add(userId);
    try {
      const player = await this.rosterPlayer(userId);
      if (!player) {
        this.dbg("voice.roster.denied", { userId });
        return; // not on the roster: never captured, never transcribed
      }

      const pcm = await this.capture(session, userId);
      session.capturing.delete(userId);
      const ms = (pcm.length / BYTES_PER_FRAME / DISCORD_RATE) * 1000;
      if (ms < MIN_UTTERANCE_MS || session.busy || this.session !== session) {
        this.outcome("tooShort", { userId, ms: Math.round(ms) });
        return;
      }
      const minLevel = this.cfg.minLevel ?? 0;
      if (minLevel > 0) {
        const level = peakLevel(pcm);
        if (level < minLevel) {
          // Breath / key click / room noise: not worth a speech-to-text request.
          this.outcome("tooQuiet", { userId, level: Math.round(level), min: minLevel });
          return;
        }
      }

      session.busy = true;
      try {
        await this.handleUtterance(session, userId, player, pcm);
      } finally {
        session.busy = false;
      }
    } catch (err) {
      this.ctx.logger.error({ event: "voice.turn.failed", err: err instanceof Error ? err.message : String(err) }, "Voice turn failed");
    } finally {
      session.capturing.delete(userId);
    }
  }

  private capture(session: Session, userId: string): Promise<Buffer> {
    return new Promise((resolve) => {
      const opus = session.connection.receiver.subscribe(userId, {
        end: { behavior: this.deps.dv.EndBehaviorType.AfterSilence, duration: this.cfg.silenceMs ?? DEFAULT_SILENCE_MS },
      });
      const decoder = new this.deps.Opus(DISCORD_RATE, 2, this.deps.Opus.Application.AUDIO);
      const frames: Buffer[] = [];
      let bytes = 0;
      let packets = 0;
      let decodeErrors = 0;
      let firstDecodeError = "";
      const maxBytes = (MAX_UTTERANCE_MS / 1000) * DISCORD_RATE * BYTES_PER_FRAME;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        try {
          decoder.delete();
        } catch {
          /* ignore */
        }
        const level = decodeErrors > 0 ? "warn" : "info";
        if (this.cfg.debug || decodeErrors > 0) {
          this.ctx.logger[level]({ event: "voice.capture.done", userId, packets, decodeErrors, firstDecodeError, ms: Math.round((bytes / BYTES_PER_FRAME / DISCORD_RATE) * 1000) }, "voice.capture.done");
        }
        resolve(Buffer.concat(frames));
      };
      opus.on("data", (packet: Buffer) => {
        packets++;
        try {
          const pcm = decoder.decode(packet);
          frames.push(pcm);
          bytes += pcm.length;
          if (bytes >= maxBytes) opus.destroy();
        } catch (err) {
          // Many of these in a row usually means the packets are still end-to-end encrypted (DAVE not ready).
          decodeErrors++;
          if (!firstDecodeError) firstDecodeError = err instanceof Error ? err.message : String(err);
        }
      });
      opus.once("end", finish);
      opus.once("close", finish);
      opus.once("error", (err: Error) => {
        this.ctx.logger.warn({ event: "voice.capture.streamError", userId, err: err.message }, "Receive stream error");
        finish();
      });
    });
  }

  private async handleUtterance(session: Session, userId: string, player: NonNullable<Awaited<ReturnType<VoiceManager["isActivePlayer"]>>>, pcm: Buffer): Promise<void> {
    const sttStart = Date.now();
    const stt = await this.transcribe(pcm);
    const timing: TurnTiming = { sttMs: Date.now() - sttStart, brainMs: null, firstAudioMs: null, chunks: 0 };
    if (!stt.text) {
      this.outcome(`stt_${stt.status}`, { userId, sttMs: timing.sttMs, language: stt.language });
      return;
    }
    const transcript = stt.text;

    const humans = this.humansInSession(session);
    const followUp = (session.addressedUntil.get(userId) ?? 0) > Date.now();
    const decision = decideAnswer({ transcript, humans, listen: session.settings.listen, followUp });
    if (!decision.answer) {
      this.outcome(decision.reason, { userId, humans, listen: session.settings.listen, language: stt.language });
      return;
    }
    this.ctx.logger.info({ event: "voice.heard", userId, chars: transcript.length, reason: decision.reason, humans, listen: session.settings.listen, language: stt.language }, decision.reason === "wakeWord" ? "Heard Mari's name" : "Answering without her name");

    const brainStart = Date.now();
    await runServerChatTurn(this.ctx, {
      guildId: this.cfg.guildId,
      player,
      text: transcript.slice(0, MAX_PLAYER_MESSAGE_CHARS),
      sourceRef: `voice:${userId}:${Date.now()}`,
      // Spoken replies: short, and optionally on a faster model (output validation is unchanged).
      voice: { model: this.cfg.llmModel, maxTokens: this.cfg.llmMaxTokens },
      deliver: async (reply) => {
        timing.brainMs = Date.now() - brainStart;
        await this.speak(session, reply, timing);
      },
    });

    session.addressedUntil.set(userId, Date.now() + FOLLOWUP_MS);

    // Where the delay goes, per stage, with no message content (plan sections 51 and 58). The player
    // also waited silenceMs before any of this started, which is why it is part of "perceivedMs".
    const silenceMs = this.cfg.silenceMs ?? DEFAULT_SILENCE_MS;
    const afterSilenceMs = timing.sttMs + (timing.brainMs ?? 0) + (timing.firstAudioMs ?? 0);
    this.ctx.logger.info(
      { event: "voice.turn.timing", turn: ++session.turns, language: stt.language, silenceMs, sttMs: timing.sttMs, brainMs: timing.brainMs, firstAudioMs: timing.firstAudioMs, chunks: timing.chunks, perceivedMs: silenceMs + afterSilenceMs },
      "Voice turn timing",
    );
  }

  /**
   * One metadata-only line per utterance saying what became of it (no content, plan sections 51/58), so
   * "she didn't answer" has a reason in the log: busy | tooShort | stt_failed | stt_empty | stt_filtered |
   * stt_rateLimited | noWakeWord | noise (an answered utterance is the `voice.turn.timing` line instead).
   */
  private outcome(outcome: string, extra: Record<string, unknown> = {}): void {
    this.ctx.logger.info({ event: "voice.utterance", outcome, ...extra }, `Voice utterance: ${outcome}`);
  }

  /**
   * Cold-start warm-up, run in the background right after she joins (VOICE_WARMUP=0 turns it off). The
   * first answer of a session used to pay for everything at once: a cold database connection (a
   * scale-to-zero Postgres can take seconds to wake), fresh TLS connections to Groq, and the first
   * Orpheus request. So, before anyone speaks: look up the players already in the channel (wakes the
   * database and fills the roster cache), open a connection to Groq with a free request, and synthesize one
   * throw-away word (never played) so the first real sentence isn't the first one Orpheus has seen.
   * Everything is best-effort: a failure is logged at debug level and changes nothing.
   */
  async warmUp(channel: VoiceBasedChannel, settings: VoiceSettings): Promise<void> {
    const started = Date.now();
    const steps: Record<string, number | string> = {};
    const timed = async (name: string, job: () => Promise<unknown>) => {
      const t = Date.now();
      try {
        await job();
        steps[name] = Date.now() - t;
      } catch (err) {
        steps[name] = `failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    };
    const wantProviders = this.cfg.warmupGroq === true;
    const groqKey = this.groqPool.key(this.groqPool.order()[0] ?? 0);
    await Promise.all([
      timed("dbMs", async () => {
        for (const m of channel.members.values()) if (!m.user.bot) await this.rosterPlayer(m.id);
      }),
      ...(wantProviders
        ? [
            timed("groqMs", async () => {
              const res = await fetch("https://api.groq.com/openai/v1/models", { headers: { Authorization: `Bearer ${groqKey}` }, signal: AbortSignal.timeout(8_000) });
              await res.arrayBuffer();
            }),
            timed("ttsMs", async () => {
              await this.synthesize("mm", settings);
            }),
          ]
        : []),
      ...(wantProviders && this.cfg.sttProvider === "deepgram" && this.deepgramPool.size > 0
        ? [
            timed("deepgramMs", async () => {
              const res = await fetch("https://api.deepgram.com/v1/projects", { headers: { Authorization: `Token ${this.deepgramPool.key(this.deepgramPool.order()[0] ?? 0)}` }, signal: AbortSignal.timeout(8_000) });
              await res.arrayBuffer();
            }),
          ]
        : []),
    ]);
    this.ctx.logger.info({ event: "voice.warmup", totalMs: Date.now() - started, ...steps }, "Voice warm-up done");
  }

  // -- speech to text (Groq Whisper, free plan) -------------------------------

  /**
   * Which engine hears the player: Deepgram Nova-3 first when a key is set, Groq Whisper as the automatic
   * fallback if Deepgram fails for any reason (a refused request, an outage, every key exhausted). A fallback
   * only happens on "failed"; an empty or filtered result is a real answer from Deepgram and is final.
   */
  private async transcribe(pcm: Buffer): Promise<SttResult> {
    if (this.cfg.sttProvider === "deepgram" && this.deepgramPool.size > 0) {
      const result = await this.transcribeDeepgram(pcm);
      if (result.status !== "failed") return result;
      this.ctx.logger.warn({ event: "voice.stt.fallback", from: "deepgram", to: "groq" }, "Deepgram failed for this utterance; using Groq Whisper");
    }
    return this.transcribeGroq(pcm);
  }

  /**
   * Deepgram Nova-3, pre-recorded endpoint (one request per utterance). Language: `VOICE_STT_LANGUAGE=auto`
   * restricts detection to English and Arabic (detect_language=en&detect_language=ar); a fixed code (en, ar,
   * ar-EG ...) is sent as `language`. Keyterms bias it toward her name in both scripts and the game words.
   */
  private async transcribeDeepgram(pcm: Buffer): Promise<SttResult> {
    const wav = new Uint8Array(pcmToWav16kMono(pcm));
    const build = (withKeyterms: boolean) => {
      const q = new URLSearchParams({ model: this.cfg.deepgramModel ?? "nova-3", smart_format: "true" });
      if (this.cfg.language === "auto") {
        q.append("detect_language", "en");
        q.append("detect_language", "ar");
      } else {
        q.set("language", this.cfg.language);
      }
      if (withKeyterms) for (const term of DEEPGRAM_KEYTERMS) q.append("keyterm", term);
      return `${DEEPGRAM_URL}?${q.toString()}`;
    };
    const send = (url: string) =>
      fetchWithKeys(
        this.deepgramPool,
        (key) =>
          fetch(url, {
            method: "POST",
            headers: { Authorization: `Token ${key}`, "Content-Type": "audio/wav" },
            body: wav,
            signal: AbortSignal.timeout(12_000),
          }),
        { service: "deepgram", logger: this.ctx.logger },
      );

    let res: Response;
    try {
      res = await send(build(true));
      // A 400 usually means a parameter combination it doesn't accept (keyterms with a detected language, say): once without keyterms.
      if (res.status === 400) res = await send(build(false));
    } catch (err) {
      this.ctx.logger.warn({ event: "voice.stt.failed", engine: "deepgram", err: err instanceof Error ? err.message : String(err) }, "Deepgram request failed");
      return { text: null, status: "failed" };
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 300);
      this.ctx.logger.warn({ event: "voice.stt.failed", engine: "deepgram", status: res.status, body }, "Deepgram transcription failed");
      if (res.status === 400 && !this.warnedDeepgramRejected) {
        this.warnedDeepgramRejected = true;
        this.ctx.logger.error({ event: "voice.stt.deepgramRejected", language: this.cfg.language, body }, "Deepgram rejected the request. If this is about language detection, set VOICE_STT_LANGUAGE=ar (or en) instead of auto. Groq Whisper is used meanwhile");
      }
      return { text: null, status: "failed" };
    }
    const json = (await res.json()) as { results?: { channels?: Array<{ detected_language?: string; alternatives?: Array<{ transcript?: string; confidence?: number }> }> } };
    const channel = json.results?.channels?.[0];
    const alt = channel?.alternatives?.[0];
    const text = alt?.transcript?.trim();
    const language = channel?.detected_language ?? (this.cfg.language === "auto" ? undefined : this.cfg.language);
    this.dbg("voice.stt.result", { engine: "deepgram", transcript: text ?? "", language, confidence: alt?.confidence });
    if (!text) return { text: null, status: "empty", language };
    if (typeof alt?.confidence === "number" && alt.confidence < DEEPGRAM_MIN_CONFIDENCE) return { text: null, status: "filtered", language };
    return { text, status: "ok", language };
  }

  /**
   * Groq Whisper (the fallback, or the only engine without a Deepgram key). `verbose_json` returns per-segment confidence, which is a far better test for "this was
   * silence/noise, not speech" than a list of known hallucination strings (see isSilenceTranscript). One retry
   * on a timeout, 429 or 5xx: a single hiccup used to mean she silently never answered.
   */
  private async transcribeGroq(pcm: Buffer): Promise<SttResult> {
    const now = Date.now();
    while (this.sttTimes.length > 0 && now - (this.sttTimes[0] ?? now) > 60_000) this.sttTimes.shift();
    if (this.sttTimes.length >= STT_MAX_PER_MINUTE * Math.max(1, this.groqPool.size)) {
      this.ctx.logger.warn({ event: "voice.stt.rateLimited" }, "Skipping an utterance to stay inside Groq's free limit");
      return { text: null, status: "rateLimited" };
    }
    this.sttTimes.push(now);

    const wav = new Uint8Array(pcmToWav16kMono(pcm));
    const build = () => {
      const form = new FormData();
      form.append("file", new Blob([wav], { type: "audio/wav" }), "speech.wav");
      form.append("model", this.cfg.sttModel ?? DEFAULT_STT_MODEL);
      form.append("response_format", "verbose_json");
      form.append("temperature", "0");
      // Names and game words in both scripts, so "Mari" / "ماري" and the agents are spelled the way we match them.
      form.append("prompt", "Mari, ماري, Valorant, Premier, Jett, Sage, Omen.");
      if (this.cfg.language !== "auto") form.append("language", this.cfg.language);
      return form;
    };

    let res: Response | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        res = await fetchWithKeys(
          this.groqPool,
          (key) =>
            fetch(GROQ_STT_URL, {
              method: "POST",
              headers: { Authorization: `Bearer ${key}` },
              body: build(),
              signal: AbortSignal.timeout(15_000),
            }),
          { service: "groq-stt", logger: this.ctx.logger },
        );
        // 429 is NOT retried: fetchWithKeys already tried every key, so a second pass would only burn more requests.
        if (res.ok || res.status < 500 || attempt === 2) break;
        const wait = Math.min(1_500, Number(res.headers.get("retry-after") ?? 0) * 1000 || 400);
        this.ctx.logger.warn({ event: "voice.stt.retry", status: res.status, waitMs: wait }, "Groq transcription hiccup, retrying once");
        await new Promise((r) => setTimeout(r, wait));
      } catch (err) {
        if (attempt === 2) {
          this.ctx.logger.warn({ event: "voice.stt.failed", err: err instanceof Error ? err.message : String(err) }, "Groq transcription failed");
          return { text: null, status: "failed" };
        }
        this.ctx.logger.warn({ event: "voice.stt.retry", err: err instanceof Error ? err.message : String(err) }, "Groq transcription hiccup, retrying once");
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    if (!res || !res.ok) {
      const body = res ? (await res.text().catch(() => "")).slice(0, 300) : "";
      this.ctx.logger.warn({ event: "voice.stt.failed", status: res?.status, body }, "Groq transcription failed");
      return { text: null, status: "failed" };
    }
    const json = (await res.json()) as { text?: string; language?: string; segments?: SttSegment[] };
    const text = json.text?.trim();
    this.dbg("voice.stt.result", { transcript: text ?? "", language: json.language });
    if (!text) return { text: null, status: "empty", language: json.language };
    if (isSilenceTranscript(json.segments)) return { text: null, status: "filtered", language: json.language };
    return { text, status: "ok", language: json.language };
  }

  private async synthesize(text: string, settings: VoiceSettings): Promise<Buffer> {
    try {
      return await synthesizeSpeech({
        pool: this.groqPool,
        text,
        voice: settings.voice,
        direction: settings.direction,
        tts: { model: this.cfg.ttsModel, arabic: this.cfg.arabic },
        logger: this.ctx.logger,
      });
    } catch (err) {
      if (err instanceof TtsError) {
        this.ctx.logger.warn({ event: "voice.tts.failed", status: err.status, model: err.model, body: err.body }, "Groq text-to-speech failed");
        if (err.arabic && (err.status === 400 || err.status === 403) && !this.warnedArabicTerms) {
          this.warnedArabicTerms = true;
          this.ctx.logger.error({ event: "voice.tts.arabicTerms", model: err.model }, "Arabic speech was refused. Accept the model's terms once in the Groq console (Playground > text-to-speech > the Arabic model), then it works");
        }
      }
      throw err;
    }
  }

  /**
   * Speaks a reply. Every chunk is synthesized at once, but playback starts as soon as the FIRST
   * chunk is ready and the rest follow in order, instead of waiting for the whole reply to be
   * generated and resampled first. The first chunk is also kept to a single sentence, so what
   * she waits for before opening her mouth is one short TTS request.
   */
  private async speak(session: Session, reply: string, timing?: TurnTiming): Promise<void> {
    const text = toSpeechText(reply);
    if (!text || this.session !== session) return;

    const { dv } = this.deps;
    const settings = session.settings;
    try {
      const started = Date.now();
      // The direction prefix counts toward Groq's 200-character limit.
      const room = TTS_MAX_INPUT_CHARS - (settings.direction ? settings.direction.length + 3 : 0);
      const packed = chunkForTts(text, room);
      // One request for a short reply; only a long first chunk is split so she can start talking sooner.
      const chunks = ((packed[0]?.length ?? 0) > SPLIT_FIRST_SENTENCE_OVER ? firstSentenceFirst(packed) : packed).slice(0, MAX_TTS_CHUNKS);
      if (timing) timing.chunks = chunks.length;

      // A failed chunk resolves to null (never rejects), so a chunk nobody is awaiting yet can't raise an unhandled rejection.
      const jobs = chunks.map((chunk, i) =>
        this.synthesize(chunk, settings)
          .then((wav) => {
            const { samples, sampleRate } = parseWav(wav);
            return samplesToDiscordPcm(samples, sampleRate, settings.pitch, i === chunks.length - 1 ? 0.15 : 0.05);
          })
          .catch((err: unknown) => {
            this.ctx.logger.warn({ event: "voice.tts.chunkFailed", chunk: i, err: err instanceof Error ? err.message : String(err) }, "A speech chunk failed");
            return null;
          }),
      );

      let audioSeconds = 0;
      for (let i = 0; i < jobs.length; i++) {
        const pcm = await jobs[i];
        if (!pcm) break; // she says what she has; the failure is already logged
        if (this.session !== session) return;
        audioSeconds += pcm.length / BYTES_PER_FRAME / DISCORD_RATE;

        const resource = dv.createAudioResource(Readable.from(pcmFrames(pcm), { objectMode: false }), { inputType: dv.StreamType.Raw });
        // A reconnect may be in progress: don't start talking into a dead connection.
        if (session.connection.state.status !== dv.VoiceConnectionStatus.Ready) await dv.entersState(session.connection, dv.VoiceConnectionStatus.Ready, 20_000);
        session.player.play(resource);
        // 15 s, not 5: a starved host took 3.6 s just to leave "buffering".
        await dv.entersState(session.player, dv.AudioPlayerStatus.Playing, 15_000);
        if (i === 0) {
          const firstAudioMs = Date.now() - started;
          if (timing) timing.firstAudioMs = firstAudioMs;
          this.dbg("voice.tts.firstAudio", { ms: firstAudioMs, chunks: chunks.length });
        }
        await dv.entersState(session.player, dv.AudioPlayerStatus.Idle, 90_000);
        if (this.session !== session || session.connection.state.status !== dv.VoiceConnectionStatus.Ready) {
          this.ctx.logger.warn({ event: "voice.speak.interrupted" }, "The voice connection dropped while Mari was speaking");
          return;
        }
      }
      this.dbg("voice.speak.done", { chars: text.length, chunks: chunks.length, seconds: Math.round((Date.now() - started) / 100) / 10, audioSeconds: Math.round(audioSeconds) });
    } catch (err) {
      this.ctx.logger.error({ event: "voice.speak.failed", err: err instanceof Error ? err.message : String(err) }, "Mari couldn't speak");
    }
  }
}
