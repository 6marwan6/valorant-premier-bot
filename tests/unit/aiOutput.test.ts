import { describe, expect, it } from "vitest";
import { MEMORY_TYPES, mentionsForbiddenTopic, neutralizeMentions, parseAiOutput } from "../../src/modules/ai/aiOutput.js";

const ok = (response: string, extra = "") => JSON.stringify({ response, should_follow_up: false, memory_candidate: null }) + extra;

describe("parseAiOutput", () => {
  it("parses the plan section 36 shape", () => {
    const result = parseAiOutput(ok("LET'S GOOO"), []);
    expect(result).toEqual({ ok: true, value: { response: "LET'S GOOO", shouldFollowUp: false, memoryCandidate: null } });
  });

  it("tolerates markdown fences and <think> blocks", () => {
    const raw = "<think>hmm {not json}</think>\n```json\n" + ok("hi") + "\n```";
    const result = parseAiOutput(raw, []);
    expect(result.ok && result.value.response).toBe("hi");
  });

  it("defaults should_follow_up to false when omitted", () => {
    const raw = JSON.stringify({ response: "hi" });
    expect(parseAiOutput(raw, [])).toEqual({ ok: true, value: { response: "hi", shouldFollowUp: false, memoryCandidate: null } });
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

  describe("memory_candidate (Phase 8, plan sections 21/36/37)", () => {
    const withCandidate = (candidate: unknown, extra: Record<string, unknown> = {}) =>
      JSON.stringify({ response: "wrapping up", should_follow_up: false, memory_candidate: candidate, ...extra });

    it("surfaces a well-formed, confirmed candidate", () => {
      const raw = withCandidate({ type: "MATCH_EVENT", content: "Ahmed had an exam.", requires_confirmation: true });
      const result = parseAiOutput(raw, []);
      expect(result).toEqual({
        ok: true,
        value: {
          response: "wrapping up",
          shouldFollowUp: false,
          memoryCandidate: { type: "MATCH_EVENT", content: "Ahmed had an exam." },
        },
      });
    });

    it("accepts every plan section 22 category", () => {
      for (const type of MEMORY_TYPES) {
        const raw = withCandidate({ type, content: "some fact", requires_confirmation: true });
        const result = parseAiOutput(raw, []);
        expect(result.ok && result.value.memoryCandidate?.type).toBe(type);
      }
    });

    it("drops a candidate that doesn't set requires_confirmation to literally true (plan section 21 stays consent-first no matter what the model claims)", () => {
      const missing = withCandidate({ type: "HABIT", content: "x" });
      const falseValue = withCandidate({ type: "HABIT", content: "x", requires_confirmation: false });
      for (const raw of [missing, falseValue]) {
        const result = parseAiOutput(raw, []);
        expect(result.ok && result.value.memoryCandidate).toBeNull();
        // the response itself is untouched — a bad candidate never sinks a good reply
        expect(result.ok && result.value.response).toBe("wrapping up");
      }
    });

    it("drops (not rejects) a candidate whose content touches a forbidden topic — the response still goes through", () => {
      const raw = withCandidate({ type: "HABIT", content: "always talks about his FAMILY", requires_confirmation: true });
      const result = parseAiOutput(raw, ["Family"]);
      expect(result).toEqual({
        ok: true,
        value: { response: "wrapping up", shouldFollowUp: false, memoryCandidate: null },
      });
    });

    it("rejects a candidate whose category is outside the plan section 22 list (shape validation)", () => {
      const raw = withCandidate({ type: "FAVORITE_COLOR", content: "x", requires_confirmation: true });
      expect(parseAiOutput(raw, [])).toEqual({ ok: false, reason: "invalid_shape" });
    });

    it("rejects an over-long candidate content (shape validation, not a silent drop)", () => {
      const raw = withCandidate({ type: "HABIT", content: "x".repeat(301), requires_confirmation: true });
      expect(parseAiOutput(raw, [])).toEqual({ ok: false, reason: "invalid_shape" });
    });

    it("neutralizes mentions inside candidate content the same way it does the response", () => {
      const raw = withCandidate({ type: "HABIT", content: "pings @everyone when he clutches", requires_confirmation: true });
      const result = parseAiOutput(raw, []);
      expect(result.ok && result.value.memoryCandidate?.content).not.toMatch(/@everyone/);
    });
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
