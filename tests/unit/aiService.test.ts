import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../src/config/logger.js";
import { AI_FALLBACK_MESSAGE, AiService } from "../../src/modules/ai/aiService.js";
import { LlmError, type LlmClient } from "../../src/services/ai/llmClient.js";
import { makeMatch, makeMemory, makePlayer } from "./helpers/aiFixtures.js";
import type { MemoryRepository } from "../../src/database/repositories/memoryRepository.js";
import type { MemoryRow } from "../../src/database/schema/memories.js";

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function fakeLlm(impl: LlmClient["complete"]): LlmClient & { complete: ReturnType<typeof vi.fn> } {
  return { model: "test-model", complete: vi.fn(impl) };
}

function fakeMemoryRepo(memories: MemoryRow[]) {
  const listByPlayer = vi.fn(async () => memories);
  const touchLastUsed = vi.fn(async () => undefined);
  return { repo: { listByPlayer, touchLastUsed } as unknown as MemoryRepository, listByPlayer, touchLastUsed };
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

describe("AiService — Phase 9 retrieval wiring", () => {
  it("with no memory repository configured, behaves exactly as before Phase 9: memoryCount 0, no RELEVANT MEMORIES block", async () => {
    const llm = fakeLlm(async () => ({ text: json("ok"), model: "m", inputTokens: 1, outputTokens: 1 }));
    const logger = fakeLogger();
    await new AiService(llm, logger as unknown as Logger).respondToAttendance(params);
    expect(llm.complete.mock.calls[0]![0].user).not.toContain("RELEVANT MEMORIES");
    expect(logger.info.mock.calls[0]![0]).toMatchObject({ memoryCount: 0 });
  });

  it("fetches the player's memories, retrieves the eligible/ranked subset into the prompt, and logs the real count", async () => {
    const memories = [
      makeMemory({ type: "RUNNING_JOKE", visibility: "PUBLIC", content: "Ahmed jokes that he is \"him\"." }),
      makeMemory({ visibility: "PRIVATE", content: "Should never reach a public CELEBRATE message." }),
    ];
    const { repo, listByPlayer } = fakeMemoryRepo(memories);
    const llm = fakeLlm(async () => ({ text: json("ok"), model: "m", inputTokens: 1, outputTokens: 1 }));
    const logger = fakeLogger();
    await new AiService(llm, logger as unknown as Logger, repo).respondToAttendance(params);

    expect(listByPlayer).toHaveBeenCalledWith(params.player.id);
    const sentUser = llm.complete.mock.calls[0]![0].user;
    expect(sentUser).toContain("RELEVANT MEMORIES");
    expect(sentUser).toContain('- Ahmed jokes that he is "him".');
    // Section 44 rule 1: a PRIVATE memory never reaches the public CELEBRATE/ROAST channel post.
    expect(sentUser).not.toContain("Should never reach a public CELEBRATE message.");
    expect(logger.info.mock.calls[0]![0]).toMatchObject({ memoryCount: 1 });
  });

  it("bumps last_used_at for exactly the memories that were actually selected, not every memory the player has", async () => {
    const kept = makeMemory({ type: "RUNNING_JOKE", visibility: "PUBLIC", content: "Kept." });
    const excluded = makeMemory({ visibility: "PRIVATE", content: "Excluded — PRIVATE, public audience." });
    const { repo, touchLastUsed } = fakeMemoryRepo([kept, excluded]);
    const llm = fakeLlm(async () => ({ text: json("ok"), model: "m", inputTokens: 1, outputTokens: 1 }));
    await new AiService(llm, fakeLogger() as unknown as Logger, repo).respondToAttendance(params);

    expect(touchLastUsed).toHaveBeenCalledWith([kept.id]);
  });

  it("never bumps last_used_at when nothing was eligible", async () => {
    const { repo, touchLastUsed } = fakeMemoryRepo([makeMemory({ visibility: "PRIVATE" })]); // PRIVATE, but this is a public CELEBRATE
    const llm = fakeLlm(async () => ({ text: json("ok"), model: "m", inputTokens: 1, outputTokens: 1 }));
    await new AiService(llm, fakeLogger() as unknown as Logger, repo).respondToAttendance(params);
    expect(touchLastUsed).not.toHaveBeenCalled();
  });

  it("a failed last_used_at write is logged, never surfaced as an AI failure (plan section 48's spirit)", async () => {
    const memories = [makeMemory({ type: "RUNNING_JOKE", visibility: "PUBLIC", content: "Kept." })];
    const { repo } = fakeMemoryRepo(memories);
    (repo.touchLastUsed as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db down"));
    const llm = fakeLlm(async () => ({ text: json("ok"), model: "m", inputTokens: 1, outputTokens: 1 }));
    const logger = fakeLogger();
    const outcome = await new AiService(llm, logger as unknown as Logger, repo).respondToAttendance(params);
    expect(outcome.source).toBe("ai"); // the reply itself still succeeded
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalled());
  });

  it("CONSOLE conversation turns retrieve memories too, respecting the private-DM audience (PRIVATE is fine here)", async () => {
    const memories = [makeMemory({ type: "PLAYER_PREFERENCE", visibility: "PRIVATE", content: "A private fact, fine in a DM." })];
    const { repo } = fakeMemoryRepo(memories);
    const llm = fakeLlm(async () => ({
      text: JSON.stringify({ response: "ok", should_follow_up: false, memory_candidate: null }),
      model: "m",
      inputTokens: 1,
      outputTokens: 1,
    }));
    const service = new AiService(llm, fakeLogger() as unknown as Logger, repo);
    await service.respondInConversation({
      player: params.player,
      match: params.match,
      conversationId: 1,
      transcript: [],
    });
    expect(llm.complete.mock.calls[0]![0].user).toContain("A private fact, fine in a DM.");
  });
});
