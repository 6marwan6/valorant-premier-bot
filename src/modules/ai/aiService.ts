import type { Logger } from "../../config/logger.js";
import type { AttendanceRow } from "../../database/schema/attendance.js";
import type { MatchRow } from "../../database/schema/matches.js";
import type { PlayerRow } from "../../database/schema/players.js";
import { LlmError, type LlmClient } from "../../services/ai/llmClient.js";
import { buildAIContext } from "./aiContextBuilder.js";
import { modeForStatus } from "./aiMode.js";
import { parseAiOutput } from "./aiOutput.js";

/** Plan section 48's own example fallback wording. */
export const AI_FALLBACK_MESSAGE = "Your response has been recorded 👍";

export interface AiOutcome {
  text: string;
  source: "ai" | "fallback";
}

/**
 * Phase 6 orchestration: attendance response -> mode -> context -> LLM ->
 * validation -> text. Never throws and never touches application state
 * (plan sections 37 and 48): every failure path resolves to the safe
 * fallback so the caller can always send *something* truthful.
 */
export class AiService {
  constructor(
    private readonly llm: LlmClient | null,
    private readonly logger: Logger,
  ) {}

  /** False when no provider is configured — callers then behave exactly as they did before Phase 6. */
  get enabled(): boolean {
    return this.llm !== null;
  }

  async respondToAttendance(params: {
    player: PlayerRow;
    match: MatchRow;
    status: AttendanceRow["status"];
  }): Promise<AiOutcome> {
    const fallback: AiOutcome = { text: AI_FALLBACK_MESSAGE, source: "fallback" };
    if (!this.llm) return fallback;

    const mode = modeForStatus(params.status);
    const context = buildAIContext({ player: params.player, mode, match: params.match });
    const startedAt = Date.now();
    // Plan sections 51/58: metadata only — never prompt or response content.
    const base = {
      event: "ai.response",
      mode,
      playerId: params.player.id,
      matchId: params.match.id,
      model: this.llm.model,
      memoryCount: 0,
    };

    try {
      const result = await this.llm.complete({ system: context.system, user: context.user });
      const metrics = {
        latencyMs: Date.now() - startedAt,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      };

      const parsed = parseAiOutput(result.text, context.forbiddenTopics);
      if (!parsed.ok) {
        this.logger.warn({ ...base, ...metrics, success: false, reason: parsed.reason }, "AI output rejected");
        return fallback;
      }

      this.logger.info({ ...base, ...metrics, success: true }, "AI response generated");
      return { text: parsed.value.response, source: "ai" };
    } catch (err) {
      this.logger.error(
        {
          ...base,
          latencyMs: Date.now() - startedAt,
          success: false,
          reason: err instanceof LlmError ? err.kind : "unknown",
          status: err instanceof LlmError ? err.status : undefined,
          err: err instanceof Error ? err.message : String(err),
        },
        "AI request failed",
      );
      return fallback;
    }
  }
}
