import { describe, expect, it } from "vitest";
import { matchPlayerByName } from "../../src/modules/matches/matchEvents.js";
import { matchEventTypeEnum } from "../../src/database/schema/matchEvents.js";
import { MATCH_EVENT_TYPES } from "../../src/modules/ai/aiOutput.js";
import { makePlayer } from "./helpers/aiFixtures.js";

describe("matchPlayerByName (plan section 40 / section 47 conservatism)", () => {
  const roster = [
    makePlayer({ id: 1, displayName: "Ahmed" }),
    makePlayer({ id: 2, displayName: "Omar" }),
    makePlayer({ id: 3, displayName: "Marwan" }),
  ];

  it("matches a roster player by exact, case-insensitive display name", () => {
    expect(matchPlayerByName("Ahmed", roster)?.id).toBe(1);
    expect(matchPlayerByName("ahmed", roster)?.id).toBe(1);
    expect(matchPlayerByName("AHMED", roster)?.id).toBe(1);
  });

  it("tolerates surrounding whitespace", () => {
    expect(matchPlayerByName("  Omar  ", roster)?.id).toBe(2);
  });

  it("returns null for a name not on the roster (never invents a player)", () => {
    expect(matchPlayerByName("Youssef", roster)).toBeNull();
  });

  it("returns null for a partial/fuzzy match — no fuzzy matching by design", () => {
    expect(matchPlayerByName("Ahm", roster)).toBeNull();
    expect(matchPlayerByName("Ahmed Hassan", roster)).toBeNull();
  });

  it("returns null for null/empty input", () => {
    expect(matchPlayerByName(null, roster)).toBeNull();
    expect(matchPlayerByName("", roster)).toBeNull();
    expect(matchPlayerByName("   ", roster)).toBeNull();
  });

  it("returns null against an empty roster", () => {
    expect(matchPlayerByName("Ahmed", [])).toBeNull();
  });
});

describe("MATCH_EVENT_TYPES stays pinned to the match_event_type DB enum", () => {
  it("has the same values, in the same order, as matchEventTypeEnum (plan section 40's exact list)", () => {
    expect(MATCH_EVENT_TYPES).toEqual(matchEventTypeEnum.enumValues);
  });
});
