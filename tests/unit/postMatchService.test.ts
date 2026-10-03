import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../src/config/logger.js";
import { PostMatchService } from "../../src/modules/matches/postMatchService.js";
import type { MatchEventRow } from "../../src/database/schema/matchEvents.js";
import { makeMatch, makePlayer } from "./helpers/aiFixtures.js";

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) as unknown as Logger & { warn: ReturnType<typeof vi.fn> };

/** Fakes for every collaborator; each test overrides only what it cares about. */
function build(overrides: {
  match?: ReturnType<typeof makeMatch> | undefined;
  roster?: ReturnType<typeof makePlayer>[];
  extracted?: Array<{ type: "CLUTCH"; description: string; playerName: string | null }>;
  createFromMatchEvent?: (...a: any[]) => Promise<unknown>;
  matchChannelId?: string | null;
} = {}) {
  const match = "match" in overrides ? overrides.match : makeMatch({ status: "CONFIRMATION_OPEN" });
  const matches = {
    getById: vi.fn(async () => match),
    update: vi.fn(async (_id: number, v: object) => ({ ...match!, ...v })),
  };
  const matchEvents = {
    createMany: vi.fn(async (inputs: any[]) => inputs.map((i, n) => ({ id: n + 1, createdAt: new Date(), ...i }) as MatchEventRow)),
  };
  const players = { listActivePlayersByGuild: vi.fn(async () => overrides.roster ?? [makePlayer({ id: 1, displayName: "Ahmed" })]) };
  const serverConfig = {
    getByGuildId: vi.fn(async () => ({ matchChannelId: "matchChannelId" in overrides ? overrides.matchChannelId : "chan-1" })),
  };
  const ai = {
    extractMatchEvents: vi.fn(async () => overrides.extracted ?? []),
    generateMatchRecap: vi.fn(async () => ({ source: "fallback" as const })),
  };
  const memories = { createFromMatchEvent: vi.fn(overrides.createFromMatchEvent ?? (async () => ({}))) };
  const log = logger();
  const service = new PostMatchService(matches as any, matchEvents as any, players as any, serverConfig as any, ai as any, memories as any, log);
  return { service, matches, matchEvents, ai, memories, log };
}

const run = (s: PostMatchService, notes: string | null = "Ahmed clutched.") =>
  s.completeMatch({ guildId: "guild-1", matchId: 42, result: "WIN", notes });

describe("PostMatchService.completeMatch (plan sections 39-40)", () => {
  it("a failing memory write never blocks completion or the recap; the match event is already saved (plan section 48's spirit)", async () => {
    const { service, matchEvents, ai, log } = build({
      extracted: [{ type: "CLUTCH", description: "Won a 1v3.", playerName: "Ahmed" }],
      createFromMatchEvent: async () => {
        throw new Error("db hiccup");
      },
    });

    const outcome = await run(service);

    expect(outcome.ok).toBe(true);
    expect(matchEvents.createMany).toHaveBeenCalledTimes(1);
    expect(ai.generateMatchRecap).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalled();
  });

  it("never attaches an event to a player the notes didn't resolve to (unresolved name -> playerId null, no memory)", async () => {
    const { service, matchEvents, memories } = build({
      extracted: [{ type: "CLUTCH", description: "Someone clutched.", playerName: "Nobody" }],
    });

    await run(service);

    expect(matchEvents.createMany.mock.calls[0]![0][0].playerId).toBeNull();
    expect(memories.createFromMatchEvent).not.toHaveBeenCalled();
  });

  it("skips extraction entirely when no notes were given", async () => {
    const { service, ai, matchEvents } = build();
    await run(service, null);
    expect(ai.extractMatchEvents).not.toHaveBeenCalled();
    expect(matchEvents.createMany).not.toHaveBeenCalled();
  });

  it("rejects a match from another guild as 'not found' without writing anything", async () => {
    const { service, matches } = build({ match: makeMatch({ guildId: "other-guild" }) });
    const outcome = await run(service);
    expect(outcome).toEqual({ ok: false, error: "No match #42 found in this server." });
    expect(matches.update).not.toHaveBeenCalled();
  });

  it("checks the match channel before marking COMPLETED", async () => {
    const { service, matches, ai } = build({ matchChannelId: null });
    const outcome = await run(service);
    expect(outcome.ok).toBe(false);
    expect(matches.update).not.toHaveBeenCalled();
    expect(ai.extractMatchEvents).not.toHaveBeenCalled();
  });
});
