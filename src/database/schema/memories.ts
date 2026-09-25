import { pgTable, pgEnum, serial, text, integer, real, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { players } from "./players.js";

/**
 * Plan section 22 "Memory Categories" — the exact nine, verbatim, no more:
 * "Avoid unrestricted arbitrary memory categories." Declared as a fixed
 * enum (same reasoning as `playerRoleEnum` and `aiModeEnum`) so a candidate
 * with a category outside this list fails validation instead of quietly
 * inventing a new one.
 */
export const memoryTypeEnum = pgEnum("memory_type", [
  "PLAYER_PREFERENCE",
  "PERSONALITY_TRAIT",
  "RUNNING_JOKE",
  "VALORANT_PREFERENCE",
  "TEAM_JOKE",
  "MATCH_EVENT",
  "ACHIEVEMENT",
  "HABIT",
  "TEAM_HISTORY",
]);

/**
 * Plan section 24 "Memory Visibility" — all four, in the plan's own order.
 * Phase 8's only creation path (an approved CONSOLE conversation candidate,
 * section 61) always writes PRIVATE (see memoryService.ts); TEAM/PUBLIC
 * have no writer yet (nothing in V1 asks a player to loosen a memory's
 * visibility) and PROTECTED has no writer either — it exists here as a
 * value the *filtering* side (Phase 9's retrieval, section 10's "must
 * filter protected information before constructing the AI context") can
 * check for and refuse to serve, per section 24's own words: "Never
 * provided to the LLM."
 */
export const memoryVisibilityEnum = pgEnum("memory_visibility", ["PUBLIC", "TEAM", "PRIVATE", "PROTECTED"]);

/**
 * One curated fact about a player — plan section 23 "Memory Structure":
 *
 *   id / player_id / type / content / confidence / importance / visibility
 *   / ai_usable / created_at / updated_at / last_used_at
 *
 * Every column above is written here, one-for-one. Notes on the two that
 * need them:
 *
 * - `playerId` is a real FK to `players.id`, cascading on delete. Plan
 *   section 8's own class doc predicted this table would "key off
 *   discord_user_id, not this table's id" — written back when Phase 5 was
 *   guessing ahead at Phase 8. Phase 7 already set the actual precedent
 *   (`ai_conversations.player_id` is a `players.id` FK: see
 *   schema/aiConversations.ts), and it holds here for the same reasons: a
 *   removed player is soft-deleted, never dropped (schema/players.ts), so
 *   the FK never dangles, and every query this table needs ("this
 *   player's memories", `/memories`, future retrieval) already has
 *   `players.id` in hand rather than a raw Discord snowflake.
 * - `confidence` is a `real` in `[0, 1]` (section 26's own scale: "0.87",
 *   "1.0"). Phase 8's only writer is an explicit, player-confirmed fact
 *   (section 61: "Confidence: 1.0") — always 1.0. Nothing yet lowers it
 *   for a one-off inferred statement (section 26's other case, "repeated
 *   behavior" raising confidence over time) because Phase 8 has no
 *   inference path at all (see memoryService.ts's doc comment); that's
 *   Phase 9 retrieval-ranking territory (plan section 33).
 *
 * `importance` (0-100, same scale idiom as `players.roastIntensity`) and
 * `lastUsedAt` are carried as columns now because section 23 lists them,
 * but neither has a real writer yet: nothing in V1 lets a player or admin
 * set importance, and nothing retrieves memories into an AI context yet
 * (that's Phase 9, plan section 33's ranking formula) to ever touch
 * `lastUsedAt`. `importance` defaults to 50 (the same "normal" midpoint
 * `roastIntensity` uses) purely so the column is never null; the value is
 * inert until Phase 9 gives it a purpose.
 */
export const memories = pgTable(
  "memories",
  {
    id: serial("id").primaryKey(),

    playerId: integer("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),

    type: memoryTypeEnum("type").notNull(),
    content: text("content").notNull(),

    confidence: real("confidence").notNull().default(1),
    importance: integer("importance").notNull().default(50),
    visibility: memoryVisibilityEnum("visibility").notNull().default("PRIVATE"),
    aiUsable: boolean("ai_usable").notNull().default(true),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (table) => [
    // "This player's memories" is every read Phase 8 does: /memories
    // (section 43), memory deletion, and — later — Phase 9 retrieval.
    index("memories_player_idx").on(table.playerId, table.id),
  ],
);

export type MemoryRow = typeof memories.$inferSelect;
export type NewMemoryRow = typeof memories.$inferInsert;
export type MemoryType = MemoryRow["type"];
export type MemoryVisibility = MemoryRow["visibility"];
