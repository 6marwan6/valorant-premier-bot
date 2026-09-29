import type { AiConversationRepository } from "../../database/repositories/aiConversationRepository.js";
import type { MemoryRepository } from "../../database/repositories/memoryRepository.js";
import type { PlayerRepository } from "../../database/repositories/playerRepository.js";
import type { MemoryRow } from "../../database/schema/memories.js";

/**
 * Plan section 21 "Memory Creation" (revised — see the section's own
 * changelog note) — the one and only place a memory gets created. A
 * candidate that survives every backend gate (aiOutput.ts's shape/
 * forbidden-topic check, aiService.ts's `memoryUsageEnabled` check, and
 * "only on a wrap-up turn" — see conversationContextBuilder.ts) is saved
 * automatically, the same turn it was proposed. There is no player
 * decision to wait for; consent is expressed once, up front, via the
 * player's own "Memory usage" setting (plan section 9) — off means this
 * method is never reached at all for that player.
 *
 * Framework-agnostic, same split as every other *Service in this
 * codebase: this decides whether a candidate becomes a memory;
 * discord/consoleConversation.ts moves the Discord message around it.
 */
export class MemoryService {
  constructor(
    private readonly memories: MemoryRepository,
    private readonly conversations: AiConversationRepository,
    private readonly players: PlayerRepository,
  ) {}

  /**
   * Saves a candidate that's already riding on an ASSISTANT message (see
   * schema/aiConversations.ts's doc comment on why there's no separate
   * staging table). Idempotent against retries (plan section 50): the
   * atomic `PENDING -> APPROVED` claim (same shape reminders.status
   * already uses) means calling this twice for the same message only ever
   * creates one memory — the second call sees the row already claimed and
   * returns `null`, exactly like a losing double-click used to.
   *
   * Returns `null` for "nothing to save" (no such message, no candidate,
   * or already saved) as well as "already saved" — callers don't need to
   * tell those apart, they just skip attaching a Forget button.
   */
  async autoSave(messageId: number): Promise<MemoryRow | null> {
    const message = await this.conversations.getMessageById(messageId);
    if (!message || !message.memoryCandidate) return null;

    const conversation = await this.conversations.getById(message.conversationId);
    if (!conversation) return null;

    // The single source of truth for "already saved" is this UPDATE's
    // WHERE clause, not a separate read-then-check — see
    // AiConversationRepository.claimMemoryCandidate's doc comment.
    const claimed = await this.conversations.claimMemoryCandidate(messageId, "APPROVED");
    if (!claimed) return null;

    // `claimed.memoryCandidate` is exactly what aiOutput.ts validated
    // before it was ever persisted (addMessage never accepts one that
    // didn't come through parseAiOutput) — trusted here the same way every
    // repository trusts its own table's shape.
    const candidate = claimed.memoryCandidate!;
    return this.memories.create({
      playerId: conversation.playerId,
      type: candidate.type as MemoryRow["type"],
      content: candidate.content,
      confidence: 1, // section 61: explicit statement in this turn -> full confidence, not an inferred guess
      visibility: "PRIVATE", // section 61's own example; section 21: "default visibility should be conservative"
      aiUsable: true,
      evidence: [{ sourceType: "AI_CONVERSATION", sourceId: String(conversation.id) }],
    });
  }

  /**
   * Plan section 40's stated purpose ("this allows the AI to make
   * match-specific callbacks") realized as a memory, and the "match
   * memories" piece of Phase 10 the README flagged Phase 9 retrieval as
   * ready for but had nothing to actually retrieve yet. Called from
   * postMatchService.ts once per player-tied match_events row (a
   * TEAM_EVENT, which has no player, never reaches here — see
   * memories.playerId being NOT NULL).
   *
   * Visibility TEAM, not PRIVATE like autoSave's player-approved memories:
   * this is an admin-recorded team performance fact, not something the
   * player privately disclosed about themselves, so section 44 rule 1
   * ("private information should never automatically become public") does
   * not apply the same way here — but PUBLIC (usable completely outside
   * team context) still isn't warranted either, so TEAM is "the most
   * restrictive reasonable visibility" (section 24) for this kind of fact.
   * Confidence 1, same reasoning as autoSave: the admin explicitly wrote
   * this down, it isn't an inferred guess (section 26).
   */
  async createFromMatchEvent(params: { playerId: number; content: string; matchEventId: number }): Promise<MemoryRow> {
    return this.memories.create({
      playerId: params.playerId,
      type: "MATCH_EVENT",
      content: params.content,
      confidence: 1,
      visibility: "TEAM",
      aiUsable: true,
      evidence: [{ sourceType: "MATCH_EVENT", sourceId: String(params.matchEventId) }],
    });
  }

  /**
   * Manual starter facts (2026-09-28) — an admin command extending plan
   * section 21's memory-creation flow to a case the plan doesn't cover:
   * seeding known team lore (an existing running joke, a preference the
   * team already knows) up front, rather than waiting for it to resurface
   * in conversation. Same category set (section 22), same confidence
   * reasoning as every other explicit-statement writer here (section 26:
   * confirmed fact, not an inferred guess) — the difference is only who's
   * stating it and what evidence that leaves (section 25): `sourceId` is
   * the entering admin's own Discord user id, not a conversation/match id.
   *
   * Visibility is the admin's own explicit choice, not a hidden default —
   * PROTECTED is honored the same as it would be from any other writer
   * (section 24: never reaches the LLM). Retrieval's forbidden-topic
   * filter (memoryRetrieval.ts's `isEligible`) and everything else in the
   * privacy pipeline (section 10) apply to this exactly like any other
   * memory — nothing about *how* a memory was created ever bypasses *how*
   * it's later allowed to be used.
   */
  async createFromAdminEntry(params: {
    playerId: number;
    type: MemoryRow["type"];
    content: string;
    visibility: MemoryRow["visibility"];
    adminDiscordUserId: string;
  }): Promise<MemoryRow> {
    return this.memories.create({
      playerId: params.playerId,
      type: params.type,
      content: params.content,
      confidence: 1,
      visibility: params.visibility,
      aiUsable: true,
      evidence: [{ sourceType: "ADMIN_ENTRY", sourceId: params.adminDiscordUserId }],
    });
  }

  /**
   * Plan section 43: "Players should be able to request deletion of their
   * memories" — now the *only* control a player has over an individual
   * memory (section 21's revised Rule 5), so it has to work from anywhere
   * a Forget button can appear: `/memories` (a guild channel) and the
   * auto-save note in a DM. Ownership is resolved from the memory's own
   * `playerId` rather than a `(guildId, discordUserId)` lookup — a DM
   * interaction has no `guildId` at all — the same "never trust the
   * client, re-check against the database" posture as
   * MemoryRepository.deleteForPlayer's own WHERE clause, just one layer
   * up. Section 44 rule 4 still holds: a memory that isn't the caller's
   * and one that doesn't exist are indistinguishable to the caller.
   */
  async deleteOwn(params: { discordUserId: string; memoryId: number }): Promise<"deleted" | "not_found"> {
    const memory = await this.memories.getById(params.memoryId);
    if (!memory) return "not_found";
    const player = await this.players.getById(memory.playerId);
    if (!player || player.discordUserId !== params.discordUserId) return "not_found";
    const deleted = await this.memories.deleteForPlayer(params.memoryId, player.id);
    return deleted ? "deleted" : "not_found";
  }
}
