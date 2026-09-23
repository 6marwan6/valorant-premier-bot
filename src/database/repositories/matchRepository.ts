import { and, asc, eq, inArray, ne } from "drizzle-orm";
import type { Database } from "../client.js";
import { matches, type MatchRow, type NewMatchRow } from "../schema/matches.js";

export type CreateMatchInput = Pick<NewMatchRow, "guildId" | "opponent" | "scheduledAt" | "timezone">;

/**
 * Repository for the `matches` table — plan section 11/12. Mirrors
 * ServerConfigRepository's shape: thin, no business logic (date parsing,
 * duplicate-message wording, permission checks all live in
 * modules/matches/matchService.ts or the command handlers), just typed
 * reads/writes.
 */
export class MatchRepository {
  constructor(private readonly db: Database) {}

  async getById(id: number): Promise<MatchRow | undefined> {
    const rows = await this.db.select().from(matches).where(eq(matches.id, id)).limit(1);
    return rows[0];
  }

  /**
   * Plan section 11: "Match is not accidentally duplicated." Finds an
   * existing, non-cancelled match for the same guild/opponent/instant —
   * the same rule the DB's partial unique index enforces (see
   * schema/matches.ts), checked here first so the command handler can
   * return a clear, specific message instead of a raw constraint-violation
   * error.
   */
  async findActiveDuplicate(
    guildId: string,
    opponent: string,
    scheduledAt: Date,
  ): Promise<MatchRow | undefined> {
    const rows = await this.db
      .select()
      .from(matches)
      .where(
        and(
          eq(matches.guildId, guildId),
          eq(matches.opponent, opponent),
          eq(matches.scheduledAt, scheduledAt),
          ne(matches.status, "CANCELLED"),
        ),
      )
      .limit(1);
    return rows[0];
  }

  async create(input: CreateMatchInput): Promise<MatchRow> {
    const [inserted] = await this.db.insert(matches).values(input).returning();
    if (!inserted) throw new Error("Failed to insert match");
    return inserted;
  }

  /**
   * Partial update — only fields explicitly passed are changed. Does not
   * itself enforce the "not already COMPLETED/CANCELLED" rule (plan
   * section 11) or re-check duplicates; that belongs in
   * modules/matches/matchService.ts so it can be unit tested without a
   * database and produce a specific user-facing message.
   */
  async update(
    id: number,
    values: Partial<
      Pick<
        MatchRow,
        "opponent" | "scheduledAt" | "timezone" | "status" | "announcementChannelId" | "announcementMessageId"
      >
    >,
  ): Promise<MatchRow | undefined> {
    const [updated] = await this.db
      .update(matches)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(matches.id, id))
      .returning();
    return updated;
  }

  /** Plan section 41 "/list-matches". Soonest-first within the guild. */
  async listByGuild(guildId: string): Promise<MatchRow[]> {
    return this.db
      .select()
      .from(matches)
      .where(eq(matches.guildId, guildId))
      .orderBy(asc(matches.scheduledAt));
  }

  /**
   * Plan section 13/59 (Phase 4): the reminders cron job's "which matches
   * still need reminder reconciliation" query — only SCHEDULED and
   * CONFIRMATION_OPEN matches can still have a future reminder fire.
   */
  async listByGuildAndStatuses(guildId: string, statuses: MatchRow["status"][]): Promise<MatchRow[]> {
    return this.db
      .select()
      .from(matches)
      .where(and(eq(matches.guildId, guildId), inArray(matches.status, statuses)))
      .orderBy(asc(matches.scheduledAt));
  }
}
