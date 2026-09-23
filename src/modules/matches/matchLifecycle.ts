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

export function describeWhyLocked(status: MatchStatus): string {
  return status === "COMPLETED"
    ? "That match has already been completed."
    : "That match has already been cancelled.";
}
