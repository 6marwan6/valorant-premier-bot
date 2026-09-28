import { pgTable, pgEnum, serial, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { serverConfig } from "./serverConfig.js";

/**
 * Match lifecycle states — plan section 12 "Match States", verbatim:
 *   SCHEDULED -> CONFIRMATION_OPEN -> IN_PROGRESS -> COMPLETED
 * with CANCELLED reachable "from any state before completion where
 * appropriate."
 *
 * Phase 2 only ever creates matches in SCHEDULED and moves them to
 * CANCELLED. CONFIRMATION_OPEN/IN_PROGRESS/COMPLETED are set by later
 * phases (3 and 9/10 respectively) — the enum is defined in full now so
 * the column type never needs an ALTER TYPE migration later.
 */
export const matchStatusEnum = pgEnum("match_status", [
  "SCHEDULED",
  "CONFIRMATION_OPEN",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
]);

/**
 * Plan section 39 "Post-Match Mode": /complete-match's Result input.
 * Nullable on the row itself (below) since a match only has a result once
 * COMPLETED — SCHEDULED/CONFIRMATION_OPEN/IN_PROGRESS/CANCELLED never do.
 */
export const matchResultEnum = pgEnum("match_result", ["WIN", "LOSS"]);

/**
 * A single Premier match — plan section 11 "Match Creation" / section 12
 * "Match States".
 *
 * No `opponent` column (removed 2026-09-27, see plan section 11's revision
 * note): Valorant Premier doesn't reveal the opposing team until the match
 * itself starts, so an admin typing one in at `/create-match` time was
 * always either a guess or a placeholder. A match is identified by its
 * scheduled time alone from here on.
 *
 * `id` is a plain auto-incrementing integer specifically so matches can be
 * referenced as "Match #42" the way plan section 61's example scenario
 * does ("System: Match #42 created."), rather than a UUID nobody could
 * type into a Discord command option.
 *
 * `scheduledAt` stores the absolute UTC instant (Postgres `timestamptz`),
 * which is what actually needs to be correct for reminders (plan section
 * 13) — DST and timezone-offset differences are resolved once, at
 * creation time, rather than recomputed on every read. `timezone` is kept
 * alongside it purely so the original wall-clock time can always be
 * redisplayed exactly as the admin entered it, even if the guild's
 * configured timezone (section 53) is changed later.
 *
 * No attendance table here — that's schema/attendance.ts (Phase 3).
 * `announcementChannelId`/`announcementMessageId` were added in Phase 3
 * once the public match message (plan section 14/16) needed somewhere to
 * live.
 */
export const matches = pgTable(
  "matches",
  {
    id: serial("id").primaryKey(),

    // References server_config.guild_id — a match cannot exist for a guild
    // that has never run /setup (plan section 53 is the config source of
    // truth, including which timezone to interpret the match's Date/Time
    // options in).
    guildId: text("guild_id")
      .notNull()
      .references(() => serverConfig.guildId, { onDelete: "cascade" }),

    // Absolute instant, UTC. Plan section 11 (revised): "Date, Time" plus
    // "the team's configured timezone should be used automatically."
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),

    // Snapshot of the timezone used to interpret Date/Time at creation
    // time (see class doc above).
    timezone: text("timezone").notNull(),

    status: matchStatusEnum("status").notNull().default("SCHEDULED"),

    // Set when the public match/attendance message is posted (plan
    // sections 14/16, Phase 3). Nullable because a SCHEDULED match that
    // hasn't been opened for confirmation yet has no public message.
    // Snapshotting the channel alongside the message id (rather than
    // always reading server_config.match_channel_id at update time) means
    // a later /setup changing the match channel doesn't orphan an
    // already-posted message.
    announcementChannelId: text("announcement_channel_id"),
    announcementMessageId: text("announcement_message_id"),

    // Phase 10 (plan section 39): set together by /complete-match, never
    // independently — see matchLifecycle.canCompleteMatch. `notes` is the
    // admin's raw freeform input ("Ahmed clutched round 19. ..."); the
    // structured per-player breakdown derived from it lives in
    // schema/matchEvents.ts, not here.
    result: matchResultEnum("result"),
    notes: text("notes"),
    completedAt: timestamp("completed_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // /list-matches always filters/sorts by guild + time.
    index("matches_guild_scheduled_idx").on(table.guildId, table.scheduledAt),
    // Plan section 11: "Match is not accidentally duplicated." Enforced at
    // the DB level (not just app-level validation) for the same instant
    // within a guild, but only while the match is still "live" — a team
    // can't actually play two Premier matches at once, so with no
    // opponent to key on anymore, the same scheduled instant alone is
    // exactly the duplicate signal. CANCELLED matches don't block
    // recreating the same slot — a partial unique index lets us express
    // exactly that instead of a plain unique constraint.
    uniqueIndex("matches_guild_time_active_idx")
      .on(table.guildId, table.scheduledAt)
      .where(sql`status <> 'CANCELLED'`),
  ],
);

export type MatchRow = typeof matches.$inferSelect;
export type NewMatchRow = typeof matches.$inferInsert;
