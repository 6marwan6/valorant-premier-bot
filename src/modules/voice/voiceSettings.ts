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

/**
 * Mari's default delivery (2026-10-01 plan revision): a young, playful, flirty gamer girl. The WORDS
 * are already that (MARI_PERSONA); this only sets how Orpheus delivers them. Pitch above 1 also
 * speeds her up a little, which reads as younger and more energetic. Env (VOICE_DIRECTION /
 * VOICE_PITCH) and /mari-join still override both.
 */
export const DEFAULT_DIRECTION = "flirty";
export const DEFAULT_PITCH = 1.08;

/** Pitch also shifts tempo (see samplesToDiscordPcm); outside this range she sounds broken. */
export const MIN_PITCH = 0.8;
export const MAX_PITCH = 1.25;

/**
 * Whether she needs to hear her name before answering (2026-10-01 (b), plan section 4):
 *   name   - always: "Mari, ..." (a group in the channel; she must not talk over match comms)
 *   always - never: she answers everything the roster player says (just one person with her)
 *   auto   - "always" while exactly one human is in her channel, "name" otherwise
 */
export const LISTEN_MODES = ["auto", "name", "always"] as const;
export type ListenMode = (typeof LISTEN_MODES)[number];
export const DEFAULT_LISTEN: ListenMode = "auto";

export const LISTEN_CHOICES: Array<{ name: string; value: ListenMode }> = [
  { name: "Group: she waits for her name", value: "name" },
  { name: "Just one person: no name needed", value: "always" },
  { name: "Auto: no name needed only while one person is with her", value: "auto" },
];

export function pickListen(raw: string | undefined | null): ListenMode {
  const v = (raw ?? "").trim().toLowerCase();
  return (LISTEN_MODES as readonly string[]).includes(v) ? (v as ListenMode) : DEFAULT_LISTEN;
}

/**
 * The language of a voice session (2026-10-02). Chosen per /mari-join, never detected:
 *   en    - default. She hears English and speaks English.
 *   ar-EG - Egyptian Arabic. She hears Arabic (Deepgram language=ar-EG) and speaks Arabic script with the Arabic voice.
 * One fixed language means one speech-to-text request per utterance, with no language detection and no second try.
 */
export const SESSION_LANGUAGES = ["en", "ar-EG"] as const;
export type SessionLanguage = (typeof SESSION_LANGUAGES)[number];
export const DEFAULT_LANGUAGE: SessionLanguage = "en";

export const LANGUAGE_CHOICES: Array<{ name: string; value: SessionLanguage }> = [
  { name: "English (default)", value: "en" },
  { name: "Egyptian Arabic (ar-EG)", value: "ar-EG" },
];

/** Anything that isn't exactly Egyptian Arabic is English: she never guesses Arabic. */
export function pickLanguage(raw: string | undefined | null): SessionLanguage {
  return (raw ?? "").trim().toLowerCase() === "ar-eg" ? "ar-EG" : DEFAULT_LANGUAGE;
}

/** What an admin typed in /mari-join. null/undefined = "not specified, keep what she has". */
export interface VoiceOverrides {
  voice?: string | null;
  /** "" = explicitly no direction. */
  direction?: string | null;
  pitch?: number | null;
  listen?: string | null;
  /** "en" | "ar-EG" (2026-10-02). null/undefined = keep what she has. */
  language?: string | null;
}

/** The settings a live session actually speaks with. */
export interface VoiceSettings {
  voice: string;
  direction: string;
  pitch: number;
  listen: ListenMode;
  language: SessionLanguage;
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

/**
 * VOICE_DIRECTION: unset or blank means "use the default direction"; "none" (or off/default/clear)
 * means "deliberately no direction". sanitizeDirection alone can't tell those two apart.
 */
export function directionFromEnv(raw: string | undefined | null): string {
  if (raw === undefined || raw === null || raw.trim() === "") return DEFAULT_DIRECTION;
  return sanitizeDirection(raw);
}

export function clampPitch(value: number | null | undefined, fallback = 1): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(MAX_PITCH, Math.max(MIN_PITCH, value));
}

export function hasOverrides(o: VoiceOverrides): boolean {
  return o.voice != null || o.direction != null || o.pitch != null || o.listen != null || o.language != null;
}

/** Layers the admin's choices over a base; every unspecified field is kept. */
export function applyOverrides(base: VoiceSettings, o: VoiceOverrides): VoiceSettings {
  return {
    voice: o.voice != null ? pickVoice(o.voice) : base.voice,
    direction: o.direction != null ? sanitizeDirection(o.direction) : base.direction,
    pitch: o.pitch != null ? clampPitch(o.pitch, base.pitch) : base.pitch,
    listen: o.listen != null ? pickListen(o.listen) : base.listen,
    language: o.language != null ? pickLanguage(o.language) : base.language,
  };
}

/** "voice troy · direction cheerful · pitch 1.1" for the admin's confirmation message. */
export function describeOverrides(o: VoiceOverrides): string {
  const parts: string[] = [];
  if (o.voice != null) parts.push(`voice **${pickVoice(o.voice)}**`);
  if (o.direction != null) parts.push(o.direction === "" ? "no direction" : `direction **${o.direction}**`);
  if (o.pitch != null) parts.push(`pitch **${clampPitch(o.pitch)}**`);
  if (o.listen != null) parts.push(pickListen(o.listen) === "name" ? "listening: **needs her name**" : pickListen(o.listen) === "always" ? "listening: **no name needed**" : "listening: **auto**");
  if (o.language != null) parts.push(pickLanguage(o.language) === "ar-EG" ? "language: **Egyptian Arabic**" : "language: **English**");
  return parts.join(" · ");
}
