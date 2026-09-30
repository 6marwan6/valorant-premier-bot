import type { AttendanceRepository } from "../../database/repositories/attendanceRepository.js";
import type { MatchEventRepository } from "../../database/repositories/matchEventRepository.js";
import type { MatchRepository } from "../../database/repositories/matchRepository.js";
import type { MemoryRepository } from "../../database/repositories/memoryRepository.js";
import type { PlayerRepository } from "../../database/repositories/playerRepository.js";
import type { AttendanceRow } from "../../database/schema/attendance.js";
import type { MatchRow } from "../../database/schema/matches.js";
import type { MatchEventRow } from "../../database/schema/matchEvents.js";
import type { MemoryRow } from "../../database/schema/memories.js";
import type { PlayerRow } from "../../database/schema/players.js";
import { forbiddenTopicsFor } from "./aiContextBuilder.js";
import { isEligible, scoreMemory } from "../memories/memoryRetrieval.js";

/**
 * Everything a *server* chat (`/mari`, `@Mari` — plan section 63, revised
 * 2026-09-29) may know beyond the chatter's own memories: the roster, the
 * next match and who's playing, the last result and its events, and a few
 * PUBLIC/TEAM memories about teammates.
 *
 * Plan design principle #9 — "structured facts must never depend on LLM
 * output": all of this is read from the database and handed to the model
 * as data; the model never supplies or alters any of it. It is also
 * exactly the kind of context plan section 38 already allows for team
 * messages ("facts such as the roster and agents come from the database").
 *
 * Privacy (sections 10/44), because this is a public channel:
 * - only TEAM/PUBLIC memories of *other* players are ever loaded
 *   (`listSharedForPlayers` never returns PRIVATE or PROTECTED), and each is
 *   re-checked with `isEligible` against the union of EVERY roster
 *   member's protected topics — a topic anyone protected is off the table
 *   in a room everyone can read;
 * - a teammate who turned "Memory usage" off contributes no memories;
 * - a teammate who turned "Valorant references" off contributes no
 *   role/agents to the roster block.
 */

export interface RosterEntry {
  displayName: string;
  role: string | null;
  agents: string[];
  preferredAgent: string | null;
}

export interface NextMatchFacts {
  id: number;
  scheduledAt: Date;
  timezone: string;
  status: MatchRow["status"];
  playing: string[];
  cannotPlay: string[];
  wantsButCannot: string[];
  noResponse: string[];
}

export interface LastMatchFacts {
  id: number;
  scheduledAt: Date;
  timezone: string;
  result: "WIN" | "LOSS" | null;
  events: Array<{ type: MatchEventRow["type"]; description: string; playerName: string | null }>;
}

export interface SharedMemoryFact {
  ownerName: string;
  type: MemoryRow["type"];
  content: string;
}

export interface ServerChatFacts {
  roster: RosterEntry[];
  nextMatch: NextMatchFacts | null;
  lastMatch: LastMatchFacts | null;
  sharedMemories: SharedMemoryFact[];
  /** Union of every active player's protected topics — also validates the model's output for a public reply. */
  rosterForbiddenTopics: string[];
}

/** A public reply is compact (plan section 57): a handful of teammate facts at most. */
export const MAX_SHARED_MEMORIES = 6;
const MAX_LAST_MATCH_EVENTS = 6;

export class TeamFactsService {
  constructor(
    private readonly players: PlayerRepository,
    private readonly matches: MatchRepository,
    private readonly attendance: AttendanceRepository,
    private readonly matchEvents: MatchEventRepository,
    private readonly memories: MemoryRepository,
  ) {}

  async load(params: { guildId: string; chatterPlayerId: number; queryText?: string; now?: Date }): Promise<ServerChatFacts> {
    const now = params.now ?? new Date();
    const roster = await this.players.listActiveByGuild(params.guildId);

    const rosterForbiddenTopics = unionForbiddenTopics(roster);

    const [upcoming, completed] = await Promise.all([
      this.matches.listByGuildAndStatuses(params.guildId, ["SCHEDULED", "CONFIRMATION_OPEN"]),
      this.matches.listByGuildAndStatuses(params.guildId, ["COMPLETED"]),
    ]);

    const nextMatchRow = upcoming.find((m) => m.scheduledAt.getTime() >= now.getTime() - 60 * 60 * 1000) ?? upcoming[0];
    const lastMatchRow = completed.length > 0 ? completed[completed.length - 1] : undefined;

    const [nextMatch, lastMatch, sharedMemories] = await Promise.all([
      nextMatchRow ? this.loadNextMatch(nextMatchRow, roster) : Promise.resolve(null),
      lastMatchRow ? this.loadLastMatch(lastMatchRow, roster) : Promise.resolve(null),
      this.loadSharedMemories(roster, params.chatterPlayerId, rosterForbiddenTopics, params.queryText, now),
    ]);

    return {
      roster: roster.map(toRosterEntry),
      nextMatch,
      lastMatch,
      sharedMemories,
      rosterForbiddenTopics,
    };
  }

  private async loadNextMatch(match: MatchRow, roster: PlayerRow[]): Promise<NextMatchFacts> {
    const rows = await this.attendance.listByMatch(match.id);
    const byUser = new Map<string, AttendanceRow>(rows.map((r) => [r.discordUserId, r]));
    const facts: NextMatchFacts = {
      id: match.id,
      scheduledAt: match.scheduledAt,
      timezone: match.timezone,
      status: match.status,
      playing: [],
      cannotPlay: [],
      wantsButCannot: [],
      noResponse: [],
    };
    for (const player of roster) {
      const row = byUser.get(player.discordUserId);
      if (!row) facts.noResponse.push(player.displayName);
      else if (row.status === "PLAYING") facts.playing.push(player.displayName);
      else if (row.status === "CANNOT_PLAY") facts.cannotPlay.push(player.displayName);
      else if (row.status === "WANTS_TO_BUT_CANNOT") facts.wantsButCannot.push(player.displayName);
      else facts.noResponse.push(player.displayName);
    }
    return facts;
  }

  private async loadLastMatch(match: MatchRow, roster: PlayerRow[]): Promise<LastMatchFacts> {
    const events = await this.matchEvents.listByMatch(match.id);
    const nameById = new Map(roster.map((p) => [p.id, p.displayName]));
    return {
      id: match.id,
      scheduledAt: match.scheduledAt,
      timezone: match.timezone,
      result: match.result ?? null,
      events: events.slice(0, MAX_LAST_MATCH_EVENTS).map((e) => ({
        type: e.type,
        description: e.description,
        playerName: e.playerId !== null ? (nameById.get(e.playerId) ?? null) : null,
      })),
    };
  }

  private async loadSharedMemories(
    roster: PlayerRow[],
    chatterPlayerId: number,
    forbiddenTopics: string[],
    queryText: string | undefined,
    now: Date,
  ): Promise<SharedMemoryFact[]> {
    // Teammates only: the chatter's own memories arrive through the normal
    // per-player retrieval, which already applies this same audience rule.
    const others = roster.filter((p) => p.id !== chatterPlayerId && p.memoryUsageEnabled);
    if (others.length === 0) return [];
    const nameById = new Map(others.map((p) => [p.id, p.displayName]));
    const shared = await this.memories.listSharedForPlayers(others.map((p) => p.id));
    return shared
      .filter((m) => isEligible(m, "PUBLIC_CHANNEL", forbiddenTopics))
      .map((m) => ({ memory: m, score: scoreMemory(m, "SERVER_CHAT", now, queryText) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_SHARED_MEMORIES)
      .map(({ memory }) => ({ ownerName: nameById.get(memory.playerId) ?? "a teammate", type: memory.type, content: memory.content }));
  }
}

function toRosterEntry(player: PlayerRow): RosterEntry {
  const show = player.valorantReferencesEnabled;
  return {
    displayName: player.displayName,
    role: show ? player.role : null,
    agents: show ? player.agents : [],
    preferredAgent: show ? player.preferredAgent : null,
  };
}

function unionForbiddenTopics(roster: PlayerRow[]): string[] {
  const seen = new Set<string>();
  for (const player of roster) for (const topic of forbiddenTopicsFor(player)) seen.add(topic);
  return [...seen];
}
