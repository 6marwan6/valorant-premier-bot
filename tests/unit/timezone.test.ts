import { describe, expect, it } from "vitest";
import { isValidTimeZone } from "../../src/discord/timezone.js";

describe("isValidTimeZone", () => {
  it("accepts Europe/Berlin (Germany's real IANA zone)", () => {
    expect(isValidTimeZone("Europe/Berlin")).toBe(true);
  });

  it("rejects Europe/Frankfurt — not a real IANA zone, despite plan section 3", () => {
    expect(isValidTimeZone("Europe/Frankfurt")).toBe(false);
  });

  it("accepts the section 11 example timezone, Africa/Cairo", () => {
    expect(isValidTimeZone("Africa/Cairo")).toBe(true);
  });

  it("rejects garbage input", () => {
    expect(isValidTimeZone("not a timezone")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});
