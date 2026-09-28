import type { MatchRow } from "../../database/schema/matches.js";

export type MatchStatus = MatchRow["status"];

/**
 * Plan section 12 "Match States": SCHEDULED -> CONFIRMATION_OPEN ->
 * IN_PROGRESS -> COMPLETED, "Cancellation can occur from any state before
 * completion where appropriate."
 *
 * Kept as standalone pure functions (not methods on a class touching the
 * DB) specifically so plan section 60's "match state transitions" unit
 * test target can exercise every state combination without a database.
 */

const TERMINAL_STATUSES: readonly MatchStatus[] = ["COMPLETED", "CANCELLED"];

/** Plan section 11: edits are rejected once a match is "already completed/cancelled". */
export function canEditMatch(status: MatchStatus): boolean {
  return !TERMINAL_STATUSES.includes(status);
}

/** Plan section 12: cancellation is allowed "from any state before completion". */
export function canCancelMatch(status: MatchStatus): boolean {
  return !TERMINAL_STATUSES.includes(status);
}

/**
 * Plan section 39: /complete-match. The plan doesn't spell out which
 * pre-completion states are eligible, and no phase has ever actually moved
 * a match to IN_PROGRESS (there's no command that does — see aiMode.ts's
 * note on the same gap), so in practice this only ever fires from
 * CONFIRMATION_OPEN. Allowing it from any non-terminal state (same rule as
 * canCancelMatch/canEditMatch) rather than hard-coding CONFIRMATION_OPEN
 * covers SCHEDULED too — an admin completing a match they forgot to
 * `/post-match` first shouldn't be blocked by that oversight.
 */
export function canCompleteMatch(status: MatchStatus): boolean {
  return !TERMINAL_STATUSES.includes(status);
}

export function describeWhyLocked(status: MatchStatus): string {
  return status === "COMPLETED"
    ? "That match has already been completed."
    : "That match has already been cancelled.";
}
