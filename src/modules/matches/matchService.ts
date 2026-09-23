import type { ServerConfigRepository } from "../../database/repositories/serverConfigRepository.js";
import type { MatchRepository } from "../../database/repositories/matchRepository.js";
import type { MatchRow } from "../../database/schema/matches.js";
import { parseMatchDateTime } from "./dateTime.js";
import { canCancelMatch, canEditMatch, describeWhyLocked } from "./matchLifecycle.js";

export type MatchResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Orchestrates match creation/editing/cancellation against the repository
 * layer. Exists so discord/commands/*.ts stay thin option-parsing +
 * reply-formatting shims — plan section 2: "Use a structured backend
 * architecture rather than putting all logic inside Discord command
 * handlers."
 */
export class MatchService {
  constructor(
    private readonly matches: MatchRepository,
    private readonly serverConfig: ServerConfigRepository,
  ) {}

  async createMatch(params: {
    guildId: string;
    opponent: string;
    dateStr: string;
    timeStr: string;
  }): Promise<MatchResult<MatchRow>> {
    const opponent = params.opponent.trim();
    if (!opponent) {
      return { ok: false, error: "Opponent name can't be empty." };
    }

    const config = await this.serverConfig.getByGuildId(params.guildId);
    if (!config) {
      // Plan section 11: "The team's configured timezone should be used
      // automatically" — there's nothing automatic to use until /setup
      // has run once (plan section 53).
      return { ok: false, error: "Run `/setup` first so I know this server's timezone and match channel." };
    }

    const parsed = parseMatchDateTime(params.dateStr, params.timeStr, config.timezone);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error };
    }

    // Plan section 11: "Match is not accidentally duplicated." Checked
    // here for a specific, friendly message; the DB's partial unique
    // index (schema/matches.ts) is the actual enforcement backstop in
    // case of a race between two concurrent /create-match calls.
    const duplicate = await this.matches.findActiveDuplicate(params.guildId, opponent, parsed.scheduledAt);
    if (duplicate) {
      return {
        ok: false,
        error: `Match #${duplicate.id} against ${duplicate.opponent} is already scheduled at that exact time.`,
      };
    }

    const match = await this.matches.create({
      guildId: params.guildId,
      opponent,
      scheduledAt: parsed.scheduledAt,
      timezone: config.timezone,
    });
    return { ok: true, value: match };
  }

  async editMatch(params: {
    guildId: string;
    matchId: number;
    opponent?: string;
    dateStr?: string;
    timeStr?: string;
  }): Promise<MatchResult<MatchRow>> {
    const existing = await this.matches.getById(params.matchId);
    if (!existing || existing.guildId !== params.guildId) {
      return { ok: false, error: `No match #${params.matchId} found in this server.` };
    }
    if (!canEditMatch(existing.status)) {
      return { ok: false, error: describeWhyLocked(existing.status) };
    }
    if (params.opponent === undefined && params.dateStr === undefined && params.timeStr === undefined) {
      return { ok: false, error: "Nothing to change — provide at least one of opponent, date, or time." };
    }
    // Date and time must be edited together: existing.timezone is the
    // frozen snapshot from creation, so editing only one half would force
    // us to guess which timezone to interpret the other half in.
    if ((params.dateStr === undefined) !== (params.timeStr === undefined)) {
      return { ok: false, error: "Provide both date and time together when changing either." };
    }

    let scheduledAt = existing.scheduledAt;
    if (params.dateStr && params.timeStr) {
      const parsed = parseMatchDateTime(params.dateStr, params.timeStr, existing.timezone);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      scheduledAt = parsed.scheduledAt;
    }

    const opponent = params.opponent?.trim() ?? existing.opponent;
    if (params.opponent !== undefined && !opponent) {
      return { ok: false, error: "Opponent name can't be empty." };
    }

    if (opponent !== existing.opponent || scheduledAt.getTime() !== existing.scheduledAt.getTime()) {
      const duplicate = await this.matches.findActiveDuplicate(params.guildId, opponent, scheduledAt);
      if (duplicate && duplicate.id !== existing.id) {
        return {
          ok: false,
          error: `Match #${duplicate.id} against ${duplicate.opponent} is already scheduled at that exact time.`,
        };
      }
    }

    const updated = await this.matches.update(existing.id, { opponent, scheduledAt });
    if (!updated) return { ok: false, error: "Failed to update the match. Please try again." };
    return { ok: true, value: updated };
  }

  async cancelMatch(params: { guildId: string; matchId: number }): Promise<MatchResult<MatchRow>> {
    const existing = await this.matches.getById(params.matchId);
    if (!existing || existing.guildId !== params.guildId) {
      return { ok: false, error: `No match #${params.matchId} found in this server.` };
    }
    if (!canCancelMatch(existing.status)) {
      return { ok: false, error: describeWhyLocked(existing.status) };
    }
    const updated = await this.matches.update(existing.id, { status: "CANCELLED" });
    if (!updated) return { ok: false, error: "Failed to cancel the match. Please try again." };
    return { ok: true, value: updated };
  }

  async listMatches(guildId: string): Promise<MatchRow[]> {
    return this.matches.listByGuild(guildId);
  }
}
