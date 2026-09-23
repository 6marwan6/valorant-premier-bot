import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../src/config/logger.js";
import { AI_FALLBACK_MESSAGE, AiService } from "../../src/modules/ai/aiService.js";
import { LlmError, type LlmClient } from "../../src/services/ai/llmClient.js";
import { makeMatch, makePlayer } from "./helpers/aiFixtures.js";

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function fakeLlm(impl: LlmClient["complete"]): LlmClient & { complete: ReturnType<typeof vi.fn> } {
  return { model: "test-model", complete: vi.fn(impl) };
}

const json = (response: string) => JSON.stringify({ response, should_follow_up: false, memory_candidate: null });
const params = { player: makePlayer(), match: makeMatch(), status: "PLAYING" as const };

describe("AiService", () => {
  it("is disabled without an LLM and returns the fallback without calling anything", async () => {
    const service = new AiService(null, fakeLogger() as unknown as Logger);
    expect(service.enabled).toBe(false);
    expect(await service.respondToAttendance(params)).toEqual({ text: AI_FALLBACK_MESSAGE, source: "fallback" });
  });

  it("returns the model's validated response and sends the built context", async () => {
    const llm = fakeLlm(async () => ({ text: json("Jett is reporting for duty"), model: "m", inputTokens: 10, outputTokens: 5 }));
    const logger = fakeLogger();
    const service = new AiService(llm, logger as unknown as Logger);

    const outcome = await service.respondToAttendance(params);

    expect(outcome).toEqual({ text: "Jett is reporting for duty", source: "ai" });
    const request = llm.complete.mock.calls[0]![0];
    expect(request.system).toContain("MODE: CELEBRATE.");
    expect(request.user).toContain("Player response: PLAYING");
  });

  it("logs metadata only — never prompt or response content (plan sections 51/58)", async () => {
    const llm = fakeLlm(async () => ({ text: json("secret-ish roast text"), model: "m", inputTokens: 10, outputTokens: 5 }));
    const logger = fakeLogger();
    await new AiService(llm, logger as unknown as Logger).respondToAttendance(params);

    const logged = JSON.stringify(logger.info.mock.calls);
    expect(logged).not.toContain("secret-ish roast text");
    expect(logged).not.toContain("Team XYZ");
    expect(logger.info.mock.calls[0]![0]).toMatchObject({
      event: "ai.response",
      mode: "CELEBRATE",
      playerId: 1,
      model: "test-model",
      memoryCount: 0,
      success: true,
      inputTokens: 10,
      outputTokens: 5,
    });
  });

  it.each([
    ["timeout", new LlmError("timed out", "timeout")],
    ["http error", new LlmError("HTTP 500", "http", 500)],
    ["unexpected error", new Error("boom")],
  ])("falls back safely on %s (plan section 48)", async (_name, error) => {
    const logger = fakeLogger();
    const service = new AiService(
      fakeLlm(async () => {
        throw error;
      }),
      logger as unknown as Logger,
    );
    expect(await service.respondToAttendance(params)).toEqual({ text: AI_FALLBACK_MESSAGE, source: "fallback" });
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("falls back on invalid JSON and on protected-topic violations", async () => {
    const invalid = new AiService(
      fakeLlm(async () => ({ text: "not json", model: "m", inputTokens: null, outputTokens: null })),
      fakeLogger() as unknown as Logger,
    );
    expect((await invalid.respondToAttendance(params)).source).toBe("fallback");

    const logger = fakeLogger();
    const violating = new AiService(
      fakeLlm(async () => ({ text: json("call your family"), model: "m", inputTokens: null, outputTokens: null })),
      logger as unknown as Logger,
    );
    expect((await violating.respondToAttendance(params)).source).toBe("fallback");
    expect(logger.warn.mock.calls[0]![0]).toMatchObject({ reason: "protected_topic", success: false });
  });

  it("uses the mode matching the attendance status", async () => {
    const llm = fakeLlm(async () => ({ text: json("ok"), model: "m", inputTokens: null, outputTokens: null }));
    const service = new AiService(llm, fakeLogger() as unknown as Logger);
    await service.respondToAttendance({ ...params, status: "CANNOT_PLAY" });
    await service.respondToAttendance({ ...params, status: "WANTS_TO_BUT_CANNOT" });
    expect(llm.complete.mock.calls[0]![0].system).toContain("MODE: ROAST.");
    expect(llm.complete.mock.calls[1]![0].system).toContain("MODE: CONSOLE.");
  });
});
