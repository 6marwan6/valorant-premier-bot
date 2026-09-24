import { describe, expect, it, vi } from "vitest";
import type { ButtonInteraction } from "discord.js";
import type { AppContext } from "../../src/appContext.js";
import { dispatchButton } from "../../src/discord/interactions/dispatchButton.js";
import { makeMatch, makePlayer } from "./helpers/aiFixtures.js";

type StartOutcome =
  | { kind: "started"; conversation: { id: number }; openerText: string }
  | { kind: "unavailable" }
  | { kind: "already_open" };

function setup(
  opts: {
    changed?: boolean;
    aiEnabled?: boolean;
    roster?: ReturnType<typeof makePlayer>[];
    aiThrows?: boolean;
    followUpThrows?: boolean;
    status?: "PLAYING" | "CANNOT_PLAY" | "WANTS_TO_BUT_CANNOT";
    startOutcome?: StartOutcome;
    dmThrows?: boolean;
    aiFallback?: boolean;
  } = {},
) {
  const {
    changed = true,
    aiEnabled = true,
    roster = [makePlayer({ discordUserId: "user-1" })],
    aiThrows = false,
    followUpThrows = false,
    status = "PLAYING",
    startOutcome = { kind: "unavailable" } as StartOutcome,
    dmThrows = false,
    aiFallback = false,
  } = opts;
  const match = makeMatch();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const respondToAttendance = vi.fn(async () => {
    if (aiThrows) throw new Error("ai exploded");
    return aiFallback ? { text: "recorded", source: "fallback" as const } : { text: "LET'S GOOO", source: "ai" as const };
  });
  const conversations = {
    endForAttendanceChange: vi.fn(async () => undefined),
    startConsole: vi.fn(async () => startOutcome),
    recordOpener: vi.fn(async () => undefined),
    abandon: vi.fn(async () => undefined),
  };
  const discord = {
    sendMentionMessage: vi.fn(async () => ({ id: "pub-1" })),
    createDmChannel: vi.fn(async () => {
      if (dmThrows) throw Object.assign(new Error("Cannot send messages to this user"), { code: 50007 });
      return { id: "dm-1" };
    }),
    sendDirectMessage: vi.fn(async () => ({ id: "dm-msg-1" })),
  };
  const ctx = {
    logger,
    discord,
    repositories: { players: { listActiveByGuild: vi.fn(async () => roster) } },
    services: {
      attendance: {
        recordAttendance: vi.fn(async () => ({
          ok: true as const,
          value: { match, attendanceRows: [], changed },
        })),
      },
      ai: { enabled: aiEnabled, respondToAttendance },
      conversations,
    },
  } as unknown as AppContext;

  const interaction = {
    customId: `attendance:${match.id}:${status}`,
    guildId: "guild-1",
    user: { id: "user-1", username: "ahmed", globalName: "Ahmed" },
    member: null,
    deferred: true,
    replied: false,
    isRepliable: () => true,
    update: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => {
      if (followUpThrows) throw new Error("discord down");
    }),
  };
  return { ctx, interaction, respondToAttendance, logger, conversations, discord, run: () => dispatchButton(interaction as unknown as ButtonInteraction, ctx) };
}

describe("dispatchButton — Phase 6 AI followup", () => {
  it.each(["PLAYING", "CANNOT_PLAY"] as const)("%s: posts the AI message publicly, @mentioning the player, after updating the roster", async (status) => {
    const t = setup({ status });
    await t.run();
    expect(t.interaction.update).toHaveBeenCalledTimes(1);
    expect(t.respondToAttendance).toHaveBeenCalledWith(expect.objectContaining({ status }));
    expect(t.discord.sendMentionMessage).toHaveBeenCalledWith("chan-1", "LET'S GOOO", "user-1");
    expect(t.interaction.followUp).not.toHaveBeenCalled();
  });

  it("an AI failure never posts the fallback publicly — it goes to the player privately", async () => {
    const t = setup({ aiFallback: true });
    await t.run();
    expect(t.discord.sendMentionMessage).not.toHaveBeenCalled();
    expect(t.interaction.followUp).toHaveBeenCalledWith({ content: "recorded", ephemeral: true });
  });

  it("does nothing AI-related for a repeated identical click (idempotency, plan section 50)", async () => {
    const t = setup({ changed: false });
    await t.run();
    expect(t.interaction.update).toHaveBeenCalledTimes(1);
    expect(t.respondToAttendance).not.toHaveBeenCalled();
    expect(t.interaction.followUp).not.toHaveBeenCalled();
  });

  it("behaves exactly like Phase 5 when the AI is not configured", async () => {
    const t = setup({ aiEnabled: false });
    await t.run();
    expect(t.respondToAttendance).not.toHaveBeenCalled();
    expect(t.interaction.followUp).not.toHaveBeenCalled();
  });

  it("skips the AI for a clicker with no active player profile", async () => {
    const t = setup({ roster: [makePlayer({ discordUserId: "someone-else" })] });
    await t.run();
    expect(t.respondToAttendance).not.toHaveBeenCalled();
  });

  it.each([
    ["the AI service throws", { aiThrows: true }],
    ["delivering the followup fails", { followUpThrows: true }],
  ])("never reports a recorded attendance as failed when %s (plan sections 48/66 #8)", async (_name, opts) => {
    const t = setup(opts);
    await t.run();
    expect(t.interaction.update).toHaveBeenCalledTimes(1);
    expect(t.interaction.reply).not.toHaveBeenCalled();
    // The only followUp call (if any) is the AI one, never the failure message.
    for (const call of t.interaction.followUp.mock.calls as unknown as Array<[{ content: string }]>) {
      expect(call[0].content).not.toMatch(/went wrong/i);
    }
  });

  it("ends any open conversation when the player changes their answer", async () => {
    const t = setup({ status: "PLAYING" });
    await t.run();
    expect(t.conversations.endForAttendanceChange).toHaveBeenCalledTimes(1);
    expect(t.conversations.endForAttendanceChange).toHaveBeenCalledWith(1, 42, "PLAYING");
  });

  it("does not touch conversations on a repeated identical click", async () => {
    const t = setup({ changed: false, status: "WANTS_TO_BUT_CANNOT" });
    await t.run();
    expect(t.conversations.endForAttendanceChange).not.toHaveBeenCalled();
    expect(t.conversations.startConsole).not.toHaveBeenCalled();
  });

  it("CELEBRATE / ROAST never open a conversation", async () => {
    for (const status of ["PLAYING", "CANNOT_PLAY"] as const) {
      const t = setup({ status });
      await t.run();
      expect(t.conversations.startConsole).not.toHaveBeenCalled();
      expect(t.discord.sendDirectMessage).not.toHaveBeenCalled();
    }
  });

  describe("WANTS_TO_BUT_CANNOT (CONSOLE, Phase 7)", () => {
    it("opens a DM conversation and only points the player at it", async () => {
      const t = setup({
        status: "WANTS_TO_BUT_CANNOT",
        startOutcome: { kind: "started", conversation: { id: 7 }, openerText: "NOOO 😭 What happened?" },
      });
      await t.run();
      expect(t.discord.createDmChannel).toHaveBeenCalledWith("user-1");
      expect(t.discord.sendDirectMessage).toHaveBeenCalledTimes(1);
      const dm = (t.discord.sendDirectMessage.mock.calls[0] as unknown as [string, { content: string; components: unknown[] }])[1];
      expect(dm.content).toContain("NOOO 😭 What happened?");
      expect(dm.components).toHaveLength(1);
      expect(t.conversations.recordOpener).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 7, dmChannelId: "dm-1", discordMessageId: "dm-msg-1" }),
      );
      expect(t.respondToAttendance).not.toHaveBeenCalled();
      // Publicly: only the fixed neutral line — no AI text, no reason, no roast.
      expect(t.discord.sendMentionMessage).toHaveBeenCalledTimes(1);
      expect(t.discord.sendMentionMessage).toHaveBeenCalledWith("chan-1", "can't make it this time 🟡", "user-1");
      expect(t.interaction.followUp).toHaveBeenCalledTimes(1);
      expect(t.interaction.followUp).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true, content: expect.stringContaining("DM") }));
    });

    it("falls back to the Phase 6 single message when a conversation isn't available (AI follow-ups off)", async () => {
      const t = setup({ status: "WANTS_TO_BUT_CANNOT", startOutcome: { kind: "unavailable" } });
      await t.run();
      expect(t.respondToAttendance).toHaveBeenCalledWith(expect.objectContaining({ status: "WANTS_TO_BUT_CANNOT" }));
      expect(t.interaction.followUp).toHaveBeenCalledWith({ content: "LET'S GOOO", ephemeral: true }); // private
      expect(t.discord.sendMentionMessage).toHaveBeenCalledWith("chan-1", "can't make it this time 🟡", "user-1");
      expect(t.discord.sendMentionMessage).toHaveBeenCalledTimes(1);
    });

    it("says nothing at all when a conversation is already open (idempotency, plan section 50)", async () => {
      const t = setup({ status: "WANTS_TO_BUT_CANNOT", startOutcome: { kind: "already_open" } });
      await t.run();
      expect(t.respondToAttendance).not.toHaveBeenCalled();
      expect(t.interaction.followUp).not.toHaveBeenCalled();
      expect(t.discord.sendMentionMessage).not.toHaveBeenCalled();
    });

    it("closed DMs: abandons the conversation and falls back to the single message plus a short note", async () => {
      const t = setup({
        status: "WANTS_TO_BUT_CANNOT",
        dmThrows: true,
        startOutcome: { kind: "started", conversation: { id: 8 }, openerText: "hi" },
      });
      await t.run();
      expect(t.conversations.abandon).toHaveBeenCalledWith(8, "DM_UNAVAILABLE");
      expect(t.respondToAttendance).toHaveBeenCalledTimes(1);
      const call = (t.interaction.followUp.mock.calls[0] as unknown as [{ content: string; ephemeral: boolean }])[0];
      expect(call.content).toContain("LET'S GOOO");
      expect(call.content).toMatch(/couldn't/i);
      expect(call.ephemeral).toBe(true);
      expect(t.interaction.reply).not.toHaveBeenCalled();
    });
  });
});
