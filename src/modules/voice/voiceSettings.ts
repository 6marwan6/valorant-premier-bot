/**
 * Voice settings shared by /mari-join (serverless app) and worker/voice.ts
 * (gateway worker). Lives in src/ so the command never has to import the
 * worker, and the worker keeps one definition of what a valid voice is.
 *
 * Plan section 53: configuration lives in the database where appropriate.
 * These settings travel on the /mari-join request row; anything the admin
 * leaves out falls back to the VOICE_* env defaults.
 */

/** Orpheus voices on Groq (English model). */
export const ORPHEUS_VOICES = ["autumn", "diana", "hannah", "austin", "daniel", "troy"] as const;
export const DEFAULT_VOICE = "hannah";

/** Pitch also shifts tempo (see samplesToDiscordPcm); outside this range she sounds broken. */
export const MIN_PITCH = 0.8;
export const MAX_PITCH = 1.25;

/** What an admin typed in /mari-join. null/undefined = "not specified, keep what she has". */
export interface VoiceOverrides {
  voice?: string | null;
  /** "" = explicitly no direction. */
  direction?: string | null;
  pitch?: number | null;
}

/** The settings a live session actually speaks with. */
export interface VoiceSettings {
  voice: string;
  direction: string;
  pitch: number;
}

/** An unknown voice name falls back to the default instead of failing every request. */
export function pickVoice(name: string | undefined | null): string {
  const v = (name ?? "").trim().toLowerCase();
  return (ORPHEUS_VOICES as readonly string[]).includes(v) ? v : DEFAULT_VOICE;
}

/**
 * Orpheus reads "[word]" as a vocal direction, so the direction must be plain
 * letters and spaces, and short (it counts toward the 200-character TTS limit).
 * "none" / "off" / "default" / "clear" mean "no direction".
 */
export function sanitizeDirection(raw: string | undefined | null): string {
  const cleaned = (raw ?? "").replace(/[^\p{L} ]/gu, "").trim().slice(0, 30);
  return ["none", "off", "default", "clear"].includes(cleaned.toLowerCase()) ? "" : cleaned;
}

export function clampPitch(value: number | null | undefined, fallback = 1): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(MAX_PITCH, Math.max(MIN_PITCH, value));
}

export function hasOverrides(o: VoiceOverrides): boolean {
  return o.voice != null || o.direction != null || o.pitch != null;
}

/** Layers the admin's choices over a base; every unspecified field is kept. */
export function applyOverrides(base: VoiceSettings, o: VoiceOverrides): VoiceSettings {
  return {
    voice: o.voice != null ? pickVoice(o.voice) : base.voice,
    direction: o.direction != null ? sanitizeDirection(o.direction) : base.direction,
    pitch: o.pitch != null ? clampPitch(o.pitch, base.pitch) : base.pitch,
  };
}

/** "voice troy · direction cheerful · pitch 1.1" for the admin's confirmation message. */
export function describeOverrides(o: VoiceOverrides): string {
  const parts: string[] = [];
  if (o.voice != null) parts.push(`voice **${pickVoice(o.voice)}**`);
  if (o.direction != null) parts.push(o.direction === "" ? "no direction" : `direction **${o.direction}**`);
  if (o.pitch != null) parts.push(`pitch **${clampPitch(o.pitch)}**`);
  return parts.join(" · ");
}
