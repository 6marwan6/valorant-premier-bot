import { describe, expect, it } from "vitest";
import { modeForStatus } from "../../src/modules/ai/aiMode.js";

describe("modeForStatus (plan sections 18-20)", () => {
  it("maps each stored attendance status to its AI mode", () => {
    expect(modeForStatus("PLAYING")).toBe("CELEBRATE");
    expect(modeForStatus("CANNOT_PLAY")).toBe("ROAST");
    expect(modeForStatus("WANTS_TO_BUT_CANNOT")).toBe("CONSOLE");
  });
});
