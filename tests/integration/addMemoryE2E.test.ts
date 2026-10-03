import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChatInputCommandInteraction, User } from "discord.js";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { createDatabase, type Database } from "../../src/database/client.js";
import { buildAppContext, type AppContext } from "../../src/appContext.js";
import { dispatchCommand } from "../../src/discord/interactions/dispatchCommand.js";
import { logger } from "../../src/config/logger.js";
import { memoryEvidence } from "../../src/database/schema/memoryEvidence.js";
import type { LlmClient } from "../../src/services/ai/llmClient.js";

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

type OptionValues = Record<string, string | undefined>;

function fakeInteraction(params: {
  guildId: string | null;
  isAdmin: boolean;
  adminUserId?: string;
  targetUserId?: string;
  options: OptionValues;
}) {
  const reply = vi.fn(async (_payload: { content: string; ephemeral?: boolean }) => undefined);
  const interaction = {
    commandName: "add-memory",
    guildId: params.guildId,
    user: { id: params.adminUserId ?? "admin-1", username: params.adminUserId ?? "admin-1" },
    memberPermissions: { has: () => params.isAdmin },
    member: { roles: [] as string[] },
    options: {
      getString: (name: string, required?: boolean) => {
        const v = params.options[name];
        if (v === undefined) {
          if (required) throw new Error(`missing required string option ${name}`);
          return null;
        }
        return v;
      },
      getUser: (name: string, required?: boolean) => {
        if (name !== "player" || !params.targetUserId) {
          if (required) throw new Error(`missing required user option ${name}`);
          return null;
        }
        return { id: params.targetUserId, username: params.targetUserId } as User;
      },
    },
    reply,
    deferred: false,
    replied: false,
    isRepliable: () => true,
  };
  return { interaction: interaction as unknown as ChatInputCommandInteraction, reply };
}

// ---------------------------------------------------------------- suite

describeIfDb("/add-memory — manual starter facts about players (2026-09-28)", () => {
  let db: Database;
  let pool: Pool;
  let ctx: AppContext;
  const guildId = `add-memory-guild-${Date.now()}`;

  beforeAll(async () => {
    ({ db, pool } = createDatabase({ DATABASE_URL: databaseUrl! }));
    ctx = buildAppContext({ discord: {} as never, db, env: {} as never, logger, llm: null as LlmClient | null });
    await ctx.repositories.serverConfig.upsert(guildId, { timezone: "Europe/Berlin" });
    await ctx.repositories.players.upsertByDiscordUserId(guildId, "player-a", {
      displayName: "Ahmed",
      role: "DUELIST",
      agents: ["Jett"],
      preferredAgent: "Jett",
      roastIntensity: 50,
      personalReferencesEnabled: true,
      runningJokesEnabled: true,
      valorantReferencesEnabled: true,
      matchHistoryReferencesEnabled: true,
      memoryUsageEnabled: true,
      aiFollowUpsEnabled: true,
      protectedTopics: ["Family"],
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("an admin can add a memory with an explicit visibility; it's confidence 1.0 with ADMIN_ENTRY evidence traced to them (plan section 25)", async () => {
    const { interaction, reply } = fakeInteraction({
      guildId,
      isAdmin: true,
      adminUserId: "admin-42",
      targetUserId: "player-a",
      options: { type: "RUNNING_JOKE", content: "Ahmed blames ping after every death.", visibility: "TEAM" },
    });

    await dispatchCommand(interaction, ctx);

    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
    const replyText = (reply.mock.calls[0]![0] as { content: string }).content;
    expect(replyText).toContain("Running joke");
    expect(replyText).toContain("Ahmed");
    expect(replyText).toContain("TEAM");

    const player = await ctx.repositories.players.getByDiscordUserId(guildId, "player-a");
    const saved = await ctx.repositories.memories.listByPlayer(player!.id);
    const memory = saved.find((m) => m.content === "Ahmed blames ping after every death.")!;
    expect(memory).toBeDefined();
    expect(memory.type).toBe("RUNNING_JOKE");
    expect(memory.visibility).toBe("TEAM");
    expect(memory.confidence).toBe(1);
    expect(memory.aiUsable).toBe(true);

    const evidence = await db.select().from(memoryEvidence).where(eq(memoryEvidence.memoryId, memory.id));
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.sourceType).toBe("ADMIN_ENTRY");
    expect(evidence[0]!.sourceId).toBe("admin-42");
  });

  it("defaults visibility to PUBLIC when omitted (plan section 24, revised 2026-09-29: admin lore exists so Mari can use it in the server)", async () => {
    const { interaction } = fakeInteraction({
      guildId,
      isAdmin: true,
      targetUserId: "player-a",
      options: { type: "HABIT", content: "Always picks Jett first in agent select." },
    });

    await dispatchCommand(interaction, ctx);

    const player = await ctx.repositories.players.getByDiscordUserId(guildId, "player-a");
    const saved = await ctx.repositories.memories.listByPlayer(player!.id);
    const memory = saved.find((m) => m.content === "Always picks Jett first in agent select.");
    expect(memory?.visibility).toBe("PUBLIC");
  });

  it("rejects a non-admin the same way every other admin command does", async () => {
    const { interaction, reply } = fakeInteraction({
      guildId,
      isAdmin: false,
      targetUserId: "player-a",
      options: { type: "HABIT", content: "should never be saved" },
    });

    await dispatchCommand(interaction, ctx);

    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringMatching(/administrator/i) }));
    const player = await ctx.repositories.players.getByDiscordUserId(guildId, "player-a");
    const saved = await ctx.repositories.memories.listByPlayer(player!.id);
    expect(saved.some((m) => m.content === "should never be saved")).toBe(false);
  });

  it("rejects an unregistered target player with a specific message, and saves nothing", async () => {
    const { interaction, reply } = fakeInteraction({
      guildId,
      isAdmin: true,
      targetUserId: "never-added",
      options: { type: "HABIT", content: "should never be saved" },
    });

    await dispatchCommand(interaction, ctx);

    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringMatching(/isn't registered/i) }));
  });

  it("a PROTECTED admin-entered memory never reaches the AI, exactly like a PROTECTED memory from any other source (plan section 24)", async () => {
    const { interaction: addProtected } = fakeInteraction({
      guildId,
      isAdmin: true,
      targetUserId: "player-a",
      options: { type: "TEAM_HISTORY", content: "SECRET-PROTECTED-FACT-should-never-leak", visibility: "PROTECTED" },
    });
    await dispatchCommand(addProtected, ctx);

    const { interaction: addTeam } = fakeInteraction({
      guildId,
      isAdmin: true,
      targetUserId: "player-a",
      options: { type: "TEAM_HISTORY", content: "VISIBLE-TEAM-FACT-should-appear", visibility: "TEAM" },
    });
    await dispatchCommand(addTeam, ctx);

    const llm = {
      model: "fake",
      complete: vi.fn(async (_req: { system: string; user: string }) => ({
        text: JSON.stringify({ response: "ok" }),
        model: "fake",
        inputTokens: 1,
        outputTokens: 1,
      })),
    };
    const aiCtx = buildAppContext({ discord: {} as never, db, env: {} as never, logger, llm });
    const player = (await aiCtx.repositories.players.getByDiscordUserId(guildId, "player-a"))!;
    const match = await aiCtx.repositories.matches.create({ guildId, scheduledAt: new Date(Date.now() + 86_400_000), timezone: "Europe/Berlin" } as never);

    await aiCtx.services.ai.respondToAttendance({ player, match, status: "PLAYING", includeMemories: true }); // the spotlight would otherwise decide

    const sentPrompt = (llm.complete.mock.calls[0]![0] as { user: string }).user;
    expect(sentPrompt).not.toContain("SECRET-PROTECTED-FACT-should-never-leak");
    expect(sentPrompt).toContain("VISIBLE-TEAM-FACT-should-appear");
  });
});
