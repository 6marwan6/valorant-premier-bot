import { pgTable, pgEnum, serial, integer, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { serverConfig } from "./serverConfig.js";
import { reminderStatusEnum } from "./reminders.js";

/**
 * Weekly schedule polling (2026-10-03, owner's request — an amendment to plan
 * sections 11-16, see docs/Plan_Amendment_Weekly_Schedule.md).
 *
 * Instead of an admin creating ONE match that everyone confirms, the admin
 * posts a week of candidate match slots; players vote for every slot they can
 * play (or "can't play any day"); the slot with the most votes — if it has
 * enough players to queue — is the match the reminders go out for.
 *
 *   schedule_polls   the weekly post (one public message, edited in place)
 *   schedule_slots   its candidate times (+ the admin's optional queue time)
 *   schedule_votes   one row per (slot, player) — "I can play this slot"
 *   schedule_declines one row per (poll, player) — "I can't play any day"
 *   slot_reminders   the 5h / 15min reminders per slot (same claim pattern as `reminders`)
 *
 * The legacy single-match tables (matches/attendance/reminders) are untouched.
 */
export const schedulePollStatusEnum = pgEnum("schedule_poll_status", ["OPEN", "CANCELLED"]);

/**
 * Whether a slot's reminders go out. AUTO (default) = only while it is the
 * leading slot with enough votes; ALWAYS / NEVER are the admin's override
 * (e.g. the team wants to play two slots this week, or knows one is off).
 */
export const slotRemindModeEnum = pgEnum("slot_remind_mode", ["AUTO", "ALWAYS", "NEVER"]);

export const schedulePolls = pgTable(
  "schedule_polls",
  {
    id: serial("id").primaryKey(),
    guildId: text("guild_id")
      .notNull()
      .references(() => serverConfig.guildId, { onDelete: "cascade" }),
    status: schedulePollStatusEnum("status").notNull().default("OPEN"),
    // Snapshot of the team timezone the slot wall-clock times were read in
    // (same reasoning as matches.timezone).
    timezone: text("timezone").notNull(),
    channelId: text("channel_id").notNull(),
    // Null only between inserting the poll and posting its message.
    messageId: text("message_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("schedule_polls_guild_status_idx").on(table.guildId, table.status)],
);

export const scheduleSlots = pgTable(
  "schedule_slots",
  {
    id: serial("id").primaryKey(),
    pollId: integer("poll_id")
      .notNull()
      .references(() => schedulePolls.id, { onDelete: "cascade" }),
    // 1-based display order (earliest first); what /schedule-slot refers to.
    position: integer("position").notNull(),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    // The admin's "we're queuing at 7:30" edit. Null = queue at scheduledAt.
    queueAt: timestamp("queue_at", { withTimezone: true }),
    remindMode: slotRemindModeEnum("remind_mode").notNull().default("AUTO"),
    // Set once, atomically, by the vote that first brings the slot to quorum,
    // so the "MATCH ON" card is posted exactly once (plan section 50).
    quorumAnnouncedAt: timestamp("quorum_announced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("schedule_slots_poll_position_idx").on(table.pollId, table.position),
    uniqueIndex("schedule_slots_poll_time_idx").on(table.pollId, table.scheduledAt),
  ],
);

export const scheduleVotes = pgTable(
  "schedule_votes",
  {
    id: serial("id").primaryKey(),
    pollId: integer("poll_id")
      .notNull()
      .references(() => schedulePolls.id, { onDelete: "cascade" }),
    slotId: integer("slot_id")
      .notNull()
      .references(() => scheduleSlots.id, { onDelete: "cascade" }),
    discordUserId: text("discord_user_id").notNull(),
    // Snapshot at vote time, like attendance.discord_display_name.
    discordDisplayName: text("discord_display_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One vote per player per slot — the DB-level guard behind plan section 15's "no duplicate records".
    uniqueIndex("schedule_votes_slot_user_idx").on(table.slotId, table.discordUserId),
    index("schedule_votes_poll_idx").on(table.pollId),
  ],
);

/**
 * Mari's reaction to a schedule vote, at most once per (poll, player, kind):
 * the first slot a player votes for gets one CELEBRATE line and their "can't
 * play any day" gets one ROAST line — toggling votes on and off, or tapping a
 * second slot, must not make the channel a chat log. The row is claimed
 * *before* the model is called (INSERT ... ON CONFLICT DO NOTHING), so a
 * double-delivered click can never produce two replies (plan section 50).
 */
export const scheduleAiKindEnum = pgEnum("schedule_ai_kind", ["VOTE", "DECLINE"]);

export const scheduleAiReactions = pgTable(
  "schedule_ai_reactions",
  {
    id: serial("id").primaryKey(),
    pollId: integer("poll_id")
      .notNull()
      .references(() => schedulePolls.id, { onDelete: "cascade" }),
    discordUserId: text("discord_user_id").notNull(),
    kind: scheduleAiKindEnum("kind").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("schedule_ai_reactions_poll_user_kind_idx").on(table.pollId, table.discordUserId, table.kind)],
);

export const scheduleDeclines = pgTable(
  "schedule_declines",
  {
    id: serial("id").primaryKey(),
    pollId: integer("poll_id")
      .notNull()
      .references(() => schedulePolls.id, { onDelete: "cascade" }),
    discordUserId: text("discord_user_id").notNull(),
    discordDisplayName: text("discord_display_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("schedule_declines_poll_user_idx").on(table.pollId, table.discordUserId)],
);

export const slotReminders = pgTable(
  "slot_reminders",
  {
    id: serial("id").primaryKey(),
    slotId: integer("slot_id")
      .notNull()
      .references(() => scheduleSlots.id, { onDelete: "cascade" }),
    offsetMinutes: integer("offset_minutes").notNull(),
    // Effective time (queue time, else slot time) minus the offset.
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    status: reminderStatusEnum("status").notNull().default("PENDING"),
    discordChannelId: text("discord_channel_id"),
    discordMessageId: text("discord_message_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Plan section 13: a unique record per reminder so it can't be sent twice.
    uniqueIndex("slot_reminders_slot_offset_idx").on(table.slotId, table.offsetMinutes),
    index("slot_reminders_status_scheduled_idx").on(table.status, table.scheduledAt),
  ],
);

export type SchedulePollRow = typeof schedulePolls.$inferSelect;
export type ScheduleSlotRow = typeof scheduleSlots.$inferSelect;
export type ScheduleVoteRow = typeof scheduleVotes.$inferSelect;
export type ScheduleDeclineRow = typeof scheduleDeclines.$inferSelect;
export type SlotReminderRow = typeof slotReminders.$inferSelect;
export type ScheduleAiKind = (typeof scheduleAiKindEnum.enumValues)[number];
export type SlotRemindMode = ScheduleSlotRow["remindMode"];
