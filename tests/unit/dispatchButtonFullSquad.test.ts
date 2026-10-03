import { describe, expect, it, vi } from "vitest";
import type { ButtonInteraction } from "discord.js";
import type { AppContext } from "../../src/appContext.js";
import { dispatchButton } from "../../src/discord/interactions/dispatchButton.js";
import type { AttendanceRow } from "../../src/database/schema/attendance.js";
import { makeMatch, makePlayer } from "./helpers/aiFixtures.js";

function attendance(userId: string, status: AttendanceRow["status"]): AttendanceRow {
  return {
    id: Number(userId.replace("user-", "")),
    guildId: "guild-1",
    matchId: 42,
    discordUserId: userId,
    discordDisplayName: userId,
    status,
    respondedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function setup(opts: { rows: AttendanceRow[]; changed?: boolean; status?: AttendanceRow["status"]; sendThrows?: boolean; aiEnabled?: boolean }) {
  const { rows, changed = true, status = "PLAYING", sendThrows = false, aiEnabled = false } = opts;
  const roster = [makePlayer({ id: 1, discordUserId: "user-1" }), makePlayer({ id: 2, discordUserId: "user-2", displayName: "Omar" })];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const discord = {
    sendChannelMessage: vi.fn(async () => {
      if (sendThrows) throw new Error("discord down");
      return { id: "m" };
    }),
    sendMentionMessage: vi.fn(async () => undefined),
  };
  const ctx = {
    logger,
    discord,
    repositories: { players: { listActivePlayersByGuild: vi.fn(async () => roster), getByDiscordUserId: vi.fn(async () => undefined) } },
    services: {
      attendance: { recordAttendance: vi.fn(async () => ({ ok: true as const, value: { match: makeMatch(), attendanceRows: rows, changed } })) },
      ai: { enabled: aiEnabled, respondToAttendance: vi.fn(async () => ({ text: "hi", source: "ai" as const })) },
      conversations: { endForAttendanceChange: vi.fn(async () => undefined) },
    },
  } as unknown as AppContext;
  const interaction = {
    customId: `attendance:42:${status}`,
    guildId: "guild-1",
    user: { id: "user-2", username: "omar", globalName: "Omar", avatar: null },
    member: null,
    deferred: true,
    replied: false,
    isRepliable: () => true,
    update: vi.fn(async (_payload: unknown) => undefined),
    reply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
  };
  return { discord, logger, interaction, run: () => dispatchButton(interaction as unknown as ButtonInteraction, ctx) };
}

const allIn = [attendance("user-1", "PLAYING"), attendance("user-2", "PLAYING")];

describe("dispatchButton — full squad celebration", () => {
  it("updates the roster with an embed card", async () => {
    const t = setup({ rows: allIn });
    await t.run();
    const payload = t.interaction.update.mock.calls[0]![0] as { embeds: unknown[]; components: unknown[] };
    expect(payload.embeds).toHaveLength(1);
    expect(payload.components).toHaveLength(1);
  });

  it("posts the celebration once, in the match channel, when the click completes the squad (works with the AI off)", async () => {
    const t = setup({ rows: allIn });
    await t.run();
    expect(t.discord.sendChannelMessage).toHaveBeenCalledTimes(1);
    expect(t.discord.sendChannelMessage).toHaveBeenCalledWith("chan-1", expect.objectContaining({ embeds: expect.any(Array) }));
  });

  it("does not post it for a repeated identical click", async () => {
    const t = setup({ rows: allIn, changed: false });
    await t.run();
    expect(t.discord.sendChannelMessage).not.toHaveBeenCalled();
  });

  it("does not post it while someone is still undecided or out", async () => {
    for (const rows of [[attendance("user-2", "PLAYING")], [attendance("user-1", "CANNOT_PLAY"), attendance("user-2", "PLAYING")]]) {
      const t = setup({ rows });
      await t.run();
      expect(t.discord.sendChannelMessage).not.toHaveBeenCalled();
    }
  });

  it("does not post it for a non-PLAYING click", async () => {
    const t = setup({ rows: allIn, status: "CANNOT_PLAY" });
    await t.run();
    expect(t.discord.sendChannelMessage).not.toHaveBeenCalled();
  });

  it("a Discord failure never turns a recorded response into an error (plan sections 48/66 #8)", async () => {
    const t = setup({ rows: allIn, sendThrows: true, aiEnabled: true });
    await t.run();
    expect(t.interaction.update).toHaveBeenCalledTimes(1);
    expect(t.interaction.reply).not.toHaveBeenCalled();
    expect(t.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "attendance.fullSquadPostFailed" }), expect.any(String));
    // ...and the player's own AI reaction still goes out afterwards.
    expect(t.discord.sendMentionMessage).toHaveBeenCalledTimes(1);
  });
});
