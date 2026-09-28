import { describe, expect, it } from "vitest";
import {
  audienceForMode,
  isEligible,
  retrieveMemories,
  scoreMemory,
  MAX_RETRIEVED_MEMORIES,
} from "../../src/modules/memories/memoryRetrieval.js";
import type { MemoryType, MemoryVisibility } from "../../src/database/schema/memories.js";
import { makeMemory } from "./helpers/aiFixtures.js";

describe("audienceForMode (plan section 44 rule 1)", () => {
  it("CONSOLE is a private DM; CELEBRATE/ROAST are the public channel post", () => {
    expect(audienceForMode("CONSOLE")).toBe("PRIVATE_DM");
    expect(audienceForMode("CELEBRATE")).toBe("PUBLIC_CHANNEL");
    expect(audienceForMode("ROAST")).toBe("PUBLIC_CHANNEL");
  });
});

describe("isEligible (plan sections 10/24/44 rule 1)", () => {
  it("PROTECTED is never eligible, for either audience", () => {
    const m = makeMemory({ visibility: "PROTECTED" });
    expect(isEligible(m, "PRIVATE_DM", [])).toBe(false);
    expect(isEligible(m, "PUBLIC_CHANNEL", [])).toBe(false);
  });

  it("a PRIVATE memory is eligible for the player's own private DM but never the public channel", () => {
    const m = makeMemory({ visibility: "PRIVATE" });
    expect(isEligible(m, "PRIVATE_DM", [])).toBe(true);
    expect(isEligible(m, "PUBLIC_CHANNEL", [])).toBe(false);
  });

  it.each(["TEAM", "PUBLIC"] as MemoryVisibility[])("a %s memory is eligible for both audiences", (visibility) => {
    const m = makeMemory({ visibility });
    expect(isEligible(m, "PRIVATE_DM", [])).toBe(true);
    expect(isEligible(m, "PUBLIC_CHANNEL", [])).toBe(true);
  });

  it("aiUsable=false is never eligible, regardless of visibility", () => {
    const m = makeMemory({ visibility: "PUBLIC", aiUsable: false });
    expect(isEligible(m, "PUBLIC_CHANNEL", [])).toBe(false);
  });

  it("a memory whose content now mentions a (currently) protected topic is excluded, even though it was fine when saved", () => {
    const m = makeMemory({ visibility: "PRIVATE", content: "Struggles to play right after a university exam." });
    expect(isEligible(m, "PRIVATE_DM", [])).toBe(true);
    expect(isEligible(m, "PRIVATE_DM", ["University"])).toBe(false); // case-insensitive, same matcher aiOutput.ts uses
  });
});

describe("scoreMemory (plan section 33)", () => {
  const now = new Date("2026-09-26T00:00:00Z");

  it("a memory of a mode-preferred type scores higher than an otherwise-identical non-preferred one", () => {
    const preferred = makeMemory({ type: "RUNNING_JOKE", createdAt: now });
    const other = makeMemory({ type: "HABIT", createdAt: now });
    expect(scoreMemory(preferred, "ROAST", now)).toBeGreaterThan(scoreMemory(other, "ROAST", now));
  });

  it("CONSOLE actively discourages roast-flavored types, not just deprioritizes them (plan section 31)", () => {
    const joke = makeMemory({ type: "RUNNING_JOKE", createdAt: now, importance: 90, confidence: 1 });
    const preference = makeMemory({ type: "PLAYER_PREFERENCE", createdAt: now, importance: 10, confidence: 0.5 });
    // Even a low-importance, lower-confidence PLAYER_PREFERENCE outranks a
    // high-importance RUNNING_JOKE for CONSOLE, because the joke's mode
    // relevance term is forced to exactly 0 there.
    expect(scoreMemory(preference, "CONSOLE", now)).toBeGreaterThan(scoreMemory(joke, "CONSOLE", now));
  });

  it("more recent beats older, all else equal", () => {
    const recent = makeMemory({ type: "HABIT", createdAt: now });
    const old = makeMemory({ type: "HABIT", createdAt: new Date("2026-01-01T00:00:00Z") });
    expect(scoreMemory(recent, "CELEBRATE", now)).toBeGreaterThan(scoreMemory(old, "CELEBRATE", now));
  });

  it("higher importance and confidence both push the score up", () => {
    const strong = makeMemory({ type: "HABIT", createdAt: now, importance: 90, confidence: 1 });
    const weak = makeMemory({ type: "HABIT", createdAt: now, importance: 10, confidence: 0.3 });
    expect(scoreMemory(strong, "CELEBRATE", now)).toBeGreaterThan(scoreMemory(weak, "CELEBRATE", now));
  });

  it("a highly important, highly confident, very recent non-preferred memory can still outrank a stale, low-importance preferred one (hybrid, not a hard type filter)", () => {
    const strongNonPreferred = makeMemory({ type: "HABIT", createdAt: now, importance: 100, confidence: 1 });
    const weakPreferred = makeMemory({
      type: "RUNNING_JOKE",
      createdAt: new Date("2025-01-01T00:00:00Z"),
      importance: 5,
      confidence: 0.2,
    });
    expect(scoreMemory(strongNonPreferred, "ROAST", now)).toBeGreaterThan(scoreMemory(weakPreferred, "ROAST", now));
  });
});

describe("retrieveMemories (end to end)", () => {
  const now = new Date("2026-09-26T00:00:00Z");

  it("filters out ineligible memories before ranking, and returns highest-scoring first", () => {
    const keep1 = makeMemory({ type: "RUNNING_JOKE", visibility: "PUBLIC", createdAt: now, importance: 80 });
    const keep2 = makeMemory({ type: "VALORANT_PREFERENCE", visibility: "TEAM", createdAt: now, importance: 40 });
    const droppedPrivate = makeMemory({ type: "RUNNING_JOKE", visibility: "PRIVATE", createdAt: now, importance: 100 });
    const droppedProtectedVisibility = makeMemory({ type: "RUNNING_JOKE", visibility: "PROTECTED", createdAt: now });
    const droppedTopic = makeMemory({ visibility: "PUBLIC", content: "mentions health issues", createdAt: now });

    const result = retrieveMemories({
      memories: [droppedPrivate, keep2, droppedProtectedVisibility, keep1, droppedTopic],
      mode: "ROAST", // PUBLIC_CHANNEL audience — PRIVATE is excluded
      forbiddenTopics: ["health"],
    });

    expect(result.map((m) => m.id)).toEqual([keep1.id, keep2.id]);
  });

  it("CONSOLE (private DM) can use the player's own PRIVATE memories", () => {
    const priv = makeMemory({ visibility: "PRIVATE", type: "PLAYER_PREFERENCE", createdAt: now });
    const result = retrieveMemories({ memories: [priv], mode: "CONSOLE", forbiddenTopics: [] });
    expect(result.map((m) => m.id)).toEqual([priv.id]);
  });

  it("caps at the configured limit even when more memories are eligible", () => {
    const many = Array.from({ length: MAX_RETRIEVED_MEMORIES + 3 }, () =>
      makeMemory({ visibility: "PUBLIC", type: "RUNNING_JOKE", createdAt: now }),
    );
    const result = retrieveMemories({ memories: many, mode: "ROAST", forbiddenTopics: [] });
    expect(result).toHaveLength(MAX_RETRIEVED_MEMORIES);
  });

  it("a custom limit is respected", () => {
    const many = Array.from({ length: 5 }, () => makeMemory({ visibility: "PUBLIC", createdAt: now }));
    expect(retrieveMemories({ memories: many, mode: "ROAST", forbiddenTopics: [], limit: 2 })).toHaveLength(2);
  });

  it("no eligible memories at all returns an empty array, not an error", () => {
    const onlyPrivate = [makeMemory({ visibility: "PRIVATE" })];
    expect(retrieveMemories({ memories: onlyPrivate, mode: "CELEBRATE", forbiddenTopics: [] })).toEqual([]);
    expect(retrieveMemories({ memories: [], mode: "CONSOLE", forbiddenTopics: [] })).toEqual([]);
  });

  it("never mixes in a memory type outside the nine plan section 22 categories (type system already prevents this at compile time; sanity check the scorer doesn't throw on every real type)", () => {
    const types: MemoryType[] = [
      "PLAYER_PREFERENCE",
      "PERSONALITY_TRAIT",
      "RUNNING_JOKE",
      "VALORANT_PREFERENCE",
      "TEAM_JOKE",
      "MATCH_EVENT",
      "ACHIEVEMENT",
      "HABIT",
      "TEAM_HISTORY",
    ];
    for (const type of types) {
      for (const mode of ["CELEBRATE", "ROAST", "CONSOLE"] as const) {
        expect(() => scoreMemory(makeMemory({ type, createdAt: now }), mode, now)).not.toThrow();
      }
    }
  });
});
