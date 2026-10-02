import { afterEach, describe, expect, it, vi } from "vitest";
import OpusScript from "opusscript";
import { ChannelType, type ChatInputCommandInteraction } from "discord.js";
import type { AppContext } from "../../src/appContext.js";
import mariVoiceCommand from "../../src/discord/commands/mariVoice.js";
import { encodeVoiceNote, waveformOf } from "../../src/modules/voice/oggOpus.js";
import { KeyPool } from "../../src/modules/voice/keyPool.js";
import { VoiceNoteError, buildVoiceNote, loadVoiceNoteSettings, type VoiceNoteSettings } from "../../src/modules/voice/voiceNote.js";

afterEach(() => vi.restoreAllMocks());

// -- a minimal Ogg reader, to check the container independently of the writer ---------------------------------
function parseOgg(buf: Buffer) {
  const pages: Array<{ type: number; granule: bigint; serial: number; seq: number; packets: Buffer[]; crcOk: boolean }> = [];
  const table = new Uint32Array(256).map((_, i) => {
    let r = i << 24;
    for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    return r >>> 0;
  });
  let at = 0;
  while (at < buf.length) {
    expect(buf.toString("ascii", at, at + 4)).toBe("OggS");
    const nseg = buf.readUInt8(at + 26);
    const lacing = [...buf.subarray(at + 27, at + 27 + nseg)];
    const bodyLen = lacing.reduce((a, b) => a + b, 0);
    const end = at + 27 + nseg + bodyLen;
    const page = Buffer.from(buf.subarray(at, end));
    const stored = page.readUInt32LE(22);
    page.writeUInt32LE(0, 22);
    let crc = 0;
    for (const b of page) crc = ((crc << 8) ^ table[((crc >>> 24) ^ b) & 0xff]!) >>> 0;
    const packets: Buffer[] = [];
    let p = at + 27 + nseg;
    let cur = 0;
    for (const l of lacing) {
      cur += l;
      if (l < 255) {
        packets.push(buf.subarray(p, p + cur));
        p += cur;
        cur = 0;
      }
    }
    pages.push({ type: buf.readUInt8(at + 5), granule: buf.readBigUInt64LE(at + 6), serial: buf.readUInt32LE(at + 14), seq: buf.readUInt32LE(at + 18), packets, crcOk: crc === stored });
    at = end;
  }
  return pages;
}

const sine = (seconds: number, amp = 12000) => Int16Array.from({ length: Math.round(48_000 * seconds) }, (_, i) => Math.round(Math.sin((2 * Math.PI * 440 * i) / 48_000) * amp));

describe("encodeVoiceNote (Ogg/Opus)", () => {
  const note = encodeVoiceNote(sine(2.5), 4242);
  const pages = parseOgg(note.ogg);

  it("writes a well-formed Ogg stream: BOS head, tags, audio pages, EOS last, valid CRCs, sequential pages", () => {
    expect(pages.every((p) => p.crcOk)).toBe(true);
    expect(pages[0]!.type).toBe(0x02);
    expect(pages[0]!.packets[0]!.toString("ascii", 0, 8)).toBe("OpusHead");
    expect(pages[0]!.packets[0]![9]).toBe(1); // mono
    expect(pages[1]!.packets[0]!.toString("ascii", 0, 8)).toBe("OpusTags");
    expect(pages.at(-1)!.type).toBe(0x04);
    expect(pages.map((p) => p.seq)).toEqual(pages.map((_, i) => i));
    expect(new Set(pages.map((p) => p.serial)).size).toBe(1);
  });

  it("round-trips: every packet decodes, to the right amount of audio", () => {
    const decoder = new OpusScript(48_000, 1, OpusScript.Application.VOIP);
    const frames = pages.slice(2).flatMap((p) => p.packets);
    expect(frames.length).toBe(Math.ceil((2.5 * 48_000) / 960));
    const out = frames.map((f) => decoder.decode(f));
    decoder.delete();
    expect(out.every((b) => b.length === 960 * 2)).toBe(true);
  });

  it("reports duration and a waveform within Discord's limits", () => {
    expect(note.durationSecs).toBeCloseTo(2.5, 1);
    const wf = Buffer.from(note.waveform, "base64");
    expect(wf.length).toBeGreaterThan(0);
    expect(wf.length).toBeLessThanOrEqual(256);
    expect(Math.max(...wf)).toBe(255); // normalized to the loudest bar
  });

  it("final granule position = pre-skip + the samples actually encoded", () => {
    expect(Number(pages.at(-1)!.granule)).toBe(312 + Math.round(2.5 * 48_000));
  });

  it("handles audio shorter than one frame, and rejects empty audio", () => {
    expect(parseOgg(encodeVoiceNote(sine(0.005)).ogg).at(-1)!.type).toBe(0x04);
    expect(() => encodeVoiceNote(new Int16Array(0))).toThrow(/no audio/);
  });

  it("a long note spans several audio pages", () => {
    const long = parseOgg(encodeVoiceNote(sine(8)).ogg);
    expect(long.length).toBeGreaterThan(4);
    expect(long.every((p) => p.crcOk)).toBe(true);
  });

  it("silence gives a flat (but valid) waveform", () => {
    expect(Buffer.from(waveformOf(new Int16Array(48_000)), "base64").every((b) => b === 0)).toBe(true);
  });
});

// -- buildVoiceNote ----------------------------------------------------------------------------------------------
/** A WAV the way Orpheus returns it: 24 kHz mono 16-bit. */
function wav(seconds = 0.4): Response {
  const n = Math.round(24_000 * seconds);
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36 + n * 2, 4);
  b.write("WAVEfmt ", 8, "ascii");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(24_000, 24);
  b.writeUInt32LE(48_000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "ascii");
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / 20) * 8000), 44 + i * 2);
  return new Response(new Uint8Array(b), { status: 200 });
}

const settings = (over: Partial<VoiceNoteSettings> = {}): VoiceNoteSettings => ({
  groqKeys: new KeyPool(["g1"]),
  voice: "hannah",
  direction: "flirty",
  pitch: 1.08,
  tts: { model: "canopylabs/orpheus-v1-english", arabic: { enabled: true, model: "canopylabs/orpheus-arabic-saudi", voice: "noura" } },
  ...over,
});

describe("buildVoiceNote", () => {
  it("speaks each chunk in order with the English voice and direction, and returns a valid Ogg", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => wav());
    const out = await buildVoiceNote({ text: "We are going to win tonight. Everybody lock in. No excuses, only wins!", settings: settings() });
    const bodies = spy.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string));
    expect(bodies.length).toBeGreaterThanOrEqual(1);
    expect(bodies.every((b) => b.model === "canopylabs/orpheus-v1-english" && b.voice === "hannah" && String(b.input).startsWith("[flirty] "))).toBe(true);
    expect(out.language).toBe("en");
    expect(out.durationSecs).toBeGreaterThan(0.5);
    expect(parseOgg(out.ogg).every((p) => p.crcOk)).toBe(true);
  });

  it("Arabic text goes to the Arabic model and voice, with no direction", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => wav());
    const out = await buildVoiceNote({ text: "يلا يا شباب النهاردة هنكسب ان شاء الله", settings: settings() });
    const body = JSON.parse((spy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toMatchObject({ model: "canopylabs/orpheus-arabic-saudi", voice: "noura" });
    expect(body.input.startsWith("[")).toBe(false);
    expect(out.language).toBe("ar");
  });

  it("nothing speakable is an 'empty' error and calls no API", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    await expect(buildVoiceNote({ text: "🔥🔥🔥", settings: settings() })).rejects.toMatchObject({ kind: "empty" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("a refused TTS request fails the whole note (never a half-spoken one)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("no", { status: 400 }));
    const err = await buildVoiceNote({ text: "hello there team", settings: settings() }).catch((e) => e);
    expect(err).toBeInstanceOf(VoiceNoteError);
    expect(err.kind).toBe("tts");
  });

  it("uses the key list: a key at its limit hands over to the next", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_u, init) => ((init?.headers as Record<string, string>).Authorization === "Bearer g1" ? new Response("{}", { status: 429 }) : wav()));
    await buildVoiceNote({ text: "hello there team", settings: settings({ groqKeys: new KeyPool(["g1", "g2"]) }) });
    expect(spy.mock.calls.map((c) => (c[1]!.headers as Record<string, string>).Authorization)).toEqual(["Bearer g1", "Bearer g2"]);
  });
});

describe("loadVoiceNoteSettings", () => {
  it("needs GROQ_API_KEY; reads the same variables as the live voice, with her defaults", () => {
    expect(loadVoiceNoteSettings({} as NodeJS.ProcessEnv)).toBeNull();
    const s = loadVoiceNoteSettings({ GROQ_API_KEY: "a,b" } as NodeJS.ProcessEnv)!;
    expect(s.groqKeys.size).toBe(2);
    expect(s).toMatchObject({ voice: "hannah", direction: "flirty", pitch: 1.08 });
    expect(s.tts.arabic).toMatchObject({ enabled: true, voice: "noura" });
    expect(loadVoiceNoteSettings({ GROQ_API_KEY: "a", VOICE_NAME: "diana", VOICE_DIRECTION: "none", VOICE_ARABIC: "0" } as NodeJS.ProcessEnv)).toMatchObject({ voice: "diana", direction: "" });
  });
});

// -- the command ---------------------------------------------------------------------------------------------------
function setup(opts: { admin?: boolean; message?: string; ai?: boolean; preview?: boolean; voiceMessageFails?: boolean; fileFails?: boolean; aiEnabled?: boolean; rewrite?: string | null; mention?: { id: string }; pingFails?: boolean }) {
  const reply = vi.fn(async (_p?: unknown) => undefined);
  const flags: Record<string, boolean | undefined> = { ai_voice: opts.ai, preview: opts.preview };
  const interaction = {
    guildId: "guild-1",
    channelId: "chan-here",
    user: { id: "admin-1" },
    memberPermissions: { has: () => opts.admin !== false },
    member: { roles: [] },
    options: {
      getString: (n: string) => (n === "message" ? (opts.message ?? "we are going to win tonight") : null),
      getNumber: () => null,
      getBoolean: (n: string) => flags[n] ?? null,
      getChannel: () => ({ id: "chan-9", type: ChannelType.GuildText }),
      getUser: () => opts.mention ?? null,
    },
    reply,
  } as unknown as ChatInputCommandInteraction;
  const sendVoiceMessage = vi.fn(async () => {
    if (opts.voiceMessageFails) throw new Error("Missing Permissions");
    return { id: "m1" };
  });
  const sendAudioFile = vi.fn(async () => {
    if (opts.fileFails) throw new Error("nope");
    return { id: "m2" };
  });
  const sendChannelMessage = vi.fn(async (..._a: unknown[]) => {
    if (opts.pingFails) throw new Error("Missing Access");
    return { id: "m3" };
  });
  const rewriteAdminMessage = vi.fn(async () => (opts.rewrite === null ? { source: "fallback" } : { source: "ai", text: opts.rewrite ?? "okay team, we win tonight, lock in" }));
  const ctx = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    discord: { sendVoiceMessage, sendAudioFile, sendChannelMessage },
    services: { ai: { enabled: opts.aiEnabled !== false, rewriteAdminMessage } },
    repositories: { serverConfig: { getByGuildId: vi.fn(async () => ({ adminRoleId: null, timezone: "Africa/Cairo" })) }, players: { listActiveByGuild: vi.fn(async () => []) } },
  } as unknown as AppContext;
  return { interaction, ctx, reply, sendVoiceMessage, sendAudioFile, sendChannelMessage, rewriteAdminMessage };
}
const said = (reply: ReturnType<typeof vi.fn>) => ((reply.mock.calls[0]?.[0] ?? {}) as { content?: string }).content ?? "";

describe("/mari-voice", () => {
  const withKey = () => {
    vi.stubEnv("GROQ_API_KEY", "g1");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => wav());
  };
  afterEach(() => vi.unstubAllEnvs());

  it("mention: the voice note goes first, then a tiny message pings ONLY that user", async () => {
    withKey();
    const t = setup({ mention: { id: "u42" } });
    await mariVoiceCommand.execute(t.interaction, t.ctx);
    expect(t.sendVoiceMessage).toHaveBeenCalledTimes(1);
    expect(t.sendChannelMessage).toHaveBeenCalledWith("chan-9", { content: "<@u42> 🎙️", suppressMentions: true, mentionUserIds: ["u42"] });
    expect(t.sendVoiceMessage.mock.invocationCallOrder[0]).toBeLessThan(t.sendChannelMessage.mock.invocationCallOrder[0]!);
    expect(said(t.reply)).toContain("pinging <@u42>");
  });

  it("no mention, no ping message", async () => {
    withKey();
    const t = setup({});
    await mariVoiceCommand.execute(t.interaction, t.ctx);
    expect(t.sendChannelMessage).not.toHaveBeenCalled();
  });

  it("a failed voice note never pings anyone", async () => {
    withKey();
    const t = setup({ mention: { id: "u42" }, voiceMessageFails: true, fileFails: true });
    await mariVoiceCommand.execute(t.interaction, t.ctx);
    expect(t.sendChannelMessage).not.toHaveBeenCalled();
  });

  it("if only the ping fails, the note is still sent and the admin is told", async () => {
    withKey();
    const t = setup({ mention: { id: "u42" }, pingFails: true });
    await mariVoiceCommand.execute(t.interaction, t.ctx);
    expect(t.sendVoiceMessage).toHaveBeenCalledTimes(1);
    expect(said(t.reply)).toContain("ping for <@u42> failed");
  });

  it("is admin only", async () => {
    withKey();
    const t = setup({ admin: false });
    await mariVoiceCommand.execute(t.interaction, t.ctx);
    expect(t.sendVoiceMessage).not.toHaveBeenCalled();
  });

  it("sends a voice message to the chosen channel and confirms privately", async () => {
    withKey();
    const t = setup({});
    await mariVoiceCommand.execute(t.interaction, t.ctx);
    expect(t.sendVoiceMessage).toHaveBeenCalledTimes(1);
    const [channel, note] = t.sendVoiceMessage.mock.calls[0] as unknown as [string, { ogg: Buffer; durationSecs: number; waveform: string }];
    expect(channel).toBe("chan-9");
    expect(parseOgg(note.ogg).every((p) => p.crcOk)).toBe(true);
    expect(said(t.reply)).toContain("<#chan-9>");
    expect(t.sendAudioFile).not.toHaveBeenCalled();
  });

  it("falls back to a plain audio file when the voice-message flow is refused, and says so", async () => {
    withKey();
    const t = setup({ voiceMessageFails: true });
    await mariVoiceCommand.execute(t.interaction, t.ctx);
    expect(t.sendAudioFile).toHaveBeenCalledTimes(1);
    expect(said(t.reply)).toContain("Send Voice Messages");
  });

  it("reports a clear error if even the file can't be posted", async () => {
    withKey();
    const t = setup({ voiceMessageFails: true, fileFails: true });
    await mariVoiceCommand.execute(t.interaction, t.ctx);
    expect(said(t.reply)).toContain("couldn't post");
  });

  it("without GROQ_API_KEY in the app it says so and sends nothing", async () => {
    vi.stubEnv("GROQ_API_KEY", "");
    const t = setup({});
    await mariVoiceCommand.execute(t.interaction, t.ctx);
    expect(said(t.reply)).toContain("GROQ_API_KEY");
    expect(t.sendVoiceMessage).not.toHaveBeenCalled();
  });

  it("a speech-service failure sends nothing", async () => {
    vi.stubEnv("GROQ_API_KEY", "g1");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("x", { status: 500 }));
    const t = setup({});
    await mariVoiceCommand.execute(t.interaction, t.ctx);
    expect(t.sendVoiceMessage).not.toHaveBeenCalled();
    expect(said(t.reply)).toContain("couldn't make the voice note");
  });

  it("ai_voice speaks the rewrite; preview shows it without sending", async () => {
    withKey();
    const t = setup({ ai: true });
    await mariVoiceCommand.execute(t.interaction, t.ctx);
    expect(t.rewriteAdminMessage).toHaveBeenCalledTimes(1);
    expect(t.sendVoiceMessage).toHaveBeenCalledTimes(1);

    const p = setup({ ai: true, preview: true });
    await mariVoiceCommand.execute(p.interaction, p.ctx);
    expect(p.sendVoiceMessage).not.toHaveBeenCalled();
    expect(said(p.reply)).toContain("Preview");
  });

  it("ai_voice with the AI off or a rejected rewrite sends nothing; preview without ai_voice is refused", async () => {
    withKey();
    for (const o of [{ ai: true, aiEnabled: false }, { ai: true, rewrite: null }, { preview: true }]) {
      const t = setup(o);
      await mariVoiceCommand.execute(t.interaction, t.ctx);
      expect(t.sendVoiceMessage).not.toHaveBeenCalled();
    }
  });
});

describe("DiscordRestClient.sendVoiceMessage (Discord's three-step flow)", () => {
  it("asks for an upload slot, PUTs the Ogg bytes, then posts a message with flag 8192, duration and waveform", async () => {
    const { DiscordRestClient } = await import("../../src/discord/discordRest.js");
    const post = vi.fn(async (route: string, _opts?: unknown) => (route.endsWith("/attachments") ? { attachments: [{ upload_url: "https://cdn.example/upload", upload_filename: "abc/voice-message.ogg" }] } : { id: "msg-1" }));
    const put = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 200 }));
    const client = new DiscordRestClient({ post } as never, "app-1");
    const note = encodeVoiceNote(sine(1));
    expect(await client.sendVoiceMessage("chan-1", note)).toEqual({ id: "msg-1" });

    expect(post.mock.calls[0]![0]).toBe("/channels/chan-1/attachments");
    expect((post.mock.calls[0]![1] as { body: { files: Array<{ file_size: number }> } }).body.files[0]!.file_size).toBe(note.ogg.length);
    const [url, init] = put.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://cdn.example/upload");
    expect(init.method).toBe("PUT");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("audio/ogg");
    const body = (post.mock.calls[1]![1] as { body: { flags: number; attachments: Array<Record<string, unknown>> } }).body;
    expect(body.flags).toBe(8192);
    expect(body.attachments[0]).toMatchObject({ id: "0", uploaded_filename: "abc/voice-message.ogg", duration_secs: note.durationSecs, waveform: note.waveform });
  });

  it("fails (so the command can fall back to a file) if there is no slot or the upload is refused", async () => {
    const { DiscordRestClient } = await import("../../src/discord/discordRest.js");
    const noSlot = new DiscordRestClient({ post: vi.fn(async () => ({ attachments: [] })) } as never, "a");
    await expect(noSlot.sendVoiceMessage("c", encodeVoiceNote(sine(0.5)))).rejects.toThrow(/upload slot/);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 403 }));
    const refused = new DiscordRestClient({ post: vi.fn(async () => ({ attachments: [{ upload_url: "https://x", upload_filename: "f" }] })) } as never, "a");
    await expect(refused.sendVoiceMessage("c", encodeVoiceNote(sine(0.5)))).rejects.toThrow(/403/);
  });
});
