import { describe, expect, it, vi } from "vitest";
import { ChannelType, type ChatInputCommandInteraction } from "discord.js";
import type { AppContext } from "../../src/appContext.js";
import mariJoinCommand from "../../src/discord/commands/mariJoin.js";

const fakeLogger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

function setup(opts: { time?: string; date?: string; admin?: boolean; channelType?: ChannelType; timezone?: string; replaced?: boolean; saveFails?: boolean }) {
  const reply = vi.fn(async (_payload?: unknown) => undefined);
  const strings: Record<string, string | undefined> = { time: opts.time, date: opts.date };
  const interaction = {
    guildId: "guild-1",
    user: { id: "admin-1" },
    memberPermissions: { has: () => opts.admin !== false },
    member: { roles: [] },
    options: {
      getChannel: () => ({ id: "voice-9", type: opts.channelType ?? ChannelType.GuildVoice }),
      getString: (name: string) => strings[name] ?? null,
    },
    reply,
  } as unknown as ChatInputCommandInteraction;

  const schedule = vi.fn(async (p: { channelId: string; joinAt: Date }) => {
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
  it("is admin-only", async () => {
    const t = setup({ admin: false });
    await mariJoinCommand.execute(t.interaction, t.ctx);
    expect(t.schedule).not.toHaveBeenCalled();
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

  it("schedules a future time in the team timezone (tomorrow 19:00 Cairo = 16:00 or 17:00 UTC)", async () => {
    const t = setup({ date: "tomorrow", time: "19:00" });
    await mariJoinCommand.execute(t.interaction, t.ctx);
    const joinAt = t.schedule.mock.calls[0]![0].joinAt;
    expect([16, 17]).toContain(joinAt.getUTCHours());
    expect(joinAt.getUTCMinutes()).toBe(0);
    expect(joinAt.getTime()).toBeGreaterThan(Date.now());
    expect(text(t.reply)).toMatch(/<t:\d+:F>/);
  });

  it('accepts relative times like "2 hours"', async () => {
    const t = setup({ time: "2 hours" });
    await mariJoinCommand.execute(t.interaction, t.ctx);
    const diff = t.schedule.mock.calls[0]![0].joinAt.getTime() - Date.now();
    expect(diff).toBeGreaterThan(119 * 60_000);
    expect(diff).toBeLessThan(121 * 60_000);
  });

  it("rejects a date without a time", async () => {
    const t = setup({ date: "tomorrow" });
    await mariJoinCommand.execute(t.interaction, t.ctx);
    expect(t.schedule).not.toHaveBeenCalled();
    expect(text(t.reply)).toContain("needs a `time`");
  });

  it("rejects a time earlier today instead of silently joining now", async () => {
    const t = setup({ time: "00:01", timezone: "UTC" });
    // 00:01 UTC is more than five minutes ago unless the suite runs in the first minutes of the day.
    if (Date.now() % 86_400_000 < 10 * 60_000) return;
    await mariJoinCommand.execute(t.interaction, t.ctx);
    expect(t.schedule).not.toHaveBeenCalled();
    expect(text(t.reply)).toContain("already passed");
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
