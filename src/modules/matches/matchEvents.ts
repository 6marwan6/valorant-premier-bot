import type { PlayerRow } from "../../database/schema/players.js";

/**
 * Matches an AI-extracted `player_name` (aiOutput.ts's
 * ExtractedMatchEvent.playerName) back to a roster row by exact,
 * case-insensitive display name.
 *
 * Deliberately exact rather than fuzzy: plan section 47 "Preventing False
 * Memories" and section 35 "Never invent player facts" argue for
 * conservatism here too — a fuzzy/partial match risks attaching one
 * player's clutch to a different, similarly-named teammate. The
 * extraction prompt (teamAiContextBuilder.ts) is told to copy the name
 * exactly from the roster list it's given, so a null return means either
 * the note wasn't about a specific player (a TEAM_EVENT) or named someone
 * not currently on the active roster — both cases where storing the event
 * without a player_id (see schema/matchEvents.ts) is the correct,
 * conservative outcome, not an error.
 */
export function matchPlayerByName(name: string | null, roster: PlayerRow[]): PlayerRow | null {
  if (!name) return null;
  const needle = name.trim().toLowerCase();
  if (!needle) return null;
  return roster.find((player) => player.displayName.trim().toLowerCase() === needle) ?? null;
}
