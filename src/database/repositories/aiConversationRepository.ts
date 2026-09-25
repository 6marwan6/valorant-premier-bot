import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import {
  aiConversations,
  aiMessages,
  type AiConversationEndReason,
  type AiConversationRow,
  type AiMessageRow,
  type MemoryCandidateStatus,
} from "../schema/aiConversations.js";

export interface OpenConversationInput {
  guildId: string;
  playerId: number;
  matchId: number;
  mode: AiConversationRow["mode"];
}

/**
 * Repository for `ai_conversations` / `ai_messages` — plan section 29
 * (Phase 7). Thin like its siblings: it enforces the database-level
 * guarantees (one open conversation per player per match; one row per
 * source message) and nothing about *when* a conversation should start,
 * continue or end — that's modules/ai/conversationService.ts.
 */
export class AiConversationRepository {
  constructor(private readonly db: Database) {}

  /**
   * Opens a conversation unless this player already has an open one for
   * this match, in which case that one is returned with `created: false`.
   * The partial unique index (see schema) makes this race-safe: two
   * near-simultaneous calls cannot both insert (plan section 50).
   */
  async openOrGet(input: OpenConversationInput): Promise<{ conversation: AiConversationRow; created: boolean }> {
    const [inserted] = await this.db
      .insert(aiConversations)
      .values(input)
      .onConflictDoNothing({
        target: [aiConversations.playerId, aiConversations.matchId],
        where: sql`ended_at IS NULL`,
      })
      .returning();
    if (inserted) return { conversation: inserted, created: true };

    const existing = await this.getOpenForPlayerMatch(input.playerId, input.matchId);
    if (!existing) {
      // The other writer ended the conversation between our insert and our
      // read. Vanishingly rare; surface it rather than guessing.
      throw new Error(`Could not open or find a conversation for player ${input.playerId} / match ${input.matchId}`);
    }
    return { conversation: existing, created: false };
  }

  async getById(id: number): Promise<AiConversationRow | undefined> {
    const rows = await this.db.select().from(aiConversations).where(eq(aiConversations.id, id)).limit(1);
    return rows[0];
  }

  async getOpenForPlayerMatch(playerId: number, matchId: number): Promise<AiConversationRow | undefined> {
    const rows = await this.db
      .select()
      .from(aiConversations)
      .where(
        and(eq(aiConversations.playerId, playerId), eq(aiConversations.matchId, matchId), isNull(aiConversations.endedAt)),
      )
      .limit(1);
    return rows[0];
  }

  /** Every still-open conversation that has a DM channel — the poller's work list. */
  async listOpenWithDm(): Promise<AiConversationRow[]> {
    const rows = await this.db
      .select()
      .from(aiConversations)
      .where(isNull(aiConversations.endedAt))
      .orderBy(asc(aiConversations.id));
    return rows.filter((row) => row.dmChannelId !== null);
  }

  async setDmChannel(id: number, dmChannelId: string, lastSeenMessageId: string): Promise<void> {
    await this.db
      .update(aiConversations)
      .set({ dmChannelId, lastSeenMessageId, lastActivityAt: new Date() })
      .where(eq(aiConversations.id, id));
  }

  async touch(id: number): Promise<void> {
    await this.db.update(aiConversations).set({ lastActivityAt: new Date() }).where(eq(aiConversations.id, id));
  }

  /**
   * Moves the poll cursor forward, never backward (Discord snowflakes are
   * numeric and increase over time, so the comparison is done as bigint).
   */
  async advanceCursor(id: number, newestMessageId: string): Promise<void> {
    await this.db
      .update(aiConversations)
      .set({ lastSeenMessageId: newestMessageId })
      .where(
        and(
          eq(aiConversations.id, id),
          sql`(${aiConversations.lastSeenMessageId} IS NULL OR ${aiConversations.lastSeenMessageId}::bigint < ${newestMessageId}::bigint)`,
        ),
      );
  }

  /**
   * Ends a conversation. Idempotent: ending an already-ended (or missing)
   * conversation returns `false` and changes nothing, so the first reason
   * recorded is the one that sticks.
   */
  async end(id: number, reason: AiConversationEndReason): Promise<boolean> {
    const rows = await this.db
      .update(aiConversations)
      .set({ endedAt: new Date(), endReason: reason })
      .where(and(eq(aiConversations.id, id), isNull(aiConversations.endedAt)))
      .returning({ id: aiConversations.id });
    return rows.length > 0;
  }

  /**
   * Ends this player's open conversation(s) for a match. `exceptMode`
   * spares conversations of that mode — used when a player's answer changes:
   * a conversation that already matches the *new* answer (e.g. the other
   * half of a double-clicked button) must survive.
   */
  async endOpenForPlayerMatch(
    playerId: number,
    matchId: number,
    reason: AiConversationEndReason,
    exceptMode?: AiConversationRow["mode"],
  ): Promise<number> {
    const rows = await this.db
      .update(aiConversations)
      .set({ endedAt: new Date(), endReason: reason })
      .where(
        and(
          eq(aiConversations.playerId, playerId),
          eq(aiConversations.matchId, matchId),
          isNull(aiConversations.endedAt),
          exceptMode ? ne(aiConversations.mode, exceptMode) : undefined,
        ),
      )
      .returning({ id: aiConversations.id });
    return rows.length;
  }

  /**
   * Stores a message. Returns `null` when a row with the same
   * (conversation, sourceRef) already exists — i.e. this player message
   * was already processed (plan section 50).
   */
  async addMessage(input: {
    conversationId: number;
    role: AiMessageRow["role"];
    content: string;
    sourceRef?: string;
    /** Phase 8: a proposed memory riding on this (always ASSISTANT) message — see aiConversations.ts's schema doc. */
    memoryCandidate?: { type: string; content: string };
  }): Promise<AiMessageRow | null> {
    const [row] = await this.db
      .insert(aiMessages)
      .values({
        conversationId: input.conversationId,
        role: input.role,
        content: input.content,
        sourceRef: input.sourceRef ?? null,
        memoryCandidate: input.memoryCandidate ?? null,
        // Set together with the candidate itself — never PENDING without a
        // candidate, never a candidate stuck permanently un-decidable.
        memoryCandidateStatus: input.memoryCandidate ? "PENDING" : null,
      })
      .onConflictDoNothing({ target: [aiMessages.conversationId, aiMessages.sourceRef] })
      .returning();
    return row ?? null;
  }

  async listMessages(conversationId: number): Promise<AiMessageRow[]> {
    return this.db
      .select()
      .from(aiMessages)
      .where(eq(aiMessages.conversationId, conversationId))
      .orderBy(asc(aiMessages.id));
  }

  async getMessageById(id: number): Promise<AiMessageRow | undefined> {
    const rows = await this.db.select().from(aiMessages).where(eq(aiMessages.id, id)).limit(1);
    return rows[0];
  }

  /**
   * Resolves a pending memory candidate exactly once — plan section 50
   * ("duplicate AI interaction processing"), same claim-then-act shape as
   * `reminders.status` (PENDING -> CLAIMED/SENT). The single
   * `UPDATE ... WHERE memory_candidate_status = 'PENDING'` is the entire
   * guard: a double-tapped Remember/Don't Remember button can only ever
   * win this race once, and the loser gets back the already-decided row
   * (`memoryDecision.ts` treats that as "already handled," not an error).
   */
  async claimMemoryCandidate(messageId: number, resolution: MemoryCandidateStatus): Promise<AiMessageRow | null> {
    const [row] = await this.db
      .update(aiMessages)
      .set({ memoryCandidateStatus: resolution })
      .where(and(eq(aiMessages.id, messageId), eq(aiMessages.memoryCandidateStatus, "PENDING")))
      .returning();
    return row ?? null;
  }
}
