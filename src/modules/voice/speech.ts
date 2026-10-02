/**
 * Speech helpers shared by the voice worker (live voice) and the /mari-voice command (voice notes):
 * what to say (toSpeechText, chunking, language by script) and how to handle the audio Groq returns (WAV ->
 * samples -> 48 kHz PCM). Pure functions, no Discord or network. Moved here from worker/voice.ts on
 * 2026-10-01 (d); worker/voice.ts re-exports every name, so nothing that imported them from there changes.
 */

export const DISCORD_RATE = 48_000;
export const BYTES_PER_FRAME = 4; // 16-bit stereo
/** Groq Orpheus accepts at most 200 characters per request. */
export const TTS_MAX_INPUT_CHARS = 200;
/** A reply longer than this is cut at a sentence boundary before it is spoken. */
export const MAX_SPOKEN_CHARS = 400;

export type SpokenLanguage = "ar" | "en";

/** Share of letters that are Arabic script: decides which TTS model speaks a chunk. */
export function arabicRatio(text: string): number {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return 0;
  const arabic = text.match(/[\u0600-\u06FF\u0750-\u077F]/g) ?? [];
  return arabic.length / letters.length;
}

export function languageOf(text: string): SpokenLanguage {
  return arabicRatio(text) >= 0.4 ? "ar" : "en";
}

/** Makes a chat reply safe and pleasant to read aloud. */
export function toSpeechText(input: string): string {
  let t = input
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^-#.*$/gm, " ") // Discord subtext lines ("-# ...")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/<a?:\w+:\d+>/g, " ") // custom emoji
    .replace(/<[@#][!&]?\d+>/g, " ") // mentions / channel links
    .replace(/\[[^\]]*\]/g, " ") // Orpheus reads [word] as a vocal direction; never let chat text do that
    .replace(/[*_~`|>#]/g, "")
    .replace(/[\p{Extended_Pictographic}\u200d\ufe0f]/gu, " ")
    // "Heeeeyyyy" -> "Heeyy": TTS reads long letter runs badly.
    .replace(/(\p{L})\1{2,}/gu, "$1$1")
    .replace(/\s+/g, " ")
    .trim();

  if (t.length > MAX_SPOKEN_CHARS) {
    const cut = t.slice(0, MAX_SPOKEN_CHARS);
    const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "), cut.lastIndexOf("؟ "));
    t = lastStop > 80 ? cut.slice(0, lastStop + 1) : cut;
  }
  return t;
}

/**
 * Mono float samples -> 48 kHz stereo s16le for Discord. Reading the samples
 * as if they were recorded at `rate * pitch` shifts the pitch (and tempo) by
 * that factor — a cheap, FFmpeg-free way to tune the voice.
 */
export function samplesToDiscordPcm(samples: Float32Array, rate: number, pitch: number, tailSeconds = 0.15): Buffer {
  const ratio = (rate * pitch) / DISCORD_RATE;
  const outFrames = Math.floor(samples.length / ratio);
  const tail = Math.floor(DISCORD_RATE * tailSeconds); // silence so the last word isn't clipped
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

/**
 * Splits text into pieces of at most `max` characters for Orpheus, preferring
 * sentence ends, then commas, then spaces, and only hard-cutting a single
 * unbroken run as a last resort. Every piece is non-empty and trimmed.
 */
export function chunkForTts(text: string, max = TTS_MAX_INPUT_CHARS): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const pieces: string[] = [];
  for (const sentence of clean.split(/(?<=[.!?؟])\s+/)) {
    let rest = sentence;
    while (rest.length > max) {
      const window = rest.slice(0, max + 1);
      let cut = Math.max(window.lastIndexOf(", "), window.lastIndexOf("، "), window.lastIndexOf("; "), window.lastIndexOf(": "));
      if (cut < max * 0.4) cut = window.lastIndexOf(" ");
      if (cut < max * 0.4) cut = max; // no usable break: hard cut
      else cut += 1;
      pieces.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) pieces.push(rest);
  }
  // Pack neighbouring short sentences together: fewer requests, smoother speech.
  const out: string[] = [];
  for (const p of pieces) {
    const last = out[out.length - 1];
    if (last !== undefined && last.length + 1 + p.length <= max) out[out.length - 1] = `${last} ${p}`;
    else out.push(p);
  }
  return out.filter(Boolean);
}

/**
 * Time-to-first-audio helper: the first chunk is what she waits for before speaking, and
 * chunkForTts packs short neighbouring sentences into it. Split the first sentence off so
 * the first request is as short (fast) as possible; the rest keeps its packing.
 */
export function firstSentenceFirst(chunks: string[]): string[] {
  const [head, ...rest] = chunks;
  if (head === undefined) return [];
  const m = /^(.+?[.!?؟])\s+(\S.*)$/s.exec(head);
  return m && m[1] && m[2] ? [m[1], m[2], ...rest] : chunks;
}

/**
 * Parses a WAV file (16-bit PCM, 24-bit PCM or 32-bit float, any channel count)
 * into mono float samples. Walks the RIFF chunks instead of assuming a 44-byte
 * header, and tolerates a streamed file whose data length is 0 / 0xFFFFFFFF.
 */
export function parseWav(buf: Buffer): { samples: Float32Array; sampleRate: number } {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("TTS response is not a WAV file");
  }
  let fmt: { tag: number; channels: number; rate: number; bits: number } | null = null;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    let size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      let tag = buf.readUInt16LE(body);
      const channels = buf.readUInt16LE(body + 2);
      const rate = buf.readUInt32LE(body + 4);
      const bits = buf.readUInt16LE(body + 14);
      if (tag === 0xfffe && size >= 26) tag = buf.readUInt16LE(body + 24); // WAVE_FORMAT_EXTENSIBLE sub-format
      fmt = { tag, channels, rate, bits };
    } else if (id === "data") {
      if (!fmt) throw new Error("WAV data chunk before fmt chunk");
      if (size === 0 || size === 0xffffffff || body + size > buf.length) size = buf.length - body;
      const bytes = fmt.bits / 8;
      const frames = Math.floor(size / (bytes * fmt.channels));
      const samples = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < fmt.channels; c++) {
          const at = body + (i * fmt.channels + c) * bytes;
          if (fmt.tag === 1 && fmt.bits === 16) sum += buf.readInt16LE(at) / 32768;
          else if (fmt.tag === 1 && fmt.bits === 24) sum += buf.readIntLE(at, 3) / 8388608;
          else if (fmt.tag === 3 && fmt.bits === 32) sum += buf.readFloatLE(at);
          else throw new Error(`Unsupported WAV format (tag ${fmt.tag}, ${fmt.bits}-bit)`);
        }
        samples[i] = sum / fmt.channels;
      }
      return { samples, sampleRate: fmt.rate };
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }
  throw new Error("WAV has no data chunk");
}
