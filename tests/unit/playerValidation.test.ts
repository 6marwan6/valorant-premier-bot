import { describe, expect, it } from "vitest";
import {
  parseCommaSeparatedList,
  validatePreferredAgent,
  PLAYER_ROLE_CHOICES,
} from "../../src/modules/players/playerValidation.js";

describe("parseCommaSeparatedList", () => {
  it("trims whitespace and splits on commas", () => {
    const result = parseCommaSeparatedList(" Jett ,  Raze,Neon ", "agent");
    expect(result).toEqual({ ok: true, values: ["Jett", "Raze", "Neon"] });
  });

  it("de-duplicates case-insensitively, keeping the first casing seen", () => {
    const result = parseCommaSeparatedList("Jett, jett, JETT, Raze", "agent");
    expect(result).toEqual({ ok: true, values: ["Jett", "Raze"] });
  });

  it("ignores empty entries from stray commas", () => {
    const result = parseCommaSeparatedList("Jett,,  ,Raze", "agent");
    expect(result).toEqual({ ok: true, values: ["Jett", "Raze"] });
  });

  it("rejects an entirely empty or whitespace-only input", () => {
    const result = parseCommaSeparatedList("   ,, ", "agent");
    expect(result.ok).toBe(false);
  });

  it("rejects more than 12 entries", () => {
    const raw = Array.from({ length: 13 }, (_, i) => `Item${i}`).join(",");
    const result = parseCommaSeparatedList(raw, "protected topic");
    expect(result.ok).toBe(false);
  });

  it("rejects a single entry longer than 40 characters", () => {
    const result = parseCommaSeparatedList("a".repeat(41), "agent");
    expect(result.ok).toBe(false);
  });
});

describe("validatePreferredAgent", () => {
  it("accepts a preferred agent present in the agents list", () => {
    expect(validatePreferredAgent("Jett", ["Jett", "Raze"])).toBeNull();
  });

  it("matches case-insensitively", () => {
    expect(validatePreferredAgent("jett", ["Jett", "Raze"])).toBeNull();
  });

  it("rejects a preferred agent not present in the agents list", () => {
    const error = validatePreferredAgent("Omen", ["Jett", "Raze"]);
    expect(error).toContain("Omen");
    expect(error).toContain("Jett, Raze");
  });
});

describe("PLAYER_ROLE_CHOICES", () => {
  it("covers exactly Valorant's four standard role classes (plan sections 8/62)", () => {
    expect(PLAYER_ROLE_CHOICES.map((c) => c.value).sort()).toEqual([
      "CONTROLLER",
      "DUELIST",
      "INITIATOR",
      "SENTINEL",
    ]);
  });
});
