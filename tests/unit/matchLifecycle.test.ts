import { describe, expect, it } from "vitest";
import { canCancelMatch, canEditMatch, describeWhyLocked } from "../../src/modules/matches/matchLifecycle.js";
import type { MatchStatus } from "../../src/modules/matches/matchLifecycle.js";

const ALL_STATUSES: MatchStatus[] = [
  "SCHEDULED",
  "CONFIRMATION_OPEN",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
];

describe("canEditMatch", () => {
  it("allows editing from every non-terminal state", () => {
    expect(canEditMatch("SCHEDULED")).toBe(true);
    expect(canEditMatch("CONFIRMATION_OPEN")).toBe(true);
    expect(canEditMatch("IN_PROGRESS")).toBe(true);
  });

  it("blocks editing once completed or cancelled (plan section 11)", () => {
    expect(canEditMatch("COMPLETED")).toBe(false);
    expect(canEditMatch("CANCELLED")).toBe(false);
  });
});

describe("canCancelMatch", () => {
  it('allows cancellation "from any state before completion" (plan section 12)', () => {
    expect(canCancelMatch("SCHEDULED")).toBe(true);
    expect(canCancelMatch("CONFIRMATION_OPEN")).toBe(true);
    expect(canCancelMatch("IN_PROGRESS")).toBe(true);
  });

  it("blocks cancelling an already-completed or already-cancelled match", () => {
    expect(canCancelMatch("COMPLETED")).toBe(false);
    expect(canCancelMatch("CANCELLED")).toBe(false);
  });
});

describe("describeWhyLocked", () => {
  it("gives a distinct, accurate reason for each terminal state", () => {
    expect(describeWhyLocked("COMPLETED")).toMatch(/completed/i);
    expect(describeWhyLocked("CANCELLED")).toMatch(/cancelled/i);
  });
});

describe("every status is covered by both guards (no silent fallthrough)", () => {
  it.each(ALL_STATUSES)("%s has a defined edit and cancel answer", (status) => {
    expect(typeof canEditMatch(status)).toBe("boolean");
    expect(typeof canCancelMatch(status)).toBe("boolean");
  });
});
