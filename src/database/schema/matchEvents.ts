import { pgTable, pgEnum, serial, integer, text, timestamp, index } from "drizzle-orm/pg-core";
import { matches } from "./matches.js";
import { players } from "./players.js";

/**
 * Plan section 40 "Match Events", verbatim list:
 *   CLUTCH, MVP, TOP_FRAG, FUNNY_MOMENT, ACHIEVEMENT, TEAM_EVENT
 *
 * This is a *different* taxonomy from memories.ts's memoryTypeEnum, which
 * has its own single "MATCH_EVENT" category (plan section 22). The two are
 * bridged, not merged: a match_events row here that names a player can
 * become one memories row of type MATCH_EVENT (see
 * memoryService.createFromMatchEvent), evidenced back to this row's id
 * (memoryEvidence.sourceType "MATCH_EVENT"). TEAM_EVENT rows (no specific
 * player) never do, since memories.playerId is NOT NULL — see below.
 *
 * aiOutput.ts's MATCH_EVENT_TYPES is the dependency-free copy of this same
 * list that the extraction-output validator checks against; a unit test
 * pins the two together (tests/unit/matchEvents.test.ts) the same way
 * MEMORY_TYPES is meant to track memoryTypeEnum.
 */
export const matchEventTypeEnum = pgEnum("match_event_type", [
  "CLUTCH",
  "MVP",
  "TOP_FRAG",
  "FUNNY_MOMENT",
  "ACHIEVEMENT",
  "TEAM_EVENT",
]);

/**
 * A single match-specific fact — plan section 40: "Match-specific facts
 * should be stored separately from general memories... This allows the AI
 * to make match-specific callbacks without turning everything into
 * permanent personality information."
 *
 * Written exclusively by /complete-match (Phase 10, plan section 39):
 * admin notes are run through AiService.extractMatchEvents, and each
 * extracted item becomes one row here, evidence-linked from any memory it
 * spawns. There is deliberately no update path — a match event is a
 * point-in-time record of what happened, not something players edit later
 * (unlike memories, which section 43 lets a player delete).
 *
 * `playerId` is nullable: TEAM_EVENT describes something about the whole
 * match, not one player (plan section 40's type list includes it
 * specifically for that), and the extraction step also falls back to it
 * whenever admin notes don't name a specific roster member (see
 * matchEvents.ts's matchPlayerByName). `onDelete: "set null"` rather than
 * "cascade" — removing a player from the roster (plan section 41's
 * /remove-player) shouldn't erase the match's own history, just detach it
 * from that player.
 */
export const matchEvents = pgTable(
  "match_events",
  {
    id: serial("id").primaryKey(),

    matchId: integer("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),

    playerId: integer("player_id").references(() => players.id, { onDelete: "set null" }),

    type: matchEventTypeEnum("type").notNull(),
    description: text("description").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // /complete-match writes all of a match's events at once and nothing
    // else reads them outside that same match (recap generation, a future
    // /memories-style "match history" lookup).
    index("match_events_match_idx").on(table.matchId),
  ],
);

export type MatchEventRow = typeof matchEvents.$inferSelect;
export type NewMatchEventRow = typeof matchEvents.$inferInsert;
export type MatchEventType = MatchEventRow["type"];
