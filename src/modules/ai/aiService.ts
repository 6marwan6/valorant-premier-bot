import type { Logger } from "../../config/logger.js";
import type { AttendanceRow } from "../../database/schema/attendance.js";
import type { MatchRow } from "../../database/schema/matches.js";
import type { PlayerRow } from "../../database/schema/players.js";
import { LlmError, type LlmClient } from "../../services/ai/llmClient.js";
import { buildAIContext } from "./aiContextBuilder.js";
import { modeForStatus } from "./aiMode.js";
import { parseAiOutput } from "./aiOutput.js";
import { buildConversationContext, type ConversationTranscriptEntry } from "./conversationContextBuilder.js";

/** Plan section 48's own example fallback wording. */
export const AI_FALLBACK_MESSAGE = "Your response has been recorded 👍";

export interface AiOutcome {
  text: string;
  source: "ai" | "fallback";
}

/**
 * One generated turn of a private conversation (Phase 7). `text` is only
 * meaningful when `source === "ai"`: on any failure the caller substitutes
 * its own fallback wording (the right words for "opening a conversation"
 * and "answering someone mid-conversation" differ), so this deliberately
 * doesn't invent one.
 */
export type ConversationAiOutcome =
  | { source: "ai"; text: string; shouldFollowUp: boolean }
  | { source: "fallback" };

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

  /**
   * Phase 7 (plan section 59): one turn of a private CONSOLE conversation.
   * Same contract as respondToAttendance — never throws, never touches
   * application state (sections 37/48), logs metadata only (sections
   * 51/58) — but the prompt carries the conversation transcript and the
   * result also says whether the model thinks the conversation should
   * continue (`should_follow_up`, section 36). The *backend* still makes
   * the final call on continuing; see ConversationService.
   */
  async respondInConversation(params: {
    player: PlayerRow;
    match: MatchRow;
    conversationId: number;
    transcript: ConversationTranscriptEntry[];
    maxPlayerTurns?: number;
  }): Promise<ConversationAiOutcome> {
    if (!this.llm) return { source: "fallback" };

    const context = buildConversationContext({
      player: params.player,
      match: params.match,
      transcript: params.transcript,
      maxPlayerTurns: params.maxPlayerTurns,
    });
    const startedAt = Date.now();
    const base = {
      event: "ai.conversation.turn",
      mode: context.mode,
      turn: context.turn,
      playerId: params.player.id,
      matchId: params.match.id,
      conversationId: params.conversationId,
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
        this.logger.warn({ ...base, ...metrics, success: false, reason: parsed.reason }, "AI conversation output rejected");
        return { source: "fallback" };
      }

      this.logger.info({ ...base, ...metrics, success: true }, "AI conversation turn generated");
      return { source: "ai", text: parsed.value.response, shouldFollowUp: parsed.value.shouldFollowUp };
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
        "AI conversation request failed",
      );
      return { source: "fallback" };
    }
  }
}
