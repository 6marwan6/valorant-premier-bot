import { createRequire } from "node:module";
import type OpusScriptType from "opusscript";

const nodeRequire = createRequire(import.meta.url);
/** Loaded on first use: the WASM encoder is only needed by /mari-voice, not by every command that shares the function. */
function loadOpus(): typeof OpusScriptType {
  return nodeRequire("opusscript") as typeof OpusScriptType;
}

/**
 * Turns 48 kHz mono PCM into what Discord's "voice message" needs: an Ogg/Opus file, its length in seconds,
 * and a waveform (base64, up to 256 amplitude bytes). No ffmpeg: opusscript (already a dependency, pure
 * WASM) encodes, and the Ogg container is written here (RFC 3533 pages, RFC 7845 Opus headers).
 */

const RATE = 48_000;
const FRAME = 960; // 20 ms
/** Opus encoder lookahead at 48 kHz: the decoder drops this many leading samples (OpusHead pre-skip). */
const PRE_SKIP = 312;
const MAX_FRAMES_PER_PAGE = 50;
const WAVEFORM_BYTES = 256;

// -- Ogg CRC32 (polynomial 0x04C11DB7, not reflected, init 0) ------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let crc = 0;
  for (const byte of buf) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]!) >>> 0;
  return crc >>> 0;
}

/** One Ogg page holding whole packets (a packet longer than 254 bytes is laced into several segments). */
function oggPage(opts: { packets: Buffer[]; headerType: number; granule: bigint; serial: number; sequence: number }): Buffer {
  const lacing: number[] = [];
  for (const p of opts.packets) {
    let len = p.length;
    while (len >= 255) {
      lacing.push(255);
      len -= 255;
    }
    lacing.push(len);
  }
  if (lacing.length > 255) throw new Error("Ogg page has too many segments");
  const header = Buffer.alloc(27 + lacing.length);
  header.write("OggS", 0, "ascii");
  header.writeUInt8(0, 4); // version
  header.writeUInt8(opts.headerType, 5);
  header.writeBigUInt64LE(opts.granule, 6);
  header.writeUInt32LE(opts.serial, 14);
  header.writeUInt32LE(opts.sequence, 18);
  header.writeUInt32LE(0, 22); // checksum placeholder
  header.writeUInt8(lacing.length, 26);
  lacing.forEach((v, i) => header.writeUInt8(v, 27 + i));
  const page = Buffer.concat([header, ...opts.packets]);
  page.writeUInt32LE(crc32(page), 22);
  return page;
}

function opusHead(): Buffer {
  const b = Buffer.alloc(19);
  b.write("OpusHead", 0, "ascii");
  b.writeUInt8(1, 8); // version
  b.writeUInt8(1, 9); // channels
  b.writeUInt16LE(PRE_SKIP, 10);
  b.writeUInt32LE(RATE, 12); // original sample rate (informational)
  b.writeInt16LE(0, 16); // output gain
  b.writeUInt8(0, 18); // channel mapping family 0
  return b;
}

function opusTags(): Buffer {
  const vendor = Buffer.from("mari", "ascii");
  const b = Buffer.alloc(8 + 4 + vendor.length + 4);
  b.write("OpusTags", 0, "ascii");
  b.writeUInt32LE(vendor.length, 8);
  vendor.copy(b, 12);
  b.writeUInt32LE(0, 12 + vendor.length); // no user comments
  return b;
}

/** Discord draws this as the bars of the voice message: one byte (0 to 255) of loudness per slice of the audio. */
export function waveformOf(pcm: Int16Array, bytes = WAVEFORM_BYTES): string {
  const buckets = Math.max(1, Math.min(bytes, Math.floor(pcm.length / 480))); // at least 10 ms of audio per bar
  const rms: number[] = [];
  for (let i = 0; i < buckets; i++) {
    const from = Math.floor((i * pcm.length) / buckets);
    const to = Math.floor(((i + 1) * pcm.length) / buckets);
    let sum = 0;
    for (let k = from; k < to; k++) sum += pcm[k]! * pcm[k]!;
    rms.push(Math.sqrt(sum / Math.max(1, to - from)));
  }
  const peak = Math.max(...rms, 1);
  return Buffer.from(rms.map((v) => Math.round((v / peak) * 255))).toString("base64");
}

export interface VoiceNoteAudio {
  ogg: Buffer;
  durationSecs: number;
  waveform: string;
}

/** `pcm` is 48 kHz, mono, signed 16-bit. */
export function encodeVoiceNote(pcm: Int16Array, serial = (Math.random() * 0xffffffff) >>> 0): VoiceNoteAudio {
  if (pcm.length === 0) throw new Error("no audio to encode");
  const OpusScript = loadOpus();
  const encoder = new OpusScript(RATE, 1, OpusScript.Application.VOIP);
  encoder.encoderCTL(4002, 32_000); // OPUS_SET_BITRATE
  const frames: Buffer[] = [];
  try {
    for (let offset = 0; offset < pcm.length; offset += FRAME) {
      const frame = Buffer.alloc(FRAME * 2); // zero-padded if the last frame is short
      for (let i = 0; i < FRAME && offset + i < pcm.length; i++) frame.writeInt16LE(pcm[offset + i]!, i * 2);
      frames.push(Buffer.from(encoder.encode(frame, FRAME)));
    }
  } finally {
    encoder.delete();
  }

  const pages: Buffer[] = [
    oggPage({ packets: [opusHead()], headerType: 0x02, granule: 0n, serial, sequence: 0 }),
    oggPage({ packets: [opusTags()], headerType: 0x00, granule: 0n, serial, sequence: 1 }),
  ];
  let sequence = 2;
  for (let i = 0; i < frames.length; i += MAX_FRAMES_PER_PAGE) {
    const chunk = frames.slice(i, i + MAX_FRAMES_PER_PAGE);
    const last = i + MAX_FRAMES_PER_PAGE >= frames.length;
    pages.push(
      oggPage({
        packets: chunk,
        headerType: last ? 0x04 : 0x00,
        granule: BigInt(PRE_SKIP) + BigInt((i + chunk.length) * FRAME) - (last ? BigInt(frames.length * FRAME - pcm.length) : 0n),
        serial,
        sequence: sequence++,
      }),
    );
  }
  return { ogg: Buffer.concat(pages), durationSecs: Math.round((pcm.length / RATE) * 100) / 100, waveform: waveformOf(pcm) };
}
