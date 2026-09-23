import type { ServerConfigRepository } from "../../database/repositories/serverConfigRepository.js";
import type { MatchRepository } from "../../database/repositories/matchRepository.js";
import type { AttendanceRepository } from "../../database/repositories/attendanceRepository.js";
import type { MatchRow } from "../../database/schema/matches.js";
import type { AttendanceRow } from "../../database/schema/attendance.js";
import type { MatchResult } from "../matches/matchService.js";

export interface MatchWithAttendance {
  match: MatchRow;
  attendanceRows: AttendanceRow[];
}

/**
 * Orchestrates the public-match-message + attendance flow (plan sections
 * 14, 15, 16). Discord API calls themselves (sending/editing the actual
 * message) stay out of this class and live in the command/button handlers
 * — this only decides *whether* an action is allowed and updates the
 * database, the same split MatchService uses. Kept framework-agnostic on
 * purpose so it's testable without a Discord client.
 */
export class AttendanceService {
  constructor(
    private readonly matches: MatchRepository,
    private readonly attendance: AttendanceRepository,
    private readonly serverConfig: ServerConfigRepository,
  ) {}

  /**
   * Validates a match can be opened for confirmation (plan section 12:
   * only from SCHEDULED) and that the guild has a match channel configured
   * (plan section 53). Does NOT touch the database or Discord — the
   * caller sends the actual message first, then calls
   * recordAnnouncement() once that succeeds, so a Discord-side failure
   * never leaves the match incorrectly marked as posted (plan section 48:
   * "If the LLM/service request fails... do not modify state").
   */
  async prepareAnnouncement(
    guildId: string,
    matchId: number,
  ): Promise<MatchResult<{ match: MatchRow; channelId: string }>> {
    const match = await this.matches.getById(matchId);
    if (!match || match.guildId !== guildId) {
      return { ok: false, error: `No match #${matchId} found in this server.` };
    }
    if (match.status !== "SCHEDULED") {
      return {
        ok: false,
        error:
          match.status === "CONFIRMATION_OPEN"
            ? `Match #${matchId} has already been posted.`
            : `Match #${matchId} can't be posted — it's ${match.status}.`,
      };
    }
    const config = await this.serverConfig.getByGuildId(guildId);
    if (!config?.matchChannelId) {
      return { ok: false, error: "Run `/setup` with a match_channel before posting a match." };
    }
    return { ok: true, value: { match, channelId: config.matchChannelId } };
  }

  /** Commits a successfully-sent announcement: SCHEDULED -> CONFIRMATION_OPEN, stores the message location. */
  async recordAnnouncement(
    matchId: number,
    channelId: string,
    messageId: string,
  ): Promise<MatchRow | undefined> {
    return this.matches.update(matchId, {
      status: "CONFIRMATION_OPEN",
      announcementChannelId: channelId,
      announcementMessageId: messageId,
    });
  }

  /**
   * Plan section 15's button-click flow, steps 2-4 (steps 1/"authenticate"
   * is satisfied by Discord's own signed interaction; step 5/"update the
   * public message" and step 6/"start the AI flow" happen in the caller —
   * this method's job ends at "the database now reflects the click").
   */
  async recordAttendance(params: {
    guildId: string;
    matchId: number;
    discordUserId: string;
    discordDisplayName: string;
    status: AttendanceRow["status"];
  }): Promise<MatchResult<MatchWithAttendance>> {
    const match = await this.matches.getById(params.matchId);
    if (!match || match.guildId !== params.guildId) {
      return { ok: false, error: "This match no longer exists." };
    }
    if (match.status !== "CONFIRMATION_OPEN") {
      return { ok: false, error: "This match isn't accepting responses anymore." };
    }

    await this.attendance.upsert({
      guildId: params.guildId,
      matchId: params.matchId,
      discordUserId: params.discordUserId,
      discordDisplayName: params.discordDisplayName,
      status: params.status,
    });

    const attendanceRows = await this.attendance.listByMatch(params.matchId);
    return { ok: true, value: { match, attendanceRows } };
  }

  /** Read-only fetch used by /edit-match and /cancel-match to refresh an already-posted message. */
  async getMatchWithAttendance(guildId: string, matchId: number): Promise<MatchWithAttendance | undefined> {
    const match = await this.matches.getById(matchId);
    if (!match || match.guildId !== guildId) return undefined;
    const attendanceRows = await this.attendance.listByMatch(matchId);
    return { match, attendanceRows };
  }
}
