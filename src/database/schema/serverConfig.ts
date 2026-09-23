import { pgTable, text, integer, jsonb, timestamp } from "drizzle-orm/pg-core";

/**
 * Per-guild configuration — plan section 53 "Configuration":
 *
 *   guild_id
 *   timezone
 *   match_channel_id
 *   admin_role_id
 *   reminder_schedule
 *   default_roast_intensity
 *   default_memory_policy
 *
 * "Keep configuration in the database where appropriate rather than
 * hardcoding it." This table is the source of truth once /setup has been
 * run (plan section 41). V1 is single-server (plan section 54), so
 * guild_id is the primary key — no multi-tenant abstractions.
 *
 * reminder_schedule stores minutes-before-match offsets, defaulting to the
 * plan's section 13 example: 3h / 1h / 15m before.
 */
export const serverConfig = pgTable("server_config", {
  guildId: text("guild_id").primaryKey(),

  // Plan section 3: "Use Europe/frankfurt as the team's default timezone."
  // "Europe/Frankfurt" is not a valid IANA zone — see README for the flagged
  // discrepancy (now resolved). Defaults to Africa/Cairo, per plan section
  // 11's own worked example and the team being Cairo-based; override via
  // /setup for a different deployment.
  timezone: text("timezone").notNull().default("Africa/Cairo"),

  matchChannelId: text("match_channel_id"),
  adminRoleId: text("admin_role_id"),

  // Minutes before kickoff, e.g. [180, 60, 15] (plan section 13).
  reminderScheduleMinutes: jsonb("reminder_schedule_minutes")
    .$type<number[]>()
    .notNull()
    .default([180, 60, 15]),

  // 0-100 per plan section 9.
  defaultRoastIntensity: integer("default_roast_intensity").notNull().default(50),

  // Exact policy values are intentionally open — plan section 28 says the
  // retention policy "should be chosen during implementation." Kept as a
  // free-form label for now so Phase 8 can define the real enum without a
  // migration that changes column type.
  defaultMemoryPolicy: text("default_memory_policy").notNull().default("CONSERVATIVE"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ServerConfigRow = typeof serverConfig.$inferSelect;
export type NewServerConfigRow = typeof serverConfig.$inferInsert;
