import { pgTable, pgEnum, serial, text, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { matches } from "./matches.js";

/**
 * Plan section 15 "Attendance System" lists four statuses: PLAYING,
 * CANNOT_PLAY, WANTS_TO_BUT_CANNOT, NO_RESPONSE. Only the first three are
 * ever stored as a row here — NO_RESPONSE is the *absence* of a row for a
 * given (match, discord_user_id) pair, not a stored state. This isn't a
 * simplification of the plan's intent so much as a necessity: enumerating
 * "who hasn't responded" requires knowing who's *expected* to respond,
 * which needs the team roster from Player Profiles — explicitly Phase 5,
 * which comes after Attendance (Phase 3) in the plan's own phase
 * ordering. See README's Phase 3 section for how this gets reconciled
 * once Phase 5 lands.
 */
export const attendanceStatusEnum = pgEnum("attendance_status", [
  "PLAYING",
  "CANNOT_PLAY",
  "WANTS_TO_BUT_CANNOT",
]);

/**
 * One player's current response to one match — plan section 15.
 *
 * Keyed by raw Discord identity (`discordUserId`), not a `players` table
 * FK, for the same reason NO_RESPONSE isn't stored: there is no players
 * table yet (Phase 5). `discordDisplayName` is a snapshot taken at
 * response time purely so the public roster message (section 16) can show
 * a name without an extra Discord API round-trip or a profile lookup that
 * doesn't exist yet. This is intentionally forward-compatible (plan
 * design principle #12: no rewrite of the core match/attendance system
 * later) — Phase 5 can start joining on discord_user_id without touching
 * this table's shape.
 *
 * Section 15: "If the player clicks the same button twice, the system
 * should not create duplicate attendance records. If the player changes
 * their answer, update the existing response." Enforced via a unique
 * (match_id, discord_user_id) index — writes go through an upsert
 * (see AttendanceRepository.upsert).
 *
 * "Keep the current state and optionally maintain an attendance history."
 * — history is explicitly optional in the plan; Phase 3 keeps only
 * current state (design principle #11: start simple).
 */
export const attendance = pgTable(
  "attendance",
  {
    id: serial("id").primaryKey(),

    // Denormalized alongside matchId (rather than joined through it) so
    // queries and privacy checks can scope by guild directly, matching
    // the pattern already used on `matches` itself.
    guildId: text("guild_id").notNull(),

    matchId: integer("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),

    discordUserId: text("discord_user_id").notNull(),
    discordDisplayName: text("discord_display_name").notNull(),

    status: attendanceStatusEnum("status").notNull(),

    respondedAt: timestamp("responded_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Section 15's idempotency requirement, enforced at the DB level —
    // AttendanceRepository.upsert relies on this exact constraint for its
    // ON CONFLICT clause.
    uniqueIndex("attendance_match_user_idx").on(table.matchId, table.discordUserId),
    // The roster message rebuild (plan section 16) always reads "every
    // response for this match."
    index("attendance_match_idx").on(table.matchId),
  ],
);

export type AttendanceRow = typeof attendance.$inferSelect;
export type NewAttendanceRow = typeof attendance.$inferInsert;
