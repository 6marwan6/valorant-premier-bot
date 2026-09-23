import { pgTable, pgEnum, serial, integer, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { matches } from "./matches.js";

/**
 * Plan section 13 "Reminder System" lists the fields verbatim:
 *
 *   match_id
 *   type
 *   scheduled_at
 *   sent_at
 *   status
 *   discord_message_id
 *
 * Two deliberate departures from that literal list, both documented here
 * rather than silently:
 *
 * 1. `type` -> `offsetMinutes` (integer, not a string/enum). V1 only ever
 *    has one *kind* of reminder — "N minutes before this match's kickoff"
 *    — so the thing that actually distinguishes one reminder row from
 *    another for the same match is the offset itself (plan section 13's
 *    own example schedule: 180 / 60 / 15 minutes before). A real `type`
 *    enum (e.g. distinguishing a kickoff reminder from a Phase 10
 *    post-match follow-up) can be added as an actual column later without
 *    breaking this one — it isn't needed yet (design principle #11:
 *    start simple).
 * 2. `status` gets a fourth value, `CLAIMED`, beyond the plan's implicit
 *    PENDING/SENT. This exists purely for plan section 50's idempotency
 *    requirement ("A retry must not result in... duplicate reminder"):
 *    the cron job atomically flips PENDING -> CLAIMED (a single
 *    UPDATE...WHERE status='PENDING' — see ReminderRepository.claim) to
 *    win a race against a second/overlapping cron invocation *before*
 *    calling Discord, then flips CLAIMED -> SENT after the message
 *    actually sends, or back to CLAIMED -> PENDING (so the next tick
 *    retries) if the Discord call throws. See services/scheduling/
 *    reminderCronJob.ts for exactly how this is used.
 *
 * No `guild_id` column: unlike `attendance` (which denormalizes it so
 * user-facing/privacy-sensitive queries can scope by guild directly),
 * every reminders query in V1 is internal to the cron job, which already
 * loops per-guild via server_config — joining through `match_id` is
 * enough and avoids a column that would just mirror `matches.guild_id`.
 */
export const reminderStatusEnum = pgEnum("reminder_status", ["PENDING", "CLAIMED", "SENT", "SKIPPED"]);

export const reminders = pgTable(
  "reminders",
  {
    id: serial("id").primaryKey(),

    matchId: integer("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),

    // Minutes before matches.scheduled_at this reminder is meant to fire.
    // See class doc above for why this replaces the plan's literal `type`.
    offsetMinutes: integer("offset_minutes").notNull(),

    // Recomputed as matches.scheduled_at - offsetMinutes whenever the
    // cron job reconciles a match (see reminderScheduling.ts). Absolute
    // instant subtraction — no DST math needed here, since
    // matches.scheduled_at is already an absolute UTC instant resolved
    // once at match-creation time (plan section 11 / dateTime.ts).
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),

    sentAt: timestamp("sent_at", { withTimezone: true }),

    status: reminderStatusEnum("status").notNull().default("PENDING"),

    // Where the reminder actually landed — the announcement message
    // (first reminder, plan sections 14/16) or a standalone nudge message
    // (later reminders). Nullable until sent.
    discordChannelId: text("discord_channel_id"),
    discordMessageId: text("discord_message_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Plan section 13: "Each reminder should have a unique record so it
    // cannot accidentally be sent twice." Enforced at the DB level: the
    // cron job's reconcile step upserts against this exact constraint,
    // the same pattern AttendanceRepository.upsert uses for its own
    // idempotency requirement (plan section 15).
    uniqueIndex("reminders_match_offset_idx").on(table.matchId, table.offsetMinutes),
    // The cron job's every-tick "what's due" query.
    index("reminders_status_scheduled_idx").on(table.status, table.scheduledAt),
  ],
);

export type ReminderRow = typeof reminders.$inferSelect;
export type NewReminderRow = typeof reminders.$inferInsert;
