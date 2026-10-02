import { describe, expect, it, vi } from "vitest";
import type { Client } from "discord.js";
import { ChannelType } from "discord.js";
import type { AppContext } from "../../src/appContext.js";
import {
  DEFAULT_LANGUAGE,
  pickLanguage,
  MAX_PITCH,
  MIN_PITCH,
  ORPHEUS_VOICES,
  applyOverrides,
  clampPitch,
  describeOverrides,
  hasOverrides,
  sanitizeDirection,
} from "../../src/modules/voice/voiceSettings.js";
import { VoiceManager, firstSentenceFirst, loadVoiceConfig, type VoiceConfig } from "../../worker/voice.js";
import mariJoinCommand from "../../src/discord/commands/mariJoin.js";

const base = { voice: "hannah", direction: "", pitch: 1, listen: "auto" as const, language: "en" as const };

describe("voice settings helpers", () => {
  it("keeps everything an admin left out", () => {
    expect(applyOverrides(base, {})).toEqual(base);
    expect(applyOverrides(base, { voice: "troy" })).toEqual({ voice: "troy", direction: "", pitch: 1, listen: "auto", language: "en" });
    expect(applyOverrides({ voice: "troy", direction: "cheerful", pitch: 1.1, listen: "auto", language: "en" }, { pitch: 0.9 })).toEqual({ voice: "troy", direction: "cheerful", pitch: 0.9, listen: "auto", language: "en" });
  });

  it("language: only exactly ar-EG is Arabic; anything else (or nothing) is English", () => {
    expect(pickLanguage("ar-EG")).toBe("ar-EG");
    expect(pickLanguage(" AR-eg ")).toBe("ar-EG");
    for (const v of ["en", "ar", "arabic", "auto", "", null, undefined]) expect(pickLanguage(v)).toBe("en");
    expect(DEFAULT_LANGUAGE).toBe("en");
  });

  it("language is layered like the other choices: kept when left out, switched when given", () => {
    expect(applyOverrides(base, {}).language).toBe("en");
    expect(applyOverrides(base, { language: "ar-EG" }).language).toBe("ar-EG");
    expect(applyOverrides({ ...base, language: "ar-EG" }, { voice: "troy" }).language).toBe("ar-EG"); // a live Arabic session keeps its language
    expect(applyOverrides({ ...base, language: "ar-EG" }, { language: "en" }).language).toBe("en");
    expect(hasOverrides({ language: "ar-EG" })).toBe(true);
    expect(describeOverrides({ language: "ar-EG" })).toContain("Egyptian Arabic");
  });

  it("an explicit empty direction clears it; null means unspecified", () => {
    const withDirection = { voice: "hannah", direction: "cheerful", pitch: 1, listen: "auto" as const, language: "en" as const };
    expect(applyOverrides(withDirection, { direction: "" }).direction).toBe("");
    expect(applyOverrides(withDirection, { direction: null }).direction).toBe("cheerful");
  });

  it("falls back to a real voice and clamps pitch to the supported range", () => {
    expect(applyOverrides(base, { voice: "not-a-voice" }).voice).toBe("hannah");
    expect(clampPitch(5)).toBe(MAX_PITCH);
    expect(clampPitch(0.1)).toBe(MIN_PITCH);
    expect(clampPitch(Number.NaN, 1)).toBe(1);
  });

  it("sanitizes direction words: letters only, 'none' clears", () => {
    expect(sanitizeDirection("[cheer]ful!!")).toBe("cheerful");
    expect(sanitizeDirection("None")).toBe("");
    expect(sanitizeDirection("a".repeat(80))).toHaveLength(30);
  });

  it("describes only what was set", () => {
    expect(hasOverrides({})).toBe(false);
    expect(hasOverrides({ pitch: 1.1 })).toBe(true);
    expect(describeOverrides({ voice: "troy", pitch: 1.1 })).toBe("voice **troy** · pitch **1.1**");
    expect(describeOverrides({ direction: "" })).toBe("no direction");
  });
});

describe("firstSentenceFirst (time to first audio)", () => {
  it("splits the first sentence off a packed first chunk", () => {
    expect(firstSentenceFirst(["omg hi. how are you? good", "second chunk"])).toEqual(["omg hi.", "how are you? good", "second chunk"]);
  });
  it("leaves a single-sentence first chunk and empty input alone", () => {
    expect(firstSentenceFirst(["just one sentence here"])).toEqual(["just one sentence here"]);
    expect(firstSentenceFirst([])).toEqual([]);
  });
});

describe("VOICE_SILENCE_MS", () => {
  const env = (extra: Record<string, string>) => ({ GROQ_API_KEY: "k", ...extra }) as NodeJS.ProcessEnv;
  it("defaults to 700 and is clamped to 300-2000", () => {
    expect(loadVoiceConfig("g", env({}))?.silenceMs).toBe(700);
    expect(loadVoiceConfig("g", env({ VOICE_SILENCE_MS: "50" }))?.silenceMs).toBe(300);
    expect(loadVoiceConfig("g", env({ VOICE_SILENCE_MS: "9000" }))?.silenceMs).toBe(2000);
    expect(loadVoiceConfig("g", env({ VOICE_SILENCE_MS: "1000" }))?.silenceMs).toBe(1000);
  });
});

const cfg: VoiceConfig = { groqApiKey: "k", guildId: "g1", channelId: null, voice: "hannah", ttsModel: "m", direction: "", pitch: 1, language: "en", debug: false };

async function managerWith(request: Record<string, unknown>) {
  const repo = {
    listDue: vi.fn(async () => [{ id: 1, joinAt: new Date(Date.now() - 60_000), ...request }]),
    claim: vi.fn(async () => true),
    finish: vi.fn(async () => undefined),
  };
  const members = [{ user: { bot: false } }];
  const channel = {
    id: "voice-9",
    guildId: "g1",
    isDMBased: () => false,
    isVoiceBased: () => true,
    members: { filter: (fn: (m: (typeof members)[number]) => boolean) => ({ size: members.filter(fn).length }) },
  };
  const client = { isReady: () => true, channels: { fetch: vi.fn(async () => channel) } } as unknown as Client;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const ctx = { logger, repositories: { voiceJoins: repo } } as unknown as AppContext;
  const manager = await VoiceManager.create(client, ctx, cfg);
  const connect = vi.fn(async () => true);
  (manager as unknown as { connect: typeof connect }).connect = connect;
  return { manager, repo, connect, channel };
}

describe("/mari-join voice options reach the worker", () => {
  it("a fresh join carries the request's voice, direction and pitch", async () => {
    const t = await managerWith({ channelId: "voice-9", voice: "troy", direction: "cheerful", pitch: 1.1 });
    await t.manager.runScheduledJoins();
    expect(t.connect).toHaveBeenCalledWith(t.channel, { voice: "troy", direction: "cheerful", pitch: 1.1 });
    expect(t.repo.finish).toHaveBeenCalledWith(1, "DONE");
  });

  it("if she is already in that channel the settings change live and she does not reconnect", async () => {
    const t = await managerWith({ channelId: "voice-9", voice: "diana", pitch: 0.9 });
    const session = { channelId: "voice-9", settings: { voice: "hannah", direction: "sad", pitch: 1, listen: "auto", language: "en" } };
    (t.manager as unknown as { session: unknown }).session = session;
    await t.manager.runScheduledJoins();
    expect(t.connect).not.toHaveBeenCalled();
    expect(session.settings).toEqual({ voice: "diana", direction: "sad", pitch: 0.9, listen: "auto", language: "en" }); // direction was not specified: kept
    expect(t.repo.finish).toHaveBeenCalledWith(1, "DONE");
  });
});

describe("/mari-join command", () => {
  const json = mariJoinCommand.data.toJSON();
  const opt = (name: string) => json.options?.find((o) => o.name === name) as Record<string, unknown> | undefined;

  it("offers voice (with the six voices), direction and pitch as optional options", () => {
    expect((opt("voice")?.choices as { value: string }[]).map((c) => c.value)).toEqual([...ORPHEUS_VOICES]);
    expect(opt("voice")?.required).toBeFalsy();
    expect(opt("direction")?.max_length).toBe(30);
    expect(opt("pitch")).toMatchObject({ min_value: MIN_PITCH, max_value: MAX_PITCH });
    expect(opt("channel")?.required).toBe(true);
  });

  function interactionWith(values: { voice?: string | null; direction?: string | null; pitch?: number | null }) {
    const reply = vi.fn(async () => undefined);
    const interaction = {
      guildId: "g1",
      user: { id: "admin" },
      memberPermissions: { has: () => true },
      member: { roles: [] },
      options: {
        getChannel: () => ({ id: "voice-9", type: ChannelType.GuildVoice }),
        getString: (name: string) => (name === "voice" ? (values.voice ?? null) : name === "direction" ? (values.direction ?? null) : null),
        getNumber: () => values.pitch ?? null,
      },
      reply,
    };
    const schedule = vi.fn(async (p: unknown) => ({ request: { id: 1, ...(p as object) }, replaced: null }));
    const ctx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      repositories: {
        serverConfig: { getByGuildId: vi.fn(async () => ({ guildId: "g1", adminRoleId: null, timezone: "Africa/Cairo" })) },
        voiceJoins: { schedule },
      },
    } as unknown as AppContext;
    return { interaction, reply, schedule, ctx };
  }

  it("stores the choices on the request and confirms them", async () => {
    const t = interactionWith({ voice: "troy", direction: "cheerful", pitch: 1.1 });
    await mariJoinCommand.execute(t.interaction as never, t.ctx);
    expect(t.schedule).toHaveBeenCalledWith(expect.objectContaining({ channelId: "voice-9", voice: "troy", direction: "cheerful", pitch: 1.1 }));
    const text = (t.reply.mock.calls[0] as unknown as [{ content: string }])[0].content;
    expect(text).toContain("voice **troy**");
    expect(text).toContain("pitch **1.1**");
  });

  it("stores nothing extra when no voice options are given", async () => {
    const t = interactionWith({});
    await mariJoinCommand.execute(t.interaction as never, t.ctx);
    expect(t.schedule).toHaveBeenCalledWith(expect.objectContaining({ voice: null, direction: null, pitch: null }));
  });

  it("'none' clears the direction; junk is rejected without scheduling anything", async () => {
    const clear = interactionWith({ direction: "none" });
    await mariJoinCommand.execute(clear.interaction as never, clear.ctx);
    expect(clear.schedule).toHaveBeenCalledWith(expect.objectContaining({ direction: "" }));

    const junk = interactionWith({ direction: "123 !!" });
    await mariJoinCommand.execute(junk.interaction as never, junk.ctx);
    expect(junk.schedule).not.toHaveBeenCalled();
    expect((junk.reply.mock.calls[0] as unknown as [{ content: string }])[0].content).toContain("plain words");
  });
});

describe("listen mode (2026-10-01 (b))", () => {
  it("/mari-join offers listen with three choices: group, just one person, auto", () => {
    const opt = mariJoinCommand.data.toJSON().options?.find((o) => o.name === "listen") as { choices?: Array<{ value: string }>; required?: boolean } | undefined;
    expect(opt?.required).toBeFalsy();
    expect(opt?.choices?.map((c) => c.value).sort()).toEqual(["always", "auto", "name"]);
  });

  it("applies per session, keeps the old value when unspecified, and ignores junk", () => {
    const base = { voice: "hannah", direction: "", pitch: 1, listen: "auto" as const, language: "en" as const };
    expect(applyOverrides(base, { listen: "name" }).listen).toBe("name");
    expect(applyOverrides({ ...base, listen: "always" }, { pitch: 1.1 }).listen).toBe("always");
    expect(applyOverrides(base, { listen: "nonsense" }).listen).toBe("auto");
    expect(hasOverrides({ listen: "always" })).toBe(true);
    expect(describeOverrides({ listen: "always" })).toContain("no name needed");
    expect(describeOverrides({ listen: "name" })).toContain("needs her name");
  });
});
