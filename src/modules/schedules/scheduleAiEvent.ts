import type { AiEvent } from "../ai/aiContextBuilder.js";
import type { ScheduleSlotRow } from "../../database/schema/schedules.js";
import { formatSlotDay, formatSlotTime } from "./scheduleLogic.js";

/**
 * What Mari is told a weekly-schedule vote was (plan section 14: every fact in
 * the prompt comes from the database, the model only supplies the voice).
 *
 * Deliberately sparse. The model is told the one slot a player voted for, or
 * that they can't play any day — never vote counts, who else voted, or who is
 * missing: those are the poll's facts, they change by the minute, and a
 * reaction that quotes them is a reaction that can be wrong. (Same posture as
 * the attendance prompt, which gives only the kickoff time.)
 *
 * Mapping to the plan's modes (sections 18/19): a vote is CELEBRATE, "can't
 * play any day" is ROAST. CONSOLE (section 20) needs a "want to but can't"
 * answer, which the weekly schedule doesn't have.
 */
export function buildVoteEvent(params: { pollId: number; slot: ScheduleSlotRow; timezone: string }): AiEvent {
  const { slot, timezone } = params;
  return {
    seedKey: `sched:${params.pollId}:vote`,
    lines: [
      "Weekly Premier schedule (the team votes on which slots to play; opponent unknown until the match starts)",
      `Player action: voted that they CAN play ${formatSlotDay(slot.scheduledAt, timezone)} at ${formatSlotTime(slot.scheduledAt, timezone)} (${timezone})`,
      "Player response: PLAYING",
    ],
  };
}

export function buildDeclineEvent(params: { pollId: number; slotCount: number }): AiEvent {
  return {
    seedKey: `sched:${params.pollId}:decline`,
    lines: [
      "Weekly Premier schedule (the team votes on which slots to play)",
      `Player action: said they CAN'T play on any of the ${params.slotCount} slot${params.slotCount === 1 ? "" : "s"} offered this week`,
      "Player response: CANNOT_PLAY",
    ],
  };
}
