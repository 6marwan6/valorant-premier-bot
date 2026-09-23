import { pgTable, pgEnum, serial, text, integer, boolean, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { serverConfig } from "./serverConfig.js";

/**
 * Plan section 8 "Player System" example role: Duelist. Section 62's
 * "Future Personalization" sketch shows the other three (Controller,
 * Initiator, Sentinel appear across sections 8/9/62) — Valorant's four
 * standard role classes. Kept as a fixed enum (rather than free text)
 * because every later phase that reads this column (AI context building,
 * plan section 34's example "Role: Duelist") wants a closed set to key
 * personality/prompt behavior off of, not arbitrary strings. Individual
 * agent names are NOT enumerated here (see `agents` below) — Riot adds
 * agents over time and this app has no business hardcoding a roster that
 * will go stale.
 */
export const playerRoleEnum = pgEnum("player_role", ["DUELIST", "INITIATOR", "CONTROLLER", "SENTINEL"]);

/**
 * A team member's profile — plan section 8 "Player System" and section 9
 * "Player AI Configuration". Two deliberate schema notes:
 *
 * 1. `agents` / `protectedTopics` are `jsonb` string arrays, not
 *    normalized child tables. Plan section 54 / design principle #11:
 *    this is a 6-7 person team, not a system that needs relational
 *    queries *across* agents or topics (e.g. "which players can play
 *    Jett" isn't a planned feature) — a jsonb array is the simple option
 *    that satisfies section 8's example ("Agents: Jett, Raze, Neon") and
 *    section 10's ("Protected topics: Family, Health, ...") without
 *    inventing join tables nothing in the plan asks for.
 * 2. No hard DB deletes for `/remove-player` (see PlayerRepository.deactivate)
 *    — `active` is a soft-delete flag instead, the same pattern `matches`
 *    uses (CANCELLED, not row deletion). Attendance history (Phase 3) and
 *    the future Memory/MatchEvent tables (Phases 8/40) key off
 *    `discord_user_id`, not this table's `id`, but a removed player's
 *    profile itself — role, agents, AI settings, protected topics — stays
 *    around instead of silently vanishing along with whatever referenced
 *    it conceptually. `active = false` is exactly what excludes them from
 *    the roster (plan section 16's "No response" section, section 41's
 *    definition of "the team").
 *
 * AI settings columns mirror plan section 9's fields one-for-one:
 *   Roast intensity -> roastIntensity (0-100, section 9's own range)
 *   Personal references -> personalReferencesEnabled
 *   Running jokes -> runningJokesEnabled
 *   Valorant references -> valorantReferencesEnabled
 *   Match-history references -> matchHistoryReferencesEnabled
 *   Memory usage -> memoryUsageEnabled
 *   AI follow-ups -> aiFollowUpsEnabled
 * All default to plan section 9's implicit "on" example values except
 * roast intensity, which defaults to server_config.default_roast_intensity
 * at the command layer (see addPlayer.ts) rather than a fixed column
 * default, so re-running /setup with a new team default doesn't require
 * touching this table.
 */
export const players = pgTable(
  "players",
  {
    id: serial("id").primaryKey(),

    guildId: text("guild_id")
      .notNull()
      .references(() => serverConfig.guildId, { onDelete: "cascade" }),

    discordUserId: text("discord_user_id").notNull(),
    // Snapshot at /add-player time, refreshed on /edit-player — same
    // "snapshot, not a live Discord lookup" pattern attendance.ts uses
    // for discordDisplayName, for the same reason: avoids a Discord API
    // round-trip every time this row is read.
    displayName: text("display_name").notNull(),

    role: playerRoleEnum("role").notNull(),
    agents: jsonb("agents").$type<string[]>().notNull().default([]),
    preferredAgent: text("preferred_agent"),

    roastIntensity: integer("roast_intensity").notNull().default(50),
    personalReferencesEnabled: boolean("personal_references_enabled").notNull().default(true),
    runningJokesEnabled: boolean("running_jokes_enabled").notNull().default(true),
    valorantReferencesEnabled: boolean("valorant_references_enabled").notNull().default(true),
    matchHistoryReferencesEnabled: boolean("match_history_references_enabled").notNull().default(true),
    memoryUsageEnabled: boolean("memory_usage_enabled").notNull().default(true),
    aiFollowUpsEnabled: boolean("ai_follow_ups_enabled").notNull().default(true),

    // Plan section 10 "Protected Topics" — subjects the AI must never
    // joke about. Filtered at context-build time (Phase 8/9), not here;
    // this column is just the source list.
    protectedTopics: jsonb("protected_topics").$type<string[]>().notNull().default([]),

    // Soft-delete flag for /remove-player — see class doc note 2 above.
    active: boolean("active").notNull().default(true),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One profile per Discord user per guild. Deliberately NOT scoped to
    // `active` (e.g. a partial unique index like matches' duplicate
    // guard) — a removed player keeps their row, so re-adding the same
    // person is an update-and-reactivate (see
    // PlayerRepository.upsertByDiscordUserId), never a second row.
    uniqueIndex("players_guild_discord_user_idx").on(table.guildId, table.discordUserId),
    // The roster/attendance-reconciliation query (plan section 16's real
    // "No response" section) always wants "every active player in this
    // guild."
    index("players_guild_active_idx").on(table.guildId, table.active),
  ],
);

export type PlayerRow = typeof players.$inferSelect;
export type NewPlayerRow = typeof players.$inferInsert;
