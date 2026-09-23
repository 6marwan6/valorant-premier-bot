import { and, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { attendance, type AttendanceRow } from "../schema/attendance.js";

export interface UpsertAttendanceInput {
  guildId: string;
  matchId: number;
  discordUserId: string;
  discordDisplayName: string;
  status: AttendanceRow["status"];
}

/**
 * Repository for the `attendance` table — plan section 15. Thin, like its
 * siblings: idempotency and "which button click means what" are enforced
 * here (via the DB's unique index + upsert), but validating whether a
 * response is currently *allowed* (match status, guild ownership) lives in
 * modules/attendance/attendanceService.ts.
 */
export class AttendanceRepository {
  constructor(private readonly db: Database) {}

  /**
   * Plan section 15: "If the player clicks the same button twice, the
   * system should not create duplicate attendance records. If the player
   * changes their answer, update the existing response." A single upsert
   * on the (match_id, discord_user_id) unique index gives us both
   * properties atomically, closing the race a
   * check-then-insert/check-then-update pair would leave open between two
   * near-simultaneous clicks from the same person (e.g. a Discord client
   * retry).
   */
  async upsert(input: UpsertAttendanceInput): Promise<AttendanceRow> {
    const [row] = await this.db
      .insert(attendance)
      .values({
        guildId: input.guildId,
        matchId: input.matchId,
        discordUserId: input.discordUserId,
        discordDisplayName: input.discordDisplayName,
        status: input.status,
        respondedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [attendance.matchId, attendance.discordUserId],
        set: {
          status: input.status,
          discordDisplayName: input.discordDisplayName,
          respondedAt: new Date(),
          updatedAt: new Date(),
        },
      })
      .returning();
    if (!row) throw new Error("Failed to upsert attendance");
    return row;
  }

  /** Every response recorded for a match — used to rebuild the roster message (plan section 16). */
  async listByMatch(matchId: number): Promise<AttendanceRow[]> {
    return this.db.select().from(attendance).where(eq(attendance.matchId, matchId));
  }

  async getForPlayer(matchId: number, discordUserId: string): Promise<AttendanceRow | undefined> {
    const rows = await this.db
      .select()
      .from(attendance)
      .where(and(eq(attendance.matchId, matchId), eq(attendance.discordUserId, discordUserId)))
      .limit(1);
    return rows[0];
  }
}
