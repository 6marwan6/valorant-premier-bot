import { pgTable, pgEnum, serial, text, real, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
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
    /**
     * Voice choices the admin made in /mari-join (2026-10-01). NULL = not specified: she keeps the
     * VOICE_* env default (or, if she is already in the channel, whatever she is using now).
     * direction "" = explicitly no direction.
     */
    voice: text("voice"),
    direction: text("direction"),
    pitch: real("pitch"),
    /** "auto" | "name" | "always" (2026-10-01 (b)): whether she needs to hear her name. NULL = keep what she has. */
    listen: text("listen"),
    /** "en" | "ar-EG" (2026-10-02): the language of the session. NULL = keep what she has (English on a fresh join). */
    language: text("language"),
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
