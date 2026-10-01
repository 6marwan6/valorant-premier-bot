import { describe, expect, it, vi } from "vitest";
import type { Client } from "discord.js";
import type { AppContext } from "../../src/appContext.js";
import { VoiceManager, decideAnswer, isLikelyNoise, loadVoiceConfig, type VoiceConfig } from "../../worker/voice.js";
import { DEFAULT_DIRECTION, DEFAULT_PITCH, directionFromEnv } from "../../src/modules/voice/voiceSettings.js";

describe("decideAnswer (2026-10-01: name needed only when others are around)", () => {
  it("answers when her name is said, whoever else is in the channel", () => {
    expect(decideAnswer({ transcript: "Mari, are we playing?", humans: 4 })).toEqual({ answer: true, reason: "wakeWord" });
    expect(decideAnswer({ transcript: "hey mari", humans: 1 })).toEqual({ answer: true, reason: "wakeWord" });
    expect(decideAnswer({ transcript: "mary what's up", humans: null })).toEqual({ answer: true, reason: "wakeWord" });
  });

  it("with two or more humans, ignores speech without her name", () => {
    expect(decideAnswer({ transcript: "peek mid on three", humans: 2 })).toEqual({ answer: false, reason: "noWakeWord" });
    expect(decideAnswer({ transcript: "peek mid on three", humans: 5 })).toEqual({ answer: false, reason: "noWakeWord" });
  });

  it("with exactly one human, answers without her name", () => {
    expect(decideAnswer({ transcript: "what do you think about tonight", humans: 1 })).toEqual({ answer: true, reason: "alone" });
  });

  it("an unknown headcount is treated as several people (the cautious reading)", () => {
    expect(decideAnswer({ transcript: "what do you think about tonight", humans: null })).toEqual({ answer: false, reason: "noWakeWord" });
  });

  it("alone, junk transcripts Whisper makes out of silence or breathing are dropped", () => {
    for (const t of ["you", "Thank you.", "Thanks for watching!", "uh", " . ", "a"]) {
      expect(decideAnswer({ transcript: t, humans: 1 })).toEqual({ answer: false, reason: "noise" });
    }
  });

  it("isLikelyNoise keeps real short replies", () => {
    expect(isLikelyNoise("yes")).toBe(false);
    expect(isLikelyNoise("no way")).toBe(false);
    expect(isLikelyNoise("Thank you")).toBe(true);
  });
});

describe("voice defaults: a young, playful, flirty gamer girl", () => {
  const env = (e: Record<string, string>) => ({ GROQ_API_KEY: "k", ...e }) as NodeJS.ProcessEnv;

  it("defaults to the flirty direction and a slightly raised pitch", () => {
    const cfg = loadVoiceConfig("g", env({}));
    expect(cfg).toMatchObject({ direction: DEFAULT_DIRECTION, pitch: DEFAULT_PITCH, voice: "hannah", vad: true });
    expect(DEFAULT_DIRECTION).toBe("flirty");
    expect(DEFAULT_PITCH).toBeGreaterThan(1);
  });

  it("a blank VOICE_DIRECTION (as in .env.example) still means the default; 'none' means no direction", () => {
    expect(directionFromEnv("")).toBe(DEFAULT_DIRECTION);
    expect(directionFromEnv(undefined)).toBe(DEFAULT_DIRECTION);
    expect(directionFromEnv("none")).toBe("");
    expect(directionFromEnv("whisper")).toBe("whisper");
    expect(loadVoiceConfig("g", env({ VOICE_DIRECTION: "none" }))?.direction).toBe("");
  });

  it("reads the VAD and spoken-reply LLM settings", () => {
    const cfg = loadVoiceConfig("g", env({ VOICE_VAD: "0", VOICE_VAD_END_MS: "50", VOICE_LLM_MODEL: " fast-model ", VOICE_LLM_MAX_TOKENS: "180" }));
    expect(cfg).toMatchObject({ vad: false, vadEndMs: 200, llmModel: "fast-model", llmMaxTokens: 180 });
    const plain = loadVoiceConfig("g", env({}));
    expect(plain?.llmModel).toBeUndefined();
    expect(plain?.llmMaxTokens).toBeUndefined();
    expect(plain?.vadEndMs).toBe(450);
  });
});

// ---------------------------------------------------------------------------

type Member = { id: string; user: { bot: boolean } };
const human = (id: string): Member => ({ id, user: { bot: false } });
const bot = (id: string): Member => ({ id, user: { bot: true } });

function voiceChannel(id: string, members: Member[]) {
  const map = new Map(members.map((m) => [m.id, m]));
  return {
    id,
    guildId: "g1",
    isDMBased: () => false,
    isVoiceBased: () => true,
    isTextBased: () => true,
    members: Object.assign(map, { filter: (fn: (m: Member) => boolean) => ({ size: members.filter(fn).length }) }),
    send: vi.fn(async () => undefined),
  };
}

const baseCfg: VoiceConfig = { groqApiKey: "k", guildId: "g1", channelId: "voice-9", voice: "hannah", ttsModel: "m", direction: "flirty", pitch: 1.08, language: "en", debug: false };

async function setup(opts: { members?: Member[]; roster?: string[]; cfg?: Partial<VoiceConfig>; sendFails?: boolean; matchChannel?: string | null; ready?: boolean }) {
  const channel = voiceChannel("voice-9", opts.members ?? []);
  if (opts.sendFails) channel.send = vi.fn(async () => Promise.reject(new Error("Missing Permissions")));
  const matchText = { isTextBased: () => true, send: vi.fn(async () => undefined) };
  const client = {
    isReady: () => opts.ready !== false,
    channels: {
      fetch: vi.fn(async (id: string) => (id === "voice-9" ? channel : id === "match-1" ? matchText : null)),
      cache: { get: (id: string) => (id === "voice-9" ? channel : undefined) },
    },
  } as unknown as Client;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const roster = new Set(opts.roster ?? []);
  const ctx = {
    logger,
    repositories: {
      players: { getByDiscordUserId: vi.fn(async (_g: string, id: string) => (roster.has(id) ? { id: 1, active: true, discordUserId: id } : undefined)) },
      serverConfig: { getByGuildId: vi.fn(async () => ({ matchChannelId: opts.matchChannel === undefined ? "match-1" : opts.matchChannel })) },
      voiceJoins: { listDue: vi.fn(async () => []) },
    },
  } as unknown as AppContext;
  const manager = await VoiceManager.create(client, ctx, { ...baseCfg, ...opts.cfg });
  const connect = vi.fn(async () => true);
  (manager as unknown as { connect: typeof connect }).connect = connect;
  return { manager, channel, connect, logger, matchText, ctx };
}

describe("VoiceManager.autoJoinTick (she joins by herself, not only through /mari-join)", () => {
  it("joins when a roster player is already in the default channel (no voice-state event needed)", async () => {
    const t = await setup({ members: [human("p1"), bot("b")], roster: ["p1"] });
    await t.manager.autoJoinTick();
    expect(t.connect).toHaveBeenCalledWith(t.channel);
  });

  it("stays out when only non-roster people are in there", async () => {
    const t = await setup({ members: [human("stranger")], roster: ["p1"] });
    await t.manager.autoJoinTick();
    expect(t.connect).not.toHaveBeenCalled();
  });

  it("stays out of an empty channel", async () => {
    const t = await setup({ members: [bot("b")], roster: ["p1"] });
    await t.manager.autoJoinTick();
    expect(t.connect).not.toHaveBeenCalled();
  });

  it("does nothing without VOICE_CHANNEL_ID", async () => {
    const t = await setup({ members: [human("p1")], roster: ["p1"], cfg: { channelId: null } });
    await t.manager.autoJoinTick();
    expect(t.connect).not.toHaveBeenCalled();
  });

  it("does nothing while she is already in voice", async () => {
    const t = await setup({ members: [human("p1")], roster: ["p1"] });
    (t.manager as unknown as { session: unknown }).session = { channelId: "voice-9" };
    await t.manager.autoJoinTick();
    expect(t.connect).not.toHaveBeenCalled();
  });

  it("does not drag her straight back in after she was kicked, until the channel empties", async () => {
    const t = await setup({ members: [human("p1")], roster: ["p1"] });
    (t.manager as unknown as { suppressAutoJoin: boolean }).suppressAutoJoin = true;
    await t.manager.autoJoinTick();
    expect(t.connect).not.toHaveBeenCalled();

    t.channel.members.clear();
    await t.manager.autoJoinTick(); // empty: suppression resets
    t.channel.members.set("p1", human("p1"));
    await t.manager.autoJoinTick();
    expect(t.connect).toHaveBeenCalledTimes(1);
  });

  it("warns once, not every tick, when the configured channel isn't a visible voice channel", async () => {
    const t = await setup({ members: [], roster: [], cfg: { channelId: "gone" } });
    await t.manager.autoJoinTick();
    await t.manager.autoJoinTick();
    expect(t.logger.warn.mock.calls.filter((c) => (c[0] as { event: string }).event === "voice.autojoin.channelMissing")).toHaveLength(1);
  });
});

describe("the text message on entering", () => {
  const announce = (m: VoiceManager, ch: unknown) => (m as unknown as { announceJoin: (c: unknown) => Promise<void> }).announceJoin(ch);

  it("posts in the voice channel's own chat when it can", async () => {
    const t = await setup({});
    await announce(t.manager, t.channel);
    expect(t.channel.send).toHaveBeenCalledTimes(1);
    expect(t.matchText.send).not.toHaveBeenCalled();
  });

  it("falls back to the match channel when the voice chat isn't writable", async () => {
    const t = await setup({ sendFails: true });
    await announce(t.manager, t.channel);
    expect(t.matchText.send).toHaveBeenCalledTimes(1);
    expect(String((t.matchText.send.mock.calls[0] as unknown as [string])[0])).toContain("<#voice-9>");
  });

  it("logs why when neither place works, instead of staying silent", async () => {
    const t = await setup({ sendFails: true, matchChannel: null });
    await announce(t.manager, t.channel);
    const warned = t.logger.warn.mock.calls.map((c) => c[0] as { event: string; voiceChatError?: string });
    expect(warned.some((w) => w.event === "voice.announce.failed" && w.voiceChatError === "Missing Permissions")).toBe(true);
  });

  it("tells the players the new listening rule", async () => {
    const t = await setup({});
    await announce(t.manager, t.channel);
    const text = String((t.channel.send.mock.calls[0] as unknown as [string])[0]);
    expect(text).toMatch(/just you and me/i);
    expect(text).toMatch(/say my name/i);
  });
});

describe("headcount used for the name rule", () => {
  const humans = (m: VoiceManager, session: unknown) => (m as unknown as { humansInSession: (s: unknown) => number | null }).humansInSession(session);

  it("counts humans, not bots", async () => {
    const t = await setup({ members: [human("a"), human("b"), bot("mari")] });
    expect(humans(t.manager, { channelId: "voice-9" })).toBe(2);
  });

  it("is null (treated as several people) when the channel isn't cached", async () => {
    const t = await setup({ members: [human("a")] });
    expect(humans(t.manager, { channelId: "elsewhere" })).toBeNull();
  });
});
