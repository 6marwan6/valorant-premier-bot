import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChatInputCommandInteraction } from "discord.js";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { createDatabase, type Database } from "../../src/database/client.js";
import { buildAppContext, type AppContext } from "../../src/appContext.js";
import type { DiscordRestClient, ReplyPayload } from "../../src/discord/discordRest.js";
import { dispatchCommand } from "../../src/discord/interactions/dispatchCommand.js";
import { logger } from "../../src/config/logger.js";
import type { LlmClient } from "../../src/services/ai/llmClient.js";
import { matches } from "../../src/database/schema/matches.js";
import { matchEvents } from "../../src/database/schema/matchEvents.js";
import { memories } from "../../src/database/schema/memories.js";
import { memoryEvidence } from "../../src/database/schema/memoryEvidence.js";

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

// ---------------------------------------------------------------- fakes

/** Same spirit as phase3E2E/phase4E2E's fakes — sendChannelMessage for the recap, editChannelMessage for the roster-message refresh /complete-match triggers via syncAnnouncementIfPosted. */
function fakeDiscord() {
  const sent: Array<{ channelId: string; payload: ReplyPayload }> = [];
  const edits: Array<{ channelId: string; messageId: string; payload: ReplyPayload }> = [];
  let nextId = 1;

  const discord = {
    sendChannelMessage: vi.fn(async (channelId: string, payload: ReplyPayload) => {
      sent.push({ channelId, payload });
      return { id: `msg-${nextId++}` };
    }),
    editChannelMessage: vi.fn(async (channelId: string, messageId: string, payload: ReplyPayload) => {
      edits.push({ channelId, messageId, payload });
    }),
  };

  return { discord: discord as unknown as DiscordRestClient, raw: discord, sent, edits };
}

function fakeLlm(impl: (input: { system: string; user: string }) => Promise<string> | string) {
  const llm: LlmClient & { complete: ReturnType<typeof vi.fn> } = {
    model: "fake-model",
    complete: vi.fn(async (req: { system: string; user: string }) => ({
      text: await impl(req),
      model: "fake-model",
      inputTokens: 1,
      outputTokens: 1,
    })),
  };
  return llm;
}

type OptionValues = Record<string, string | number | undefined>;

function fakeInteraction(guildId: string, options: OptionValues) {
  const reply = vi.fn(async (_payload: { content: string; ephemeral?: boolean }) => undefined);
  const interaction = {
    commandName: "complete-match",
    guildId,
    memberPermissions: { has: () => true }, // native admin — permission gating is covered separately in tests/unit/permissions.test.ts
    member: { roles: [] as string[] },
    options: {
      getString: (name: string, required?: boolean) => {
        const v = options[name];
        if (v === undefined) {
          if (required) throw new Error(`missing required string option ${name}`);
          return null;
        }
        return String(v);
      },
      getInteger: (name: string, required?: boolean) => {
        const v = options[name];
        if (v === undefined) {
          if (required) throw new Error(`missing required integer option ${name}`);
          return null;
        }
        return Number(v);
      },
    },
    reply,
    deferred: false,
    replied: false,
    isRepliable: () => true,
  };
  return { interaction: interaction as unknown as ChatInputCommandInteraction, reply };
}

const eventsJson = (events: unknown[]) => JSON.stringify({ events });
const teamJson = (response: string) => JSON.stringify({ response });

describeIfDb("Phase 10 — /complete-match end to end (integration, plan sections 38-40)", () => {
  let db: Database;
  let pool: Pool;
  const guildId = `phase10-guild-${Date.now()}`;
  const channelId = `phase10-channel-${Date.now()}`;

  beforeAll(async () => {
    ({ db, pool } = createDatabase({ DATABASE_URL: databaseUrl! }));
  });

  afterAll(async () => {
    await pool.end();
  });

  async function makeCtx(llm: LlmClient | null) {
    const { discord, ...fakeD } = fakeDiscord();
    const ctx = buildAppContext({ discord, db, env: {} as any, logger, llm });
    await ctx.repositories.serverConfig.upsert(guildId, { timezone: "Europe/Berlin", matchChannelId: channelId });
    return { ctx, fakeD };
  }

  async function makePlayer(ctx: AppContext, discordUserId: string, displayName: string, memoryUsageEnabled = true) {
    const { player } = await ctx.repositories.players.upsertByDiscordUserId(guildId, discordUserId, {
      displayName,
      role: "DUELIST",
      agents: ["Jett"],
      preferredAgent: "Jett",
      roastIntensity: 50,
      personalReferencesEnabled: true,
      runningJokesEnabled: true,
      valorantReferencesEnabled: true,
      matchHistoryReferencesEnabled: true,
      memoryUsageEnabled,
      aiFollowUpsEnabled: true,
      protectedTopics: [],
    });
    return player;
  }

  it("full happy path: WIN + notes -> COMPLETED, extracted match_events, a TEAM memory, and an AI recap posted publicly", async () => {
    const llm = fakeLlm((req) =>
      req.system.includes("pull out individual noteworthy moments")
        ? eventsJson([{ type: "CLUTCH", description: "Ahmed won a 1v3.", player_name: "Ahmed" }])
        : teamJson("Somehow, we won. Ahmed remembered Jett has a gun today."),
    );
    const { ctx, fakeD } = await makeCtx(llm);
    const ahmed = await makePlayer(ctx, "user-ahmed", "Ahmed");

    const match = await ctx.repositories.matches.create({
      guildId,
      scheduledAt: new Date("2026-10-01T18:00:00Z"),
      timezone: "Europe/Berlin",
    });
    // Simulate the match having already been announced, so we can assert
    // the roster message gets refreshed (buttons dropped) too.
    await ctx.repositories.matches.update(match.id, {
      status: "CONFIRMATION_OPEN",
      announcementChannelId: channelId,
      announcementMessageId: "announce-1",
    });

    const { interaction, reply } = fakeInteraction(guildId, {
      match_id: match.id,
      result: "WIN",
      notes: "Ahmed clutched round 19.",
    });
    await dispatchCommand(interaction, ctx);

    // 1. Match itself
    const [updated] = await db.select().from(matches).where(eq(matches.id, match.id));
    expect(updated?.status).toBe("COMPLETED");
    expect(updated?.result).toBe("WIN");
    expect(updated?.notes).toBe("Ahmed clutched round 19.");
    expect(updated?.completedAt).not.toBeNull();

    // 2. Extracted match event, evidence-linked
    const events = await db.select().from(matchEvents).where(eq(matchEvents.matchId, match.id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "CLUTCH", playerId: ahmed.id, description: "Ahmed won a 1v3." });

    // 3. A TEAM-visibility MATCH_EVENT memory, evidenced back to the match event
    const playerMemories = await db.select().from(memories).where(eq(memories.playerId, ahmed.id));
    expect(playerMemories).toHaveLength(1);
    expect(playerMemories[0]).toMatchObject({ type: "MATCH_EVENT", visibility: "TEAM", content: "Ahmed won a 1v3." });
    const evidence = await db.select().from(memoryEvidence).where(eq(memoryEvidence.memoryId, playerMemories[0]!.id));
    expect(evidence).toMatchObject([{ sourceType: "MATCH_EVENT", sourceId: String(events[0]!.id) }]);

    // 4. Recap posted publicly, deterministic facts outside the LLM (plan section 14)
    expect(fakeD.sent).toHaveLength(1);
    expect(fakeD.sent[0]!.channelId).toBe(channelId);
    expect(fakeD.sent[0]!.payload.content).toContain("MATCH REPORT");
    expect(fakeD.sent[0]!.payload.content).toContain(`Match #${match.id}`);
    expect(fakeD.sent[0]!.payload.content).not.toContain("undefined");
    expect(fakeD.sent[0]!.payload.content).toContain("Somehow, we won.");

    // 5. Roster message refreshed (buttons gone now that status is COMPLETED)
    expect(fakeD.edits).toHaveLength(1);
    expect(fakeD.edits[0]!.payload.components ?? []).toHaveLength(0);

    // 6. Admin gets a clear ephemeral confirmation
    expect(reply).toHaveBeenCalledTimes(1);
    const payload = reply.mock.calls[0]![0] as { content: string; ephemeral?: boolean };
    expect(payload.content).toContain("recorded as a win");
    expect(payload.content).toContain("1 match event");
    expect(payload.ephemeral).toBe(true);
  });

  it("respects memoryUsageEnabled: false — the match event is still recorded, but no memory is created (plan section 9)", async () => {
    const llm = fakeLlm((req) =>
      req.system.includes("pull out individual noteworthy moments")
        ? eventsJson([{ type: "TOP_FRAG", description: "Omar led the scoreboard.", player_name: "Omar" }])
        : teamJson("GG team."),
    );
    const { ctx } = await makeCtx(llm);
    const omar = await makePlayer(ctx, "user-omar", "Omar", false);

    const match = await ctx.repositories.matches.create({
      guildId,
      scheduledAt: new Date("2026-10-02T18:00:00Z"),
      timezone: "Europe/Berlin",
    });

    const { interaction } = fakeInteraction(guildId, { match_id: match.id, result: "WIN", notes: "Omar top fragged." });
    await dispatchCommand(interaction, ctx);

    const events = await db.select().from(matchEvents).where(eq(matchEvents.matchId, match.id));
    expect(events).toHaveLength(1);
    expect(events[0]?.playerId).toBe(omar.id);

    const omarMemories = await db.select().from(memories).where(eq(memories.playerId, omar.id));
    expect(omarMemories).toHaveLength(0);
  });

  it("LOSS with no notes: completes cleanly with no extraction call and a safe generic recap when AI is off", async () => {
    const { ctx, fakeD } = await makeCtx(null); // AI disabled entirely
    const match = await ctx.repositories.matches.create({
      guildId,
      scheduledAt: new Date("2026-10-03T18:00:00Z"),
      timezone: "Europe/Berlin",
    });

    const { interaction, reply } = fakeInteraction(guildId, { match_id: match.id, result: "LOSS" });
    await dispatchCommand(interaction, ctx);

    const [updated] = await db.select().from(matches).where(eq(matches.id, match.id));
    expect(updated?.status).toBe("COMPLETED");
    expect(updated?.result).toBe("LOSS");
    expect(updated?.notes).toBeNull();

    expect(await db.select().from(matchEvents).where(eq(matchEvents.matchId, match.id))).toHaveLength(0);

    expect(fakeD.sent).toHaveLength(1);
    expect(fakeD.sent[0]!.payload.content).toContain("MATCH REPORT");
    expect(fakeD.sent[0]!.payload.content).not.toMatch(/undefined|\[object/);

    const payload = reply.mock.calls[0]![0] as { content: string };
    expect(payload.content).toContain("recorded as a loss");
  });

  it("blocks completing an already-COMPLETED match, and does not touch the DB or post anything again", async () => {
    const { ctx, fakeD } = await makeCtx(null);
    const match = await ctx.repositories.matches.create({
      guildId,
      scheduledAt: new Date("2026-10-04T18:00:00Z"),
      timezone: "Europe/Berlin",
    });
    await ctx.repositories.matches.update(match.id, { status: "COMPLETED", result: "WIN", completedAt: new Date() });

    const { interaction, reply } = fakeInteraction(guildId, { match_id: match.id, result: "LOSS" });
    await dispatchCommand(interaction, ctx);

    expect(fakeD.sent).toHaveLength(0);
    const payload = reply.mock.calls[0]![0] as { content: string };
    expect(payload.content).toMatch(/already.*completed|completed/i);

    // The original WIN is untouched — the blocked LOSS attempt never wrote anything.
    const [unchanged] = await db.select().from(matches).where(eq(matches.id, match.id));
    expect(unchanged?.result).toBe("WIN");
  });

  it("blocks completing when no match_channel is configured, before any AI call runs", async () => {
    const noChannelGuildId = `phase10-guild-nochannel-${Date.now()}`;
    const { discord, ...fakeD } = fakeDiscord();
    const llm = fakeLlm(() => teamJson("should never be called"));
    const ctx = buildAppContext({ discord, db, env: {} as any, logger, llm });
    await ctx.repositories.serverConfig.upsert(noChannelGuildId, { timezone: "Europe/Berlin" }); // no matchChannelId

    const match = await ctx.repositories.matches.create({
      guildId: noChannelGuildId,
      scheduledAt: new Date("2026-10-05T18:00:00Z"),
      timezone: "Europe/Berlin",
    });

    const { interaction, reply } = fakeInteraction(noChannelGuildId, { match_id: match.id, result: "WIN" });
    await dispatchCommand(interaction, ctx);

    const payload = reply.mock.calls[0]![0] as { content: string };
    expect(payload.content).toMatch(/\/setup/);
    expect(llm.complete).not.toHaveBeenCalled();
    expect(fakeD.sent).toHaveLength(0);

    const [unchanged] = await db.select().from(matches).where(eq(matches.id, match.id));
    expect(unchanged?.status).toBe("SCHEDULED"); // never marked COMPLETED
  });
});
