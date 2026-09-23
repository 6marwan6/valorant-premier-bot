import { describe, expect, it } from "vitest";
import { mentionsForbiddenTopic, neutralizeMentions, parseAiOutput } from "../../src/modules/ai/aiOutput.js";

const ok = (response: string, extra = "") => JSON.stringify({ response, should_follow_up: false, memory_candidate: null }) + extra;

describe("parseAiOutput", () => {
  it("parses the plan section 36 shape", () => {
    const result = parseAiOutput(ok("LET'S GOOO"), []);
    expect(result).toEqual({ ok: true, value: { response: "LET'S GOOO", shouldFollowUp: false } });
  });

  it("tolerates markdown fences and <think> blocks", () => {
    const raw = "<think>hmm {not json}</think>\n```json\n" + ok("hi") + "\n```";
    const result = parseAiOutput(raw, []);
    expect(result.ok && result.value.response).toBe("hi");
  });

  it("defaults should_follow_up to false and ignores memory_candidate (plan section 37)", () => {
    const raw = JSON.stringify({ response: "hi", memory_candidate: { type: "MATCH_EVENT", content: "x" } });
    expect(parseAiOutput(raw, [])).toEqual({ ok: true, value: { response: "hi", shouldFollowUp: false } });
  });

  it("rejects non-JSON output", () => {
    expect(parseAiOutput("sure! here you go", [])).toEqual({ ok: false, reason: "invalid_json" });
    expect(parseAiOutput("{oops", [])).toEqual({ ok: false, reason: "invalid_json" });
  });

  it("rejects wrong shapes (missing/empty/over-long response)", () => {
    expect(parseAiOutput(JSON.stringify({ text: "x" }), [])).toEqual({ ok: false, reason: "invalid_shape" });
    expect(parseAiOutput(JSON.stringify({ response: "   " }), [])).toEqual({ ok: false, reason: "invalid_shape" });
    expect(parseAiOutput(JSON.stringify({ response: "a".repeat(1001) }), [])).toEqual({
      ok: false,
      reason: "invalid_shape",
    });
  });

  it("rejects responses that mention a protected topic, case-insensitively (plan sections 10/55)", () => {
    expect(parseAiOutput(ok("how is your FAMILY doing"), ["Family"])).toEqual({
      ok: false,
      reason: "protected_topic",
    });
    expect(parseAiOutput(ok("nice clutch"), ["Family"]).ok).toBe(true);
  });

  it("defuses mass mentions and user/role mentions in the output", () => {
    const result = parseAiOutput(ok("@everyone look <@123> <@&456>"), []);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.response).not.toMatch(/@everyone/);
      expect(result.value.response).not.toMatch(/<@/);
    }
  });
});

describe("helpers", () => {
  it("neutralizeMentions leaves normal text alone", () => {
    expect(neutralizeMentions("gg wp")).toBe("gg wp");
  });
  it("mentionsForbiddenTopic ignores empty topics", () => {
    expect(mentionsForbiddenTopic("anything", [""])).toBe(false);
  });
});
