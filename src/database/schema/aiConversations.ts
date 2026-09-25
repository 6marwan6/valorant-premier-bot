import { pgTable, pgEnum, serial, text, integer, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { matches } from "./matches.js";
import { players } from "./players.js";

/**
 * Plan section 3 lists four initial AI modes (CELEBRATE, ROAST, CONSOLE,
 * MATCH_HYPE) and section 3 also names POST_MATCH as a future one. All five
 * are declared now so the column type never needs an `ALTER TYPE` later
 * (same reasoning `matchStatusEnum` used in Phase 2). Phase 7 only ever
 * writes CONSOLE — the one mode the plan defines as a real back-and-forth
 * (section 20); CELEBRATE/ROAST stay single private messages (sections 18/19).
 */
export const aiModeEnum = pgEnum("ai_mode", ["CELEBRATE", "ROAST", "CONSOLE", "MATCH_HYPE", "POST_MATCH"]);

/**
 * Why a conversation ended. Section 29 only lists `ended_at`; a reason is
 * added because "why did it stop" is otherwise unrecoverable (a player who
 * changed their answer vs. an LLM outage vs. closed DMs all look identical
 * as a bare timestamp) and it costs one nullable column.
 */
export const aiConversationEndReasonEnum = pgEnum("ai_conversation_end_reason", [
  "COMPLETED", // the conversation reached a natural end
  "TURN_LIMIT", // backend cap on player turns (plan section 37: the backend, not the LLM, owns state)
  "ATTENDANCE_CHANGED", // the player changed their answer, so this mode no longer applies
  "MATCH_CLOSED", // the match was cancelled / started / completed
  "IDLE_TIMEOUT", // nobody replied for a long time
  "AI_FAILURE", // LLM unavailable or its output was rejected (plan section 48)
  "DM_UNAVAILABLE", // the player's DMs are closed to the bot
]);

/**
 * One private AI conversation with one player about one match — plan
 * section 29:
 *
 *   id / player_id / match_id / mode / started_at / ended_at
 *
 * Departures from that literal list, documented rather than silent:
 *
 * - `guildId` — denormalized exactly like `attendance` does, so
 *   privacy-relevant queries can scope by guild without a join.
 * - `endReason` — see `aiConversationEndReasonEnum`.
 * - `dmChannelId` / `lastSeenMessageId` — transport state for the DM
 *   itself. `lastSeenMessageId` is the poll cursor: the newest Discord
 *   message in the DM channel the poller has already looked at (see
 *   services/scheduling/dmReplyPollJob.ts). It is an optimization for the
 *   fetch window only; duplicate-processing safety comes from
 *   `ai_messages.source_ref`, not from this column.
 * - `lastActivityAt` — drives the idle timeout.
 *
 * "One conversation at a time per player per match" is enforced by the DB
 * (partial unique index on rows that haven't ended), the same way
 * attendance idempotency (section 15) and reminder uniqueness (section 13)
 * are — a double-clicked button can never create two conversations
 * (plan section 50: "duplicate AI conversation").
 */
export const aiConversations = pgTable(
  "ai_conversations",
  {
    id: serial("id").primaryKey(),

    guildId: text("guild_id").notNull(),

    playerId: integer("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),

    matchId: integer("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),

    mode: aiModeEnum("mode").notNull(),

    dmChannelId: text("dm_channel_id"),
    lastSeenMessageId: text("last_seen_message_id"),

    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endReason: aiConversationEndReasonEnum("end_reason"),
  },
  (table) => [
    uniqueIndex("ai_conversations_one_open_per_player_match_idx")
      .on(table.playerId, table.matchId)
      .where(sql`ended_at IS NULL`),
    // The DM poller's every-tick "which conversations are still open" scan.
    index("ai_conversations_open_idx")
      .on(table.guildId)
      .where(sql`ended_at IS NULL`),
  ],
);

/** Plan section 29: roles USER / ASSISTANT / SYSTEM. Phase 7 writes USER and ASSISTANT only. */
export const aiMessageRoleEnum = pgEnum("ai_message_role", ["USER", "ASSISTANT", "SYSTEM"]);

/**
 * Where a proposed memory (plan section 21) currently stands. `PENDING` is
 * set the moment the model's `memory_candidate` is accepted onto an
 * ASSISTANT row; the player's button click resolves it. An
 * `UPDATE ... WHERE memory_candidate_status = 'PENDING'` is the actual
 * duplicate-decision guard (see MemoryRepository.claimCandidate) — the same
 * claim-then-act pattern `reminders.status` already uses, chosen for the
 * same reason: a double-tapped button can't decide the same candidate
 * twice (plan section 50).
 */
export const memoryCandidateStatusEnum = pgEnum("memory_candidate_status", ["PENDING", "APPROVED", "DECLINED"]);

/**
 * One message inside a conversation — plan section 29:
 *
 *   id / conversation_id / role / content / created_at
 *
 * plus `sourceRef`: where a USER message came from (`interaction:<id>` for
 * the Reply-button modal, `message:<id>` for a typed DM). The unique index
 * on (conversation_id, source_ref) is what makes "process this player
 * message" idempotent (plan section 50: "AI interaction processing") no
 * matter which path delivered it or how often it was retried. It is NULL
 * for ASSISTANT rows; Postgres treats NULLs as distinct, so those never
 * collide.
 *
 * Section 29: "The complete conversation should not automatically be
 * injected into future AI requests." Nothing outside the conversation's
 * own turns read this table in Phase 7; Phase 8 distills it into
 * memories via exactly two extra columns on an ASSISTANT row:
 *
 * - `memoryCandidate` — the `{type, content}` the model proposed
 *   remembering (plan section 36), or null. This IS the memory's evidence
 *   once approved (section 25: "AI conversation #52") — no separate
 *   staging table, because the ASSISTANT message that proposed it already
 *   is the record of when/why/from-what-conversation it was proposed.
 * - `memoryCandidateStatus` — see `memoryCandidateStatusEnum` above. Null
 *   when there's no candidate on this row at all (the overwhelming
 *   majority of ASSISTANT messages).
 */
export const aiMessages = pgTable(
  "ai_messages",
  {
    id: serial("id").primaryKey(),

    conversationId: integer("conversation_id")
      .notNull()
      .references(() => aiConversations.id, { onDelete: "cascade" }),

    role: aiMessageRoleEnum("role").notNull(),
    content: text("content").notNull(),
    sourceRef: text("source_ref"),

    memoryCandidate: jsonb("memory_candidate").$type<{ type: string; content: string } | null>(),
    memoryCandidateStatus: memoryCandidateStatusEnum("memory_candidate_status"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("ai_messages_conversation_source_ref_idx").on(table.conversationId, table.sourceRef),
    index("ai_messages_conversation_idx").on(table.conversationId, table.id),
  ],
);

export type AiConversationRow = typeof aiConversations.$inferSelect;
export type NewAiConversationRow = typeof aiConversations.$inferInsert;
export type AiMessageRow = typeof aiMessages.$inferSelect;
export type NewAiMessageRow = typeof aiMessages.$inferInsert;
export type AiConversationEndReason = NonNullable<AiConversationRow["endReason"]>;
export type MemoryCandidateStatus = NonNullable<AiMessageRow["memoryCandidateStatus"]>;
