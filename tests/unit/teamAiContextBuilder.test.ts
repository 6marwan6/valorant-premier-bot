import { describe, expect, it } from "vitest";
import {
  buildMatchEventExtractionContext,
  buildMatchHypeContext,
  buildMatchRecapContext,
} from "../../src/modules/ai/teamAiContextBuilder.js";
import { makeMatch, makePlayer } from "./helpers/aiFixtures.js";
import type { MatchEventRow } from "../../src/database/schema/matchEvents.js";

function makeMatchEvent(overrides: Partial<MatchEventRow> = {}): MatchEventRow {
  return {
    id: 1,
    matchId: 42,
    playerId: 1,
    type: "CLUTCH",
    description: "Ahmed won a 1v3.",
    createdAt: new Date("2026-09-18T19:30:00Z"),
    ...overrides,
  };
}

describe("buildMatchHypeContext (plan section 38)", () => {
  it("puts roster/agent facts and match facts in the user message, not the system prompt (plan section 56)", () => {
    const roster = [makePlayer({ id: 1, displayName: "Ahmed", role: "DUELIST", preferredAgent: "Jett" })];
    const ctx = buildMatchHypeContext({ match: makeMatch(), roster });
    expect(ctx.user).not.toContain("Opponent"); // matches have no opponent anymore (plan section 11, revised)
    expect(ctx.user).toContain("Ahmed (DUELIST, Jett)");
    expect(ctx.system).not.toContain("Ahmed");
    expect(ctx.user).toContain("Kickoff:");
    expect(ctx.system).not.toContain("Kickoff:");
    expect(ctx.user).toContain("MODE: MATCH_HYPE");
  });

  it("respects a player's own valorantReferencesEnabled=false (same rule as the per-player builder)", () => {
    const roster = [makePlayer({ displayName: "Omar", valorantReferencesEnabled: false })];
    const ctx = buildMatchHypeContext({ match: makeMatch(), roster });
    expect(ctx.user).not.toContain("DUELIST");
    expect(ctx.user).toContain("Omar (do not mention role, agents or Valorant specifics)");
  });

  it("unions every roster player's protected topics (a team message can mention any of them)", () => {
    const roster = [
      makePlayer({ id: 1, displayName: "Ahmed", protectedTopics: ["Family"] }),
      makePlayer({ id: 2, displayName: "Omar", protectedTopics: ["Health", "Family"] }),
    ];
    const ctx = buildMatchHypeContext({ match: makeMatch(), roster });
    expect(ctx.forbiddenTopics.sort()).toEqual(["Family", "Health"]);
    expect(ctx.user).toContain("- Family");
    expect(ctx.user).toContain("- Health");
  });

  it("handles an empty roster without crashing", () => {
    const ctx = buildMatchHypeContext({ match: makeMatch(), roster: [] });
    expect(ctx.user).toContain("(no active players on record)");
    expect(ctx.forbiddenTopics).toEqual([]);
  });

  it("never asserts a specific player has confirmed attendance (plan section 35)", () => {
    const ctx = buildMatchHypeContext({ match: makeMatch(), roster: [makePlayer()] });
    expect(ctx.user.toLowerCase()).toContain("never assert");
  });
});

describe("buildMatchRecapContext (plan section 39)", () => {
  const roster = [makePlayer({ id: 1, displayName: "Ahmed" }), makePlayer({ id: 2, displayName: "Omar" })];

  it("renders match events with the resolved player name and type", () => {
    const events = [makeMatchEvent({ playerId: 1, type: "CLUTCH", description: "Won a 1v3." })];
    const ctx = buildMatchRecapContext({ match: makeMatch(), result: "WIN", matchEvents: events, roster, notes: null });
    expect(ctx.user).toContain("Result: WIN");
    expect(ctx.user).toContain("[CLUTCH] Ahmed: Won a 1v3.");
  });

  it("labels a player-less event as 'Team' (TEAM_EVENT / unresolved name)", () => {
    const events = [makeMatchEvent({ playerId: null, type: "TEAM_EVENT", description: "Slow start, strong finish." })];
    const ctx = buildMatchRecapContext({ match: makeMatch(), result: "LOSS", matchEvents: events, roster, notes: null });
    expect(ctx.user).toContain("[TEAM_EVENT] Team: Slow start, strong finish.");
  });

  it("says '(none recorded)' with no events, and tells the model to keep it generic (plan section 47)", () => {
    const ctx = buildMatchRecapContext({ match: makeMatch(), result: "WIN", matchEvents: [], roster, notes: null });
    expect(ctx.user).toContain("(none recorded)");
    expect(ctx.user).toContain("never invent specific plays");
  });

  it("includes admin notes verbatim (cleaned) alongside the structured events", () => {
    const ctx = buildMatchRecapContext({
      match: makeMatch(),
      result: "WIN",
      matchEvents: [],
      roster,
      notes: "Marwan forgot to smoke Heaven.",
    });
    expect(ctx.user).toContain("ADMIN NOTES");
    expect(ctx.user).toContain("Marwan forgot to smoke Heaven.");
  });

  it("omits the ADMIN NOTES section header when there are no notes (the MODE line's passing mention of the concept doesn't count)", () => {
    const ctx = buildMatchRecapContext({ match: makeMatch(), result: "WIN", matchEvents: [], roster, notes: null });
    expect(ctx.user.split("\n")).not.toContain("ADMIN NOTES");
  });
});

describe("buildMatchEventExtractionContext (plan section 40)", () => {
  it("lists the roster by exact display name for the model to copy from", () => {
    const roster = [makePlayer({ displayName: "Ahmed" }), makePlayer({ displayName: "Omar" })];
    const ctx = buildMatchEventExtractionContext({ notes: "Ahmed clutched round 19.", roster });
    expect(ctx.user).toContain("- Ahmed");
    expect(ctx.user).toContain("- Omar");
    expect(ctx.user).toContain("ADMIN NOTES");
    expect(ctx.user).toContain("Ahmed clutched round 19.");
  });

  it("keeps the extraction rules (never invent) in the system prompt", () => {
    const ctx = buildMatchEventExtractionContext({ notes: "x", roster: [] });
    expect(ctx.system.toLowerCase()).toContain("never invent");
  });
});
