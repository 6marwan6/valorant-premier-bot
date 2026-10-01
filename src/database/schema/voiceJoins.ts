import { pgTable, pgEnum, serial, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * /mari-join requests (2026-10-01) — an admin tells Mari which voice channel to
 * join and when. The slash command runs on the serverless app, but the voice
 * connection lives in the gateway worker, so the request travels through the
 * database (plan section 4's 2026-10-01 revision: the worker holds no state of
 * its own; the database is the source of truth, design principle #2).
 *
 * Lifecycle: PENDING -> CLAIMED (the worker won the atomic update, plan
 * section 50 idempotency — same pattern as reminders.status) -> DONE | FAILED.
 * A PENDING request can also end CANCELLED (an admin scheduled a newer one —
 * at most one is pending per guild) or EXPIRED (join time passed and nobody
 * came into the channel within the grace window).
 */
export const voiceJoinStatusEnum = pgEnum("voice_join_status", ["PENDING", "CLAIMED", "DONE", "CANCELLED", "EXPIRED", "FAILED"]);

export const voiceJoinRequests = pgTable(
  "voice_join_requests",
  {
    id: serial("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    channelId: text("channel_id").notNull(),
    /** Absolute UTC instant; the admin's date/time was resolved in the team timezone when the command ran. */
    joinAt: timestamp("join_at", { withTimezone: true }).notNull(),
    status: voiceJoinStatusEnum("status").notNull().default("PENDING"),
    /** Discord user id of the admin who ran the command. */
    requestedBy: text("requested_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    handledAt: timestamp("handled_at", { withTimezone: true }),
  },
  (t) => [
    // V1 is one guild and one Mari: only one request may be waiting at a time.
    uniqueIndex("voice_join_requests_one_pending_idx").on(t.guildId).where(sql`status = 'PENDING'`),
    index("voice_join_requests_status_join_at_idx").on(t.status, t.joinAt),
  ],
);

export type VoiceJoinRequestRow = typeof voiceJoinRequests.$inferSelect;
