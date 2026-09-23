import type { PlayerRow } from "../../../src/database/schema/players.js";
import type { MatchRow } from "../../../src/database/schema/matches.js";

export function makePlayer(overrides: Partial<PlayerRow> = {}): PlayerRow {
  return {
    id: 1,
    guildId: "guild-1",
    discordUserId: "user-1",
    displayName: "Ahmed",
    role: "DUELIST",
    agents: ["Jett", "Raze"],
    preferredAgent: "Jett",
    roastIntensity: 80,
    personalReferencesEnabled: true,
    runningJokesEnabled: true,
    valorantReferencesEnabled: true,
    matchHistoryReferencesEnabled: true,
    memoryUsageEnabled: true,
    aiFollowUpsEnabled: true,
    protectedTopics: ["Family", "Health"],
    active: true,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    ...overrides,
  };
}

export function makeMatch(overrides: Partial<MatchRow> = {}): MatchRow {
  return {
    id: 42,
    guildId: "guild-1",
    opponent: "Team XYZ",
    scheduledAt: new Date("2026-09-18T16:00:00Z"),
    timezone: "Africa/Cairo",
    status: "CONFIRMATION_OPEN",
    announcementChannelId: "chan-1",
    announcementMessageId: "msg-1",
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    ...overrides,
  };
}
