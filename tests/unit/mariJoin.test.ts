import { describe, expect, it, vi } from "vitest";
import { ChannelType, type ChatInputCommandInteraction } from "discord.js";
import type { AppContext } from "../../src/appContext.js";
import mariJoinCommand from "../../src/discord/commands/mariJoin.js";

const fakeLogger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

function setup(opts: { time?: string; voice?: string; language?: string; admin?: boolean; channelType?: ChannelType; timezone?: string; replaced?: boolean; saveFails?: boolean }) {
  const reply = vi.fn(async (_payload?: unknown) => undefined);
  const strings: Record<string, string | undefined> = { time: opts.time, voice: opts.voice, language: opts.language };
  const interaction = {
    guildId: "guild-1",
    user: { id: "admin-1" },
    memberPermissions: { has: () => opts.admin !== false },
    member: { roles: [] },
    options: {
      getChannel: () => ({ id: "voice-9", type: opts.channelType ?? ChannelType.GuildVoice }),
      getString: (name: string) => strings[name] ?? null,
      getNumber: () => null,
    },
    reply,
  } as unknown as ChatInputCommandInteraction;

  const schedule = vi.fn(async (p: { channelId: string; joinAt: Date; language?: string | null }) => {
    if (opts.saveFails) throw new Error("db down");
    return { request: { id: 7, ...p }, replaced: opts.replaced ? { id: 6, channelId: "voice-old" } : null };
  });
  const ctx = {
    logger: fakeLogger(),
    repositories: {
      serverConfig: { getByGuildId: vi.fn(async () => ({ adminRoleId: null, timezone: opts.timezone ?? "Africa/Cairo" })) },
      voiceJoins: { schedule },
    },
  } as unknown as AppContext;
  return { interaction, ctx, reply, schedule };
}

const text = (reply: ReturnType<typeof vi.fn>) => ((reply.mock.calls[0]?.[0] ?? {}) as { content?: string }).content ?? "";

describe("/mari-join", () => {
  it("is open to every member: a non-admin can ask her to join", async () => {
    const t = setup({ admin: false });
    await mariJoinCommand.execute(t.interaction, t.ctx);
    expect(t.schedule).toHaveBeenCalledTimes(1);
    expect(t.schedule.mock.calls[0]![0]).toMatchObject({ channelId: "voice-9", requestedBy: "admin-1" });
  });

  it("a non-admin cannot change how she sounds (voice/direction/pitch/listen are admin-only)", async () => {
    const t = setup({ admin: false, voice: "troy" });
    await mariJoinCommand.execute(t.interaction, t.ctx);
    expect(t.schedule).not.toHaveBeenCalled();
    expect(text(t.reply)).toContain("only admins");
  });

  it("language is open to everyone: a non-admin can pick ar-EG, and it is stored on the request", async () => {
    const t = setup({ admin: false, language: "ar-EG" });
    await mariJoinCommand.execute(t.interaction, t.ctx);
    expect(t.schedule).toHaveBeenCalledTimes(1);
    expect(t.schedule.mock.calls[0]![0]).toMatchObject({ language: "ar-EG", voice: null });
    expect(text(t.reply)).toContain("Egyptian Arabic");
  });

  it("language left out is stored as null (English on a fresh join, a live session keeps its language)", async () => {
    const t = setup({ admin: false });
    await mariJoinCommand.execute(t.interaction, t.ctx);
    expect(t.schedule.mock.calls[0]![0].language).toBeNull();
  });

  it("a non-admin who sets language AND a style option is still refused", async () => {
    const t = setup({ admin: false, language: "ar-EG", voice: "troy" });
    await mariJoinCommand.execute(t.interaction, t.ctx);
    expect(t.schedule).not.toHaveBeenCalled();
  });

  it("an admin can still set the style options", async () => {
    const t = setup({ admin: true, voice: "troy" });
    await mariJoinCommand.execute(t.interaction, t.ctx);
    expect(t.schedule.mock.calls[0]![0]).toMatchObject({ voice: "troy" });
  });

  it("still needs /setup to have run", async () => {
    const t = setup({ admin: false });
    (t.ctx.repositories.serverConfig.getByGuildId as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    await mariJoinCommand.execute(t.interaction, t.ctx);
    expect(t.schedule).not.toHaveBeenCalled();
    expect(text(t.reply)).toContain("/setup");
  });

  it("with no time, schedules a join right now", async () => {
    const before = Date.now();
    const t = setup({});
    await mariJoinCommand.execute(t.interaction, t.ctx);
    const arg = t.schedule.mock.calls[0]![0];
    expect(arg).toMatchObject({ guildId: "guild-1", channelId: "voice-9", requestedBy: "admin-1" });
    expect(arg.joinAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(arg.joinAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(text(t.reply)).toContain("<#voice-9>");
    expect(text(t.reply)).toContain("few seconds");
  });

  it("schedules a clock time in the team timezone (19:00 Cairo = 16:00 or 17:00 UTC, today or tomorrow)", async () => {
    const t = setup({ time: "19:00" });
    await mariJoinCommand.execute(t.interaction, t.ctx);
    const joinAt = t.schedule.mock.calls[0]![0].joinAt;
    expect([16, 17]).toContain(joinAt.getUTCHours());
    expect(joinAt.getUTCMinutes()).toBe(0);
    expect(joinAt.getTime()).toBeGreaterThan(Date.now() - 6 * 60_000);
    expect(joinAt.getTime()).toBeLessThan(Date.now() + 24 * 3_600_000 + 60_000);
    expect(text(t.reply)).toMatch(/<t:\d+:F>/);
  });

  it('accepts relative times like "2 hours"', async () => {
    const t = setup({ time: "2 hours" });
    await mariJoinCommand.execute(t.interaction, t.ctx);
    const diff = t.schedule.mock.calls[0]![0].joinAt.getTime() - Date.now();
    expect(diff).toBeGreaterThan(119 * 60_000);
    expect(diff).toBeLessThan(121 * 60_000);
  });

  it("has no date option any more", () => {
    const names = (mariJoinCommand.data.toJSON().options ?? []).map((o) => o.name);
    expect(names).not.toContain("date");
    expect(names).toContain("time");
  });

  it("a clock time that already passed today means tomorrow, and says so", async () => {
    const t = setup({ time: "00:01", timezone: "UTC" });
    // 00:01 UTC is more than five minutes ago unless the suite runs in the first minutes of the day.
    if (Date.now() % 86_400_000 < 10 * 60_000) return;
    await mariJoinCommand.execute(t.interaction, t.ctx);
    const joinAt = t.schedule.mock.calls[0]![0].joinAt;
    expect(joinAt.getTime()).toBeGreaterThan(Date.now());
    expect(joinAt.getUTCHours()).toBe(0);
    expect(joinAt.getUTCMinutes()).toBe(1);
    expect(text(t.reply)).toContain("used tomorrow");
  });

  it("rejects garbage times with the parser's hint", async () => {
    const t = setup({ time: "whenever" });
    await mariJoinCommand.execute(t.interaction, t.ctx);
    expect(t.schedule).not.toHaveBeenCalled();
    expect(text(t.reply)).toContain("Couldn't understand");
  });

  it("refuses a non-voice channel", async () => {
    const t = setup({ channelType: ChannelType.GuildText });
    await mariJoinCommand.execute(t.interaction, t.ctx);
    expect(t.schedule).not.toHaveBeenCalled();
    expect(text(t.reply)).toContain("voice");
  });

  it("tells the admin when it replaced an earlier request", async () => {
    const t = setup({ time: "in 30 minutes", replaced: true });
    await mariJoinCommand.execute(t.interaction, t.ctx);
    expect(text(t.reply)).toContain("replaces");
    expect(text(t.reply)).toContain("<#voice-old>");
  });

  it("does not claim success if saving failed", async () => {
    const t = setup({ saveFails: true });
    await mariJoinCommand.execute(t.interaction, t.ctx);
    expect(text(t.reply)).toContain("❌");
    expect(text(t.reply)).not.toContain("✅");
  });

  it("is a guild-only command with a required voice channel option", () => {
    const json = mariJoinCommand.data.toJSON();
    expect(json.dm_permission).toBe(false);
    const channel = json.options?.find((o) => o.name === "channel") as { required?: boolean; channel_types?: number[] } | undefined;
    expect(channel?.required).toBe(true);
    expect(channel?.channel_types).toEqual([ChannelType.GuildVoice]);
  });
});
