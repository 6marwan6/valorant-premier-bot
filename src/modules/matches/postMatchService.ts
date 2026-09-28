import type { Logger } from "../../config/logger.js";
import type { MatchEventRepository } from "../../database/repositories/matchEventRepository.js";
import type { MatchRepository } from "../../database/repositories/matchRepository.js";
import type { PlayerRepository } from "../../database/repositories/playerRepository.js";
import type { ServerConfigRepository } from "../../database/repositories/serverConfigRepository.js";
import type { MatchEventRow } from "../../database/schema/matchEvents.js";
import type { MatchRow } from "../../database/schema/matches.js";
import type { AiService, TeamAiOutcome } from "../ai/aiService.js";
import type { MemoryService } from "../memories/memoryService.js";
import { canCompleteMatch, describeWhyLocked } from "./matchLifecycle.js";
import { matchPlayerByName } from "./matchEvents.js";

export type MatchResultValue = NonNullable<MatchRow["result"]>;

export type CompleteMatchOutcome =
  | {
      ok: true;
      value: {
        match: MatchRow;
        matchEvents: MatchEventRow[];
        recap: TeamAiOutcome;
        /** Already-validated match channel to post the recap to — resolved once here so the command doesn't re-fetch config and risk acting on a stale/absent value. */
        channelId: string;
      };
    }
  | { ok: false; error: string };

/**
 * Orchestrates plan section 39 "Post-Match Mode" end to end: lifecycle
 * check -> mark COMPLETED -> extract match events from the admin's notes
 * (section 40) -> persist them + spin off team memories for the
 * player-tied ones (section 22/44, memoryService.createFromMatchEvent) ->
 * generate the recap. Framework-agnostic like every other *Service here —
 * commands/completeMatch.ts owns the Discord side (replying, posting the
 * recap message, refreshing the roster message).
 *
 * A missing match channel is checked and reported here, up front, before
 * any AI calls run — plan section 48's spirit (fail fast on something
 * that's wrong regardless of whether AI is even configured) plus it saves
 * an LLM round-trip for a command that's going to fail anyway.
 */
export class PostMatchService {
  constructor(
    private readonly matches: MatchRepository,
    private readonly matchEvents: MatchEventRepository,
    private readonly players: PlayerRepository,
    private readonly serverConfig: ServerConfigRepository,
    private readonly ai: AiService,
    private readonly memories: MemoryService,
    private readonly logger: Logger,
  ) {}

  async completeMatch(params: {
    guildId: string;
    matchId: number;
    result: MatchResultValue;
    notes: string | null;
  }): Promise<CompleteMatchOutcome> {
    const existing = await this.matches.getById(params.matchId);
    if (!existing || existing.guildId !== params.guildId) {
      return { ok: false, error: `No match #${params.matchId} found in this server.` };
    }
    if (!canCompleteMatch(existing.status)) {
      return { ok: false, error: describeWhyLocked(existing.status) };
    }

    // Same message/shape as attendanceService.prepareAnnouncement's own
    // check (plan section 53: config is the source of truth for where team
    // messages go) — checked before the update below so a misconfigured
    // guild never ends up with a match marked COMPLETED but no recap
    // possible.
    const config = await this.serverConfig.getByGuildId(params.guildId);
    if (!config?.matchChannelId) {
      return { ok: false, error: "Run `/setup` with a match_channel before completing a match." };
    }

    const updated = await this.matches.update(existing.id, {
      status: "COMPLETED",
      result: params.result,
      notes: params.notes,
      completedAt: new Date(),
    });
    if (!updated) {
      return { ok: false, error: "Failed to complete the match. Please try again." };
    }

    this.logger.info(
      { event: "match.completed", guildId: params.guildId, matchId: updated.id, result: params.result },
      "Match completed",
    );

    const roster = await this.players.listActiveByGuild(params.guildId);
    const matchEvents = await this.recordMatchEvents(updated, params.notes, roster);
    const recap = await this.ai.generateMatchRecap({ match: updated, result: params.result, matchEvents, roster, notes: params.notes });

    return { ok: true, value: { match: updated, matchEvents, recap, channelId: config.matchChannelId } };
  }

  /**
   * Plan section 40: turns the admin's freeform notes into match_events
   * rows, then (section 44/9) a TEAM-visibility memory for each one that
   * names a player whose own memory-usage setting allows it. Returns `[]`
   * with no notes given or nothing extracted — both are the normal,
   * expected "nothing to record" case, not an error (an admin completing a
   * match with a bare WIN/LOSS and no commentary is exactly what plan
   * section 39 calls "optional notes").
   */
  private async recordMatchEvents(match: MatchRow, notes: string | null, roster: Awaited<ReturnType<PlayerRepository["listActiveByGuild"]>>): Promise<MatchEventRow[]> {
    if (!notes) return [];

    const extracted = await this.ai.extractMatchEvents({ notes, roster });
    if (extracted.length === 0) return [];

    const matchEvents = await this.matchEvents.createMany(
      extracted.map((event) => ({
        matchId: match.id,
        playerId: matchPlayerByName(event.playerName, roster)?.id ?? null,
        type: event.type,
        description: event.description,
      })),
    );

    for (const event of matchEvents) {
      if (!event.playerId) continue; // TEAM_EVENT / unresolved name — memories.playerId is NOT NULL, nothing to attach to
      const player = roster.find((p) => p.id === event.playerId);
      if (!player?.memoryUsageEnabled) continue; // plan section 9: respect the player's own memory-usage setting, same as autoSave does

      try {
        await this.memories.createFromMatchEvent({ playerId: player.id, content: event.description, matchEventId: event.id });
      } catch (err) {
        // Plan section 48's spirit: a memory write failing here must never
        // block completing the match or posting the recap — the match
        // event itself is already safely persisted above.
        this.logger.warn(
          {
            event: "matchEvent.memoryFailed",
            matchEventId: event.id,
            playerId: player.id,
            err: err instanceof Error ? err.message : String(err),
          },
          "Failed to save match-event memory",
        );
      }
    }

    return matchEvents;
  }
}
