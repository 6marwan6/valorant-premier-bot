import { pgTable, pgEnum, serial, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { memories } from "./memories.js";

/**
 * Plan section 25's own two example sources: "Discord message #18372" and
 * "AI conversation #52". Both declared now (same "declare the full set up
 * front" precedent as `aiModeEnum`/`memoryTypeEnum`) even though Phase 8
 * only ever writes `AI_CONVERSATION` — memories are approved exclusively
 * out of a CONSOLE conversation (see memoryService.ts). `DISCORD_MESSAGE`
 * has no writer until raw channel-message storage exists, which this phase
 * deliberately does not build — see README's "Phase 8" section, "Passive
 * message scanning: deferred by design."
 *
 * `MATCH_EVENT` added in Phase 10: memoryService.createFromMatchEvent
 * evidences a post-match memory back to its schema/matchEvents.ts row
 * (plan section 40's "This allows the AI to make match-specific callbacks"
 * — the evidence link is what makes that callback traceable/removable,
 * same guarantee section 25 asks for on every other memory).
 *
 * `ADMIN_ENTRY` added 2026-09-28: a manually-entered "starter fact" (plan
 * section 21's spirit extended to admin-authored memories — see
 * memoryService.ts's `createFromAdminEntry`). `sourceId` for this type is
 * the entering admin's own Discord user id, so an admin-authored memory is
 * just as traceable/removable (section 25) as an AI-approved one.
 */
export const memoryEvidenceSourceTypeEnum = pgEnum("memory_evidence_source_type", [
  "AI_CONVERSATION",
  "DISCORD_MESSAGE",
  "MATCH_EVENT",
  "ADMIN_ENTRY",
]);

/**
 * Plan section 25 "Memory Evidence" — "every derived memory should be
 * traceable to evidence" — schema exactly as listed:
 *
 *   id / memory_id / source_type / source_id / created_at
 *
 * `sourceId` is `text`, not `integer`: an `AI_CONVERSATION` source is an
 * `ai_conversations.id` (numeric, stored as its string form) but a future
 * `DISCORD_MESSAGE` source is a Discord snowflake, which routinely exceeds
 * a 32-bit `integer` and is conventionally handled as a string throughout
 * this codebase (see `attendance.discordUserId`,
 * `aiMessages.sourceRef`) — one column, no type split needed later.
 *
 * No unique index on (memoryId, sourceType, sourceId): the same
 * conversation could plausibly back more than one memory, and a memory
 * could later gain a second piece of evidence (e.g. the same fact
 * mentioned again) — section 25 doesn't ask for evidence to be unique, only
 * traceable. `onDelete: cascade` is what makes memory deletion (section 43,
 * plan section 66 #7 "users control important personal memories") remove
 * its evidence trail in the same statement.
 */
export const memoryEvidence = pgTable(
  "memory_evidence",
  {
    id: serial("id").primaryKey(),

    memoryId: integer("memory_id")
      .notNull()
      .references(() => memories.id, { onDelete: "cascade" }),

    sourceType: memoryEvidenceSourceTypeEnum("source_type").notNull(),
    sourceId: text("source_id").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("memory_evidence_memory_idx").on(table.memoryId)],
);

export type MemoryEvidenceRow = typeof memoryEvidence.$inferSelect;
export type NewMemoryEvidenceRow = typeof memoryEvidence.$inferInsert;
