import type { AiConversationRepository } from "../../database/repositories/aiConversationRepository.js";
import type { MemoryRepository } from "../../database/repositories/memoryRepository.js";
import type { PlayerRepository } from "../../database/repositories/playerRepository.js";
import type { MemoryRow } from "../../database/schema/memories.js";

export type MemoryDecisionOutcome =
  /** No such message, or it never carried a candidate at all (stale/forged button). */
  | { kind: "not_found" }
  /** Whoever clicked isn't the conversation's player (plan section 44 rule 3). */
  | { kind: "forbidden" }
  /** Already approved or declined — a double click, or the other button already used (plan section 50). */
  | { kind: "already_decided" }
  /** Plan section 21: "Do not create a reusable memory from that fact." Nothing was written. */
  | { kind: "declined"; originalText: string }
  | { kind: "remembered"; memory: MemoryRow; originalText: string };

/**
 * Plan section 21 "Memory Permission Flow" — the one and only place a
 * memory gets created in Phase 8. Framework-agnostic, same split as every
 * other *Service in this codebase: this decides whether a candidate becomes
 * a memory; discord/memoryDecision.ts moves Discord messages around it.
 *
 * There is deliberately no "propose" method here — proposing happens
 * inline in AiService.respondInConversation / ConversationService (the
 * candidate rides on the ASSISTANT message that suggested it, see
 * schema/aiConversations.ts). This service only resolves one that already
 * exists, because plan section 37 draws the line there: the model suggests
 * as part of its normal turn, but a *separate*, explicit, user-driven step
 * is what's allowed to write to the database.
 */
export class MemoryService {
  constructor(
    private readonly memories: MemoryRepository,
    private readonly conversations: AiConversationRepository,
    private readonly players: PlayerRepository,
  ) {}

  async decide(params: {
    messageId: number;
    /** Discord id of whoever clicked — must be the conversation's own player. */
    discordUserId: string;
    decision: "remember" | "decline";
  }): Promise<MemoryDecisionOutcome> {
    const message = await this.conversations.getMessageById(params.messageId);
    if (!message || !message.memoryCandidate) return { kind: "not_found" };

    const conversation = await this.conversations.getById(message.conversationId);
    if (!conversation) return { kind: "not_found" };

    // Section 44 rule 3/4: even knowing whether a memory exists is another
    // player's business only for their own conversations. Ownership is
    // checked before the claim below, not just before the write, so a
    // forbidden request can't consume the one-time PENDING -> decided
    // transition on someone else's behalf.
    const player = await this.players.getById(conversation.playerId);
    if (!player || player.discordUserId !== params.discordUserId) return { kind: "forbidden" };

    // The single source of truth for "already decided" is this UPDATE's
    // WHERE clause, not a separate read-then-check — see
    // AiConversationRepository.claimMemoryCandidate's doc comment.
    const claimed = await this.conversations.claimMemoryCandidate(
      params.messageId,
      params.decision === "remember" ? "APPROVED" : "DECLINED",
    );
    if (!claimed) return { kind: "already_decided" };

    if (params.decision === "decline") return { kind: "declined", originalText: message.content };

    // `claimed.memoryCandidate` is exactly what aiOutput.ts validated
    // before it was ever persisted (addMessage never accepts one that
    // didn't come through parseAiOutput) — trusted here the same way every
    // repository trusts its own table's shape.
    const candidate = claimed.memoryCandidate!;
    const memory = await this.memories.create({
      playerId: player.id,
      type: candidate.type as MemoryRow["type"],
      content: candidate.content,
      confidence: 1, // section 61: explicit + player-confirmed -> full confidence, not an inferred guess
      visibility: "PRIVATE", // section 61's own example; section 21: "default visibility should be conservative"
      aiUsable: true,
      evidence: [{ sourceType: "AI_CONVERSATION", sourceId: String(conversation.id) }],
    });
    return { kind: "remembered", memory, originalText: message.content };
  }

  /**
   * Plan section 43: "Players should be able to request deletion of their
   * memories." Ownership is re-derived from (guildId, discordUserId) on
   * every call rather than trusted from the button that was clicked — the
   * same "never trust the client, re-check against the database" posture
   * as MemoryRepository.deleteForPlayer's own WHERE clause, just one layer
   * up.
   */
  async deleteOwn(params: { guildId: string; discordUserId: string; memoryId: number }): Promise<"deleted" | "not_found"> {
    const player = await this.players.getByDiscordUserId(params.guildId, params.discordUserId);
    if (!player) return "not_found";
    const deleted = await this.memories.deleteForPlayer(params.memoryId, player.id);
    return deleted ? "deleted" : "not_found";
  }
}
