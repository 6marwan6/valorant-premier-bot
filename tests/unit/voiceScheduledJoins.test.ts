import { describe, expect, it, vi } from "vitest";
import type { Client } from "discord.js";
import type { AppContext } from "../../src/appContext.js";
import { VoiceManager, type VoiceConfig } from "../../worker/voice.js";

const cfg: VoiceConfig = { groqApiKey: "k", guildId: "g1", channelId: null, voice: "hannah", ttsModel: "m", direction: "", pitch: 1, language: "en", debug: false };
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

type Req = { id: number; channelId: string; joinAt: Date; language?: string | null };

async function setup(opts: { requests: Req[]; humans?: number; channelMissing?: boolean; claimWins?: boolean; connectOk?: boolean }) {
  const repo = {
    listDue: vi.fn(async () => opts.requests),
    claim: vi.fn(async () => opts.claimWins !== false),
    finish: vi.fn(async () => undefined),
  };
  const members = Array.from({ length: opts.humans ?? 0 }, () => ({ user: { bot: false } })).concat([{ user: { bot: true } }]);
  const channel = {
    id: "voice-9",
    guildId: "g1",
    isDMBased: () => false,
    isVoiceBased: () => true,
    members: { filter: (fn: (m: (typeof members)[number]) => boolean) => ({ size: members.filter(fn).length }) },
  };
  const client = {
    isReady: () => true,
    channels: { fetch: vi.fn(async () => (opts.channelMissing ? null : channel)) },
  } as unknown as Client;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const ctx = { logger, repositories: { voiceJoins: repo } } as unknown as AppContext;
  const manager = await VoiceManager.create(client, ctx, cfg);
  const connect = vi.fn(async () => opts.connectOk !== false);
  (manager as unknown as { connect: typeof connect }).connect = connect;
  return { manager, repo, connect, logger };
}

describe("VoiceManager.runScheduledJoins (/mari-join)", () => {
  it("joins when the time has come and someone is in the channel, then marks it DONE", async () => {
    const t = await setup({ requests: [{ id: 1, channelId: "voice-9", joinAt: minutesAgo(1) }], humans: 2 });
    await t.manager.runScheduledJoins();
    expect(t.repo.claim).toHaveBeenCalledWith(1);
    expect(t.connect).toHaveBeenCalledTimes(1);
    expect(t.repo.finish).toHaveBeenCalledWith(1, "DONE");
  });

  it("hands the request's language to the session (ar-EG), and a request without one leaves it unset", async () => {
    const ar = await setup({ requests: [{ id: 1, channelId: "voice-9", joinAt: minutesAgo(1), language: "ar-EG" }], humans: 1 });
    await ar.manager.runScheduledJoins();
    expect((ar.connect.mock.calls[0] as unknown as [unknown, { language?: string | null }])[1]).toMatchObject({ language: "ar-EG" });
    const plain = await setup({ requests: [{ id: 2, channelId: "voice-9", joinAt: minutesAgo(1) }], humans: 1 });
    await plain.manager.runScheduledJoins();
    expect((plain.connect.mock.calls[0] as unknown as [unknown, { language?: string | null }])[1].language ?? null).toBeNull();
  });

  it("marks FAILED when she couldn't connect (so the admin can see it in the logs)", async () => {
    const t = await setup({ requests: [{ id: 2, channelId: "voice-9", joinAt: minutesAgo(1) }], humans: 1, connectOk: false });
    await t.manager.runScheduledJoins();
    expect(t.repo.finish).toHaveBeenCalledWith(2, "FAILED");
  });

  it("waits, leaving the request PENDING, while the channel is empty", async () => {
    const t = await setup({ requests: [{ id: 3, channelId: "voice-9", joinAt: minutesAgo(1) }], humans: 0 });
    await t.manager.runScheduledJoins();
    expect(t.repo.claim).not.toHaveBeenCalled();
    expect(t.connect).not.toHaveBeenCalled();
    expect(t.repo.finish).not.toHaveBeenCalled();
  });

  it("expires a request nobody showed up for", async () => {
    const t = await setup({ requests: [{ id: 4, channelId: "voice-9", joinAt: minutesAgo(45) }], humans: 0 });
    await t.manager.runScheduledJoins();
    expect(t.repo.finish).toHaveBeenCalledWith(4, "EXPIRED");
    expect(t.connect).not.toHaveBeenCalled();
  });

  it("marks FAILED when the channel no longer exists / isn't visible", async () => {
    const t = await setup({ requests: [{ id: 5, channelId: "gone", joinAt: minutesAgo(1) }], channelMissing: true });
    await t.manager.runScheduledJoins();
    expect(t.repo.finish).toHaveBeenCalledWith(5, "FAILED");
    expect(t.connect).not.toHaveBeenCalled();
  });

  it("does nothing when another tick already claimed it (idempotent)", async () => {
    const t = await setup({ requests: [{ id: 6, channelId: "voice-9", joinAt: minutesAgo(1) }], humans: 1, claimWins: false });
    await t.manager.runScheduledJoins();
    expect(t.connect).not.toHaveBeenCalled();
    expect(t.repo.finish).not.toHaveBeenCalled();
  });

  it("never throws if the database is down (voice must not take the worker down)", async () => {
    const t = await setup({ requests: [] });
    t.repo.listDue.mockRejectedValueOnce(new Error("db down"));
    await expect(t.manager.runScheduledJoins()).resolves.toBeUndefined();
    expect(t.logger.error).toHaveBeenCalled();
  });
});
