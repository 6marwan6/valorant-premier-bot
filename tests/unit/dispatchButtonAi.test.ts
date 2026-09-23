import { describe, expect, it, vi } from "vitest";
import type { ButtonInteraction } from "discord.js";
import type { AppContext } from "../../src/appContext.js";
import { dispatchButton } from "../../src/discord/interactions/dispatchButton.js";
import { makeMatch, makePlayer } from "./helpers/aiFixtures.js";

function setup(opts: { changed?: boolean; aiEnabled?: boolean; roster?: ReturnType<typeof makePlayer>[]; aiThrows?: boolean; followUpThrows?: boolean } = {}) {
  const { changed = true, aiEnabled = true, roster = [makePlayer({ discordUserId: "user-1" })], aiThrows = false, followUpThrows = false } = opts;
  const match = makeMatch();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const respondToAttendance = vi.fn(async () => {
    if (aiThrows) throw new Error("ai exploded");
    return { text: "LET'S GOOO", source: "ai" as const };
  });
  const ctx = {
    logger,
    repositories: { players: { listActiveByGuild: vi.fn(async () => roster) } },
    services: {
      attendance: {
        recordAttendance: vi.fn(async () => ({
          ok: true as const,
          value: { match, attendanceRows: [], changed },
        })),
      },
      ai: { enabled: aiEnabled, respondToAttendance },
    },
  } as unknown as AppContext;

  const interaction = {
    customId: `attendance:${match.id}:PLAYING`,
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
  return { ctx, interaction, respondToAttendance, logger, run: () => dispatchButton(interaction as unknown as ButtonInteraction, ctx) };
}

describe("dispatchButton — Phase 6 AI followup", () => {
  it("sends the AI response as an ephemeral followup after updating the roster", async () => {
    const t = setup();
    await t.run();
    expect(t.interaction.update).toHaveBeenCalledTimes(1);
    expect(t.respondToAttendance).toHaveBeenCalledWith(expect.objectContaining({ status: "PLAYING" }));
    expect(t.interaction.followUp).toHaveBeenCalledWith({ content: "LET'S GOOO", ephemeral: true });
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
});
