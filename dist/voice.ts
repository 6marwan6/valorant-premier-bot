/**
 * Voice — Mari joins ONE voice channel and talks with roster players.
 *
 * Runs inside the gateway worker only (a voice connection is a long-lived
 * socket, which the serverless app can't hold). The whole feature is OFF
 * unless GROQ_API_KEY and VOICE_CHANNEL_ID are both set, so the worker behaves
 * exactly as before without them.
 *
 * The loop, per utterance:
 *   1. A roster player speaks. Anyone NOT on the active roster is never
 *      captured or transcribed at all (privacy + it saves the free STT quota).
 *   2. Their Opus packets are decoded, cut at ~0.9 s of silence, and sent to
 *      Groq's hosted Whisper (free plan, no card) for transcription.
 *   3. Mari only answers if her name was said ("Mari, ...") — she must not
 *      talk over match comms.
 *   4. The transcript goes through the SAME runServerChatTurn the `@Mari`
 *      mention uses (same persona, same memory filtering for a public
 *      audience); only `deliver` differs — it speaks instead of posting.
 *   5. The reply is turned into speech locally with Kokoro (free, no API),
 *      pitched up a touch, and played into the channel.
 *
 * Nothing is recorded or stored: audio lives in memory for the length of one
 * turn.  No FFmpeg is needed — Kokoro's samples are resampled in JS and fed to
 * @discordjs/voice as raw PCM (Opus encoding via `opusscript`, pure JS).
 *
 * Env (all optional except the first two):
 *   GROQ_API_KEY        free key from console.groq.com
 *   VOICE_CHANNEL_ID    the ONE voice channel Mari may join
 *   VOICE_NAME          Kokoro voice preset (default af_heart; try af_bella, af_sky)
 *   VOICE_SPEED         speaking speed (default 1.05)
 *   VOICE_PITCH         pitch multiplier, 1 = unchanged (default 1.08 = cuter)
 *   VOICE_STT_LANGUAGE  ISO code for Whisper (default en; "auto" = detect)
 *   VOICE_DEBUG         1 = verbose logs at every stage, she greets out loud on join
 *                       (plays the TTS end to end) and transcripts are logged. Turn off after testing.
 */
import { Readable } from "node:stream";
import type { AudioPlayer, VoiceConnection } from "@discordjs/voice";
import type { Client, VoiceBasedChannel, VoiceState } from "discord.js";
import type { KokoroTTS } from "kokoro-js";
import type OpusScript from "opusscript";
import type { AppContext } from "../src/appContext.js";
import { runServerChatTurn } from "../src/discord/serverChat.js";
import { MAX_PLAYER_MESSAGE_CHARS } from "../src/modules/ai/conversationService.js";

const DISCORD_RATE = 48_000;
const BYTES_PER_FRAME = 4; // 16-bit stereo
const STT_RATE = 16_000;
const KOKORO_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
const GROQ_STT_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_STT_MODEL = "whisper-large-v3-turbo";

const SILENCE_MS = 900;
const MIN_UTTERANCE_MS = 700;
const MAX_UTTERANCE_MS = 20_000;
/** Groq's free plan allows 20 requests/minute; stay under it. */
const STT_MAX_PER_MINUTE = 15;
const MAX_SPOKEN_CHARS = 350;
const ROSTER_CACHE_MS = 60_000;

/** Whisper spells a name however it likes; accept the usual suspects. */
const WAKE_WORD = /\b(mari|marie|mary|maree|marry|maari|mahri)\b/i;

export interface VoiceConfig {
  groqApiKey: string;
  guildId: string;
  channelId: string;
  voice: string;
  speed: number;
  pitch: number;
  language: string;
  debug: boolean;
}

export function loadVoiceConfig(guildId: string, e: NodeJS.ProcessEnv = process.env): VoiceConfig | null {
  const groqApiKey = e.GROQ_API_KEY?.trim();
  const channelId = e.VOICE_CHANNEL_ID?.trim();
  if (!groqApiKey || !channelId) return null;
  const num = (v: string | undefined, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    groqApiKey,
    guildId,
    channelId,
    voice: e.VOICE_NAME?.trim() || "af_heart",
    speed: num(e.VOICE_SPEED, 1.05),
    pitch: num(e.VOICE_PITCH, 1.08),
    language: e.VOICE_STT_LANGUAGE?.trim() || "en",
    debug: ["1", "true", "yes"].includes((e.VOICE_DEBUG ?? "").trim().toLowerCase()),
  };
}

// ---------------------------------------------------------------------------
// Pure helpers (exported so they can be unit-tested)
// ---------------------------------------------------------------------------

/** Makes a chat reply safe and pleasant to read aloud. */
export function toSpeechText(input: string): string {
  let t = input
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^-#.*$/gm, " ") // Discord subtext lines ("-# ...")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/<a?:\w+:\d+>/g, " ") // custom emoji
    .replace(/<[@#][!&]?\d+>/g, " ") // mentions / channel links
    .replace(/[*_~`|>#]/g, "")
    .replace(/[\p{Extended_Pictographic}\u200d\ufe0f]/gu, " ")
    // "Heeeeyyyy" -> "Heeyy": TTS reads long letter runs badly.
    .replace(/(\p{L})\1{2,}/gu, "$1$1")
    .replace(/\s+/g, " ")
    .trim();

  if (t.length > MAX_SPOKEN_CHARS) {
    const cut = t.slice(0, MAX_SPOKEN_CHARS);
    const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    t = lastStop > 80 ? cut.slice(0, lastStop + 1) : cut;
  }
  return t;
}

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
 * Kokoro float samples -> 48 kHz stereo s16le for Discord. Reading the samples
 * as if they were recorded at `rate * pitch` raises the pitch (and tempo) by
 * that factor — a cheap, FFmpeg-free way to make the voice sweeter.
 */
export function samplesToDiscordPcm(samples: Float32Array, rate: number, pitch: number): Buffer {
  const ratio = (rate * pitch) / DISCORD_RATE;
  const outFrames = Math.floor(samples.length / ratio);
  const tail = Math.floor(DISCORD_RATE * 0.15); // silence so the last word isn't clipped
  const out = Buffer.alloc((outFrames + tail) * BYTES_PER_FRAME);
  for (let i = 0; i < outFrames; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const a = samples[i0] ?? 0;
    const b = samples[i0 + 1] ?? a;
    const s = a + (b - a) * (pos - i0);
    const v = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
    out.writeInt16LE(v, i * BYTES_PER_FRAME);
    out.writeInt16LE(v, i * BYTES_PER_FRAME + 2);
  }
  return out;
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
  Kokoro: typeof KokoroTTS;
}

async function loadVoiceDeps(): Promise<VoiceDeps> {
  const dv = await import("@discordjs/voice");
  const opusMod = (await import("opusscript")) as unknown as { default?: typeof OpusScript };
  const Opus = opusMod.default ?? (opusMod as unknown as typeof OpusScript);
  const { KokoroTTS: Kokoro } = await import("kokoro-js");
  return { dv, Opus, Kokoro };
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
}

export class VoiceManager {
  private session: Session | null = null;
  private joining = false;
  private tts: Promise<KokoroTTS> | null = null;
  private readonly sttTimes: number[] = [];
  private readonly rosterCache = new Map<string, { active: boolean; at: number }>();

  private constructor(
    private readonly client: Client,
    private readonly ctx: AppContext,
    private readonly cfg: VoiceConfig,
    private readonly deps: VoiceDeps,
  ) {}

  /** Throws if the voice packages aren't installed; the caller logs it and carries on without voice. */
  static async create(client: Client, ctx: AppContext, cfg: VoiceConfig): Promise<VoiceManager> {
    return new VoiceManager(client, ctx, cfg, await loadVoiceDeps());
  }

  /** Verbose stage logging, only with VOICE_DEBUG=1. */
  private dbg(event: string, fields: Record<string, unknown> = {}): void {
    if (this.cfg.debug) this.ctx.logger.info({ event, ...fields }, event);
  }

  /** Wire to Events.VoiceStateUpdate. */
  onVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): void {
    if (newState.guild.id !== this.cfg.guildId) return;
    const member = newState.member ?? oldState.member;
    if (!member || member.user.bot) return;

    if (newState.channelId === this.cfg.channelId && oldState.channelId !== this.cfg.channelId) {
      void this.maybeJoin(newState.channel, member.id);
    } else if (oldState.channelId === this.cfg.channelId && newState.channelId !== this.cfg.channelId) {
      void this.maybeLeave(oldState.channel);
    }
  }

  destroy(): void {
    this.leave();
  }

  // -- joining / leaving ----------------------------------------------------

  private async maybeJoin(channel: VoiceBasedChannel | null, memberId: string): Promise<void> {
    if (!channel || this.session || this.joining) return;
    // Only a roster player walking in summons her.
    if (!(await this.isActivePlayer(memberId))) return;
    if (!channel.joinable) {
      this.ctx.logger.warn({ event: "voice.join.notJoinable", channelId: channel.id }, "Mari can't join that voice channel (check Connect/Speak permissions)");
      return;
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
      });
      await dv.entersState(connection, dv.VoiceConnectionStatus.Ready, 20_000);

      // An EventEmitter with no 'error' listener throws and would take the whole worker down.
      connection.on("error", (err) => this.ctx.logger.warn({ event: "voice.conn.error", err: err.message }, "Voice connection error"));
      connection.on("stateChange", (o, n) => this.dbg("voice.conn.state", { from: o.status, to: n.status }));
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
      const session: Session = { channelId: channel.id, connection, player, capturing: new Set(), busy: false };
      this.session = session;

      connection.on(dv.VoiceConnectionStatus.Disconnected, async () => {
        try {
          // Moved channels / brief network blip: give it a few seconds to reconnect.
          await Promise.race([
            dv.entersState(connection, dv.VoiceConnectionStatus.Signalling, 5_000),
            dv.entersState(connection, dv.VoiceConnectionStatus.Connecting, 5_000),
          ]);
        } catch {
          this.leave();
        }
      });
      connection.receiver.speaking.on("start", (userId) => {
        this.dbg("voice.speaking.start", { userId });
        void this.onSpeechStart(session, userId);
      });

      void this.loadTts().catch((err) => this.ctx.logger.error({ event: "voice.tts.loadFailed", err: String(err) }, "Kokoro failed to load"));
      this.ctx.logger.info({ event: "voice.joined", channelId: channel.id }, "Mari joined the voice channel");

      if (channel.isTextBased()) {
        await channel
          .send("🎙️ Hi! Say my name and I'll answer out loud. Only team members are transcribed (via Groq), and nothing is recorded or saved. ✨")
          .catch(() => undefined);
      }

      if (this.cfg.debug) {
        // Plays the whole TTS path straight away, so "she never speaks" can be told apart from "she never hears".
        session.busy = true;
        void this.speak(session, "Hi everyone! I'm here and listening. Say my name if you need me.").finally(() => {
          session.busy = false;
        });
      }
    } catch (err) {
      this.ctx.logger.error({ event: "voice.join.failed", err: err instanceof Error ? err.message : String(err) }, "Mari failed to join voice");
      this.leave();
    } finally {
      this.joining = false;
    }
  }

  private async maybeLeave(channel: VoiceBasedChannel | null): Promise<void> {
    if (!this.session || !channel) return;
    const humans = channel.members.filter((m) => !m.user.bot).size;
    if (humans === 0) this.leave();
  }

  private leave(): void {
    const s = this.session;
    this.session = null;
    if (!s) return;
    try {
      s.player.stop(true);
      s.connection.destroy();
    } catch {
      /* already gone */
    }
    this.ctx.logger.info({ event: "voice.left" }, "Mari left the voice channel");
  }

  // -- listening --------------------------------------------------------------

  private async isActivePlayer(userId: string) {
    const player = await this.ctx.repositories.players.getByDiscordUserId(this.cfg.guildId, userId);
    return player && player.active ? player : null;
  }

  /** Cached roster check: "speaking start" fires constantly and shouldn't hit the database each time. */
  private async rosterPlayer(userId: string) {
    const cached = this.rosterCache.get(userId);
    if (cached && Date.now() - cached.at < ROSTER_CACHE_MS && !cached.active) return null;
    const player = await this.isActivePlayer(userId);
    this.rosterCache.set(userId, { active: Boolean(player), at: Date.now() });
    return player;
  }

  private async onSpeechStart(session: Session, userId: string): Promise<void> {
    if (this.session !== session || session.busy || session.capturing.has(userId)) return;
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
        this.dbg("voice.capture.dropped", { userId, ms: Math.round(ms), busy: session.busy });
        return;
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
        end: { behavior: this.deps.dv.EndBehaviorType.AfterSilence, duration: SILENCE_MS },
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
    const transcript = await this.transcribe(pcm);
    if (!transcript) return;
    if (!WAKE_WORD.test(transcript)) {
      this.ctx.logger.debug({ event: "voice.ignored.noWakeWord" }, "Heard speech without her name");
      return;
    }
    this.ctx.logger.info({ event: "voice.heard", userId, chars: transcript.length }, "Heard Mari's name");

    await runServerChatTurn(this.ctx, {
      guildId: this.cfg.guildId,
      player,
      text: transcript.slice(0, MAX_PLAYER_MESSAGE_CHARS),
      sourceRef: `voice:${userId}:${Date.now()}`,
      deliver: (reply) => this.speak(session, reply),
    });
  }

  // -- speech to text (Groq Whisper, free plan) -------------------------------

  private async transcribe(pcm: Buffer): Promise<string | null> {
    const now = Date.now();
    while (this.sttTimes.length > 0 && now - (this.sttTimes[0] ?? now) > 60_000) this.sttTimes.shift();
    if (this.sttTimes.length >= STT_MAX_PER_MINUTE) {
      this.ctx.logger.warn({ event: "voice.stt.rateLimited" }, "Skipping an utterance to stay inside Groq's free limit");
      return null;
    }
    this.sttTimes.push(now);

    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(pcmToWav16kMono(pcm))], { type: "audio/wav" }), "speech.wav");
    form.append("model", GROQ_STT_MODEL);
    form.append("response_format", "json");
    form.append("temperature", "0");
    form.append("prompt", "Mari, Valorant, Premier, Jett, Sage, Omen.");
    if (this.cfg.language !== "auto") form.append("language", this.cfg.language);

    const res = await fetch(GROQ_STT_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.cfg.groqApiKey}` },
      body: form,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 300);
      this.ctx.logger.warn({ event: "voice.stt.failed", status: res.status, body }, "Groq transcription failed");
      return null;
    }
    const json = (await res.json()) as { text?: string };
    const text = json.text?.trim();
    this.dbg("voice.stt.result", { transcript: text ?? "" });
    return text ? text : null;
  }

  // -- text to speech (Kokoro, local) -----------------------------------------

  private loadTts(): Promise<KokoroTTS> {
    if (!this.tts) {
      const started = Date.now();
      this.ctx.logger.info({ event: "voice.tts.loading" }, "Loading Kokoro (first run downloads ~86 MB from huggingface.co)");
      this.tts = this.deps.Kokoro.from_pretrained(KOKORO_MODEL, { dtype: "q8", device: "cpu" });
      this.tts.then(
        () => this.ctx.logger.info({ event: "voice.tts.ready", seconds: Math.round((Date.now() - started) / 1000) }, "Kokoro ready"),
        (err: unknown) => {
          this.ctx.logger.error({ event: "voice.tts.loadFailed", err: err instanceof Error ? err.message : String(err) }, "Kokoro failed to load");
          this.tts = null; // allow a retry next time
        },
      );
    }
    return this.tts;
  }

  private async speak(session: Session, reply: string): Promise<void> {
    const text = toSpeechText(reply);
    if (!text || this.session !== session) return;

    try {
      const started = Date.now();
      const tts = await this.loadTts();
      const audio = await tts.generate(text, { voice: this.cfg.voice as never, speed: this.cfg.speed });
      const pcm = samplesToDiscordPcm(audio.audio, audio.sampling_rate, this.cfg.pitch);
      this.dbg("voice.tts.generated", { chars: text.length, seconds: Math.round((Date.now() - started) / 100) / 10, audioSeconds: Math.round(pcm.length / BYTES_PER_FRAME / DISCORD_RATE) });

      const { dv } = this.deps;
      const resource = dv.createAudioResource(Readable.from([pcm]), { inputType: dv.StreamType.Raw });
      session.player.play(resource);
      await dv.entersState(session.player, dv.AudioPlayerStatus.Playing, 5_000);
      await dv.entersState(session.player, dv.AudioPlayerStatus.Idle, 90_000);
      this.dbg("voice.speak.done");
    } catch (err) {
      this.ctx.logger.error({ event: "voice.speak.failed", err: err instanceof Error ? err.message : String(err) }, "Mari couldn't speak");
    }
  }
}
