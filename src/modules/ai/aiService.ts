import type { Logger } from "../../config/logger.js";
import type { AttendanceRow } from "../../database/schema/attendance.js";
import type { MatchRow } from "../../database/schema/matches.js";
import type { PlayerRow } from "../../database/schema/players.js";
import type { MemoryRepository } from "../../database/repositories/memoryRepository.js";
import { LlmError, type LlmClient } from "../../services/ai/llmClient.js";
import { buildAIContext, forbiddenTopicsFor } from "./aiContextBuilder.js";
import { modeForStatus, type AiMode } from "./aiMode.js";
import { parseAiOutput, type MemoryCandidate } from "./aiOutput.js";
import { buildConversationContext, type ConversationTranscriptEntry } from "./conversationContextBuilder.js";
import { retrieveMemories } from "../memories/memoryRetrieval.js";

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
 *
 * `memoryCandidate` (Phase 8) is always `null` when `player.memoryUsageEnabled`
 * is false — enforced right here, not just by omitting the instruction from
 * the prompt (plan section 37: the model only ever suggests; the backend
 * decides, and here that means it doesn't even get the chance to suggest).
 */
export type ConversationAiOutcome =
  | { source: "ai"; text: string; shouldFollowUp: boolean; memoryCandidate: MemoryCandidate | null }
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
    /** Optional (defaults to none) so every existing 2-arg call site — including every test that predates Phase 9 — keeps working exactly as before: no repository means retrieval always returns zero memories, the same as if Phase 9 didn't exist yet. */
    private readonly memories: MemoryRepository | null = null,
  ) {}

  /** False when no provider is configured — callers then behave exactly as they did before Phase 6. */
  get enabled(): boolean {
    return this.llm !== null;
  }

  /**
   * Phase 9 (plan sections 30/33): fetches a player's memories, runs them
   * through retrieveMemories, and best-effort bumps `last_used_at` on
   * whatever was actually selected. Returns `[]` with no repository
   * configured (see the constructor's doc comment) — the same shape a
   * player with zero memories produces, so callers never need to branch
   * on whether Phase 9 is "on".
   *
   * The `touchLastUsed` write is fire-and-forget on purpose: it's
   * bookkeeping about a context that's already been built by the time this
   * runs, so a failure here must never surface as an AI failure (plan
   * section 48's spirit — same reasoning as this class's outer try/catch).
   */
  private async retrieveFor(player: PlayerRow, mode: AiMode, forbiddenTopics: string[]) {
    if (!this.memories) return [];
    const all = await this.memories.listByPlayer(player.id);
    const selected = retrieveMemories({ memories: all, mode, forbiddenTopics });
    if (selected.length > 0) {
      void this.memories
        .touchLastUsed(selected.map((m) => m.id))
        .catch((err) => this.logger.warn({ event: "memory.touch_failed", err: err instanceof Error ? err.message : String(err) }, "Failed to bump memory last_used_at"));
    }
    return selected;
  }

  async respondToAttendance(params: {
    player: PlayerRow;
    match: MatchRow;
    status: AttendanceRow["status"];
  }): Promise<AiOutcome> {
    const fallback: AiOutcome = { text: AI_FALLBACK_MESSAGE, source: "fallback" };
    if (!this.llm) return fallback;

    const mode = modeForStatus(params.status);
    // Section 34's own PLAYER->FORBIDDEN order means forbidden topics have
    // to exist before retrieval does — buildAIContext computes the same
    // list internally and returns it back out as `context.forbiddenTopics`
    // for the *output* validation below; forbiddenTopicsFor is the one
    // function both sides call so they can never drift apart.
    const forbiddenTopics = forbiddenTopicsFor(params.player);
    const memories = await this.retrieveFor(params.player, mode, forbiddenTopics);
    const context = buildAIContext({ player: params.player, mode, match: params.match, memories });
    const startedAt = Date.now();
    // Plan sections 51/58: metadata only — never prompt or response content.
    const base = {
      event: "ai.response",
      mode,
      playerId: params.player.id,
      matchId: params.match.id,
      model: this.llm.model,
      memoryCount: memories.length,
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

    const forbiddenTopics = forbiddenTopicsFor(params.player);
    const memories = await this.retrieveFor(params.player, "CONSOLE", forbiddenTopics);
    const context = buildConversationContext({
      player: params.player,
      match: params.match,
      transcript: params.transcript,
      maxPlayerTurns: params.maxPlayerTurns,
      memories,
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
      memoryCount: memories.length,
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
      // Defensive, not decorative: even if the prompt failed to suppress it
      // (buildConversationContext already tells the model not to bother
      // when memory usage is off), a candidate never survives here unless
      // the player's own setting allows it.
      const memoryCandidate = params.player.memoryUsageEnabled ? parsed.value.memoryCandidate : null;
      return { source: "ai", text: parsed.value.response, shouldFollowUp: parsed.value.shouldFollowUp, memoryCandidate };
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
