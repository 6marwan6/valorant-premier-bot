import { describe, expect, it, vi } from "vitest";
import type { Client } from "discord.js";
import type { AppContext } from "../../src/appContext.js";
import { VoiceManager, pcmFrames, type VoiceConfig } from "../../worker/voice.js";

const cfg: VoiceConfig = { groqApiKey: "k", guildId: "g1", channelId: null, voice: "hannah", ttsModel: "m", direction: "", pitch: 1, language: "en", debug: false };

describe("pcmFrames", () => {
  it("yields whole 20 ms frames (3840 bytes) and zero-pads the last one", () => {
    const pcm = Buffer.alloc(3840 * 2 + 100, 7);
    const frames = [...pcmFrames(pcm)];
    expect(frames).toHaveLength(3);
    expect(frames.every((f) => f.length === 3840)).toBe(true);
    expect(Buffer.concat(frames).subarray(0, pcm.length).equals(pcm)).toBe(true);
    expect(frames[2]!.subarray(100).every((b) => b === 0)).toBe(true);
  });

  it("yields nothing for empty audio", () => {
    expect([...pcmFrames(Buffer.alloc(0))]).toEqual([]);
  });
});

/** A fake of the slice of @discordjs/voice that recover() touches. */
function setup(opts: { closeCode?: number; reason?: number; readyAfter?: number; gatewayReady?: boolean }) {
  const Status = { Ready: "ready", Disconnected: "disconnected", Destroyed: "destroyed", Signalling: "signalling", Connecting: "connecting" };
  let rejoins = 0;
  const connection = {
    state: { status: Status.Disconnected, reason: opts.reason, closeCode: opts.closeCode },
    rejoin: vi.fn(() => {
      rejoins++;
      connection.state = { status: "signalling" } as never;
      return true;
    }),
    destroy: vi.fn(),
  };
  // Succeeds on the Nth rejoin (readyAfter), otherwise rejects like a timeout.
  const entersState = vi.fn(async (_target: unknown, status: string) => {
    if (status === Status.Ready && opts.readyAfter !== undefined && rejoins >= opts.readyAfter) {
      connection.state = { status: Status.Ready } as never;
      return;
    }
    if (status === Status.Signalling && opts.closeCode === 4014 && opts.readyAfter === 0) return; // channel move signalled
    if (status === Status.Connecting) throw new Error("timeout");
    throw new Error("timeout");
  });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const client = { isReady: () => opts.gatewayReady !== false } as unknown as Client;
  return { Status, connection, entersState, logger, client };
}

async function build(t: ReturnType<typeof setup>) {
  const ctx = { logger: t.logger, repositories: {} } as unknown as AppContext;
  const manager = await VoiceManager.create(t.client, ctx, cfg);
  (manager as unknown as { deps: unknown }).deps = { dv: { entersState: t.entersState, VoiceConnectionStatus: t.Status } };
  (manager as unknown as { recoverDelayMs: number }).recoverDelayMs = 0;
  const session = { channelId: "c", connection: t.connection, player: { stop: vi.fn() }, capturing: new Set(), busy: false };
  (manager as unknown as { session: unknown }).session = session;
  return { manager, session, current: () => (manager as unknown as { session: unknown }).session };
}

describe("VoiceManager.recover (dropped voice connection)", () => {
  it("rejoins and keeps her in the channel when the drop was a network blip / gateway reconnect", async () => {
    const t = setup({ reason: 1, readyAfter: 1 });
    const m = await build(t);
    await m.manager.recover(m.session as never, t.connection as never);
    expect(t.connection.rejoin).toHaveBeenCalledTimes(1);
    expect(t.connection.destroy).not.toHaveBeenCalled();
    expect(m.current()).toBe(m.session);
    expect(t.logger.info).toHaveBeenCalledWith(expect.objectContaining({ event: "voice.conn.recovered", attempt: 1 }), expect.anything());
  });

  it("tries again after a failed attempt, up to 4 times, then leaves", async () => {
    const t = setup({ reason: 1 }); // never becomes ready
    const m = await build(t);
    await m.manager.recover(m.session as never, t.connection as never);
    expect(t.connection.rejoin).toHaveBeenCalledTimes(4);
    expect(t.connection.destroy).toHaveBeenCalledTimes(1);
    expect(m.current()).toBeNull();
  });

  it("succeeds on a later attempt", async () => {
    const t = setup({ reason: 1, readyAfter: 3 });
    const m = await build(t);
    await m.manager.recover(m.session as never, t.connection as never);
    expect(t.connection.rejoin).toHaveBeenCalledTimes(3);
    expect(t.connection.destroy).not.toHaveBeenCalled();
  });

  it("does not rejoin after a 4014 (moved/kicked); leaves if Discord never signals a move", async () => {
    const t = setup({ closeCode: 4014 });
    const m = await build(t);
    await m.manager.recover(m.session as never, t.connection as never);
    expect(t.connection.rejoin).not.toHaveBeenCalled();
    expect(t.connection.destroy).toHaveBeenCalledTimes(1);
  });

  it("stays if a 4014 turns out to be a channel move (Discord signals it)", async () => {
    const t = setup({ closeCode: 4014, readyAfter: 0 });
    const m = await build(t);
    await m.manager.recover(m.session as never, t.connection as never);
    expect(t.connection.destroy).not.toHaveBeenCalled();
    expect(m.current()).toBe(m.session);
  });

  it("ignores a second 'disconnected' while a reconnect is already running", async () => {
    const t = setup({ reason: 1, readyAfter: 1 });
    const m = await build(t);
    await Promise.all([m.manager.recover(m.session as never, t.connection as never), m.manager.recover(m.session as never, t.connection as never)]);
    expect(t.connection.rejoin).toHaveBeenCalledTimes(1);
  });

  it("does nothing if she already left", async () => {
    const t = setup({ reason: 1, readyAfter: 1 });
    const m = await build(t);
    (m.manager as unknown as { session: unknown }).session = null;
    await m.manager.recover(m.session as never, t.connection as never);
    expect(t.connection.rejoin).not.toHaveBeenCalled();
  });

  it("logs the reason and close code so the next log shows WHY it dropped", async () => {
    const t = setup({ reason: 1, readyAfter: 1 });
    const m = await build(t);
    await m.manager.recover(m.session as never, t.connection as never);
    expect(t.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "voice.conn.disconnected", reason: 1 }), expect.anything());
  });
});
