import { asc, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { matchEvents, type MatchEventRow, type NewMatchEventRow } from "../schema/matchEvents.js";

export type NewMatchEventInput = Pick<NewMatchEventRow, "matchId" | "playerId" | "type" | "description">;

/**
 * Repository for `match_events` — plan section 40. Thin, like every other
 * repository in this codebase: /complete-match (Phase 10) is the only
 * writer, and matchService/postMatchService owns the decision of *what*
 * gets written (extraction, player-name resolution) — this layer just
 * persists it.
 */
export class MatchEventRepository {
  constructor(private readonly db: Database) {}

  /**
   * Bulk insert for one /complete-match run — a single admin `notes` string
   * can extract into several events, and they all belong to the same
   * match completion, so they're written together rather than one call
   * per event.
   */
  async createMany(inputs: NewMatchEventInput[]): Promise<MatchEventRow[]> {
    if (inputs.length === 0) return [];
    return this.db.insert(matchEvents).values(inputs).returning();
  }

  /** Plan section 40's own stated purpose: "match-specific callbacks" — read back for one match at a time. */
  async listByMatch(matchId: number): Promise<MatchEventRow[]> {
    return this.db.select().from(matchEvents).where(eq(matchEvents.matchId, matchId)).orderBy(asc(matchEvents.createdAt));
  }
}
