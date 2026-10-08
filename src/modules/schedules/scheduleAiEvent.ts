import type { AiEvent } from "../ai/aiContextBuilder.js";
import type { ScheduleSlotRow } from "../../database/schema/schedules.js";
import { formatSlotDay, formatSlotTime } from "./scheduleLogic.js";
import { ROLE_SINGULAR, type AgentRole } from "../agents/agentData.js";

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
 * A vote's reaction is sent once the player has *picked an agent* (2026-10-08,
 * owner's request), so a vote event may carry that agent — a database fact, like
 * the slot. The reaction card shows the same agent.
 *
 * Mapping to the plan's modes (sections 18/19): a vote is CELEBRATE, "can't
 * play any day" is ROAST. CONSOLE (section 20) needs a "want to but can't"
 * answer, which the weekly schedule doesn't have.
 */
export function buildVoteEvent(params: { pollId: number; slot: ScheduleSlotRow; timezone: string; agent?: { name: string; role: AgentRole } }): AiEvent {
  const { slot, timezone, agent } = params;
  return {
    seedKey: `sched:${params.pollId}:vote`,
    lines: [
      "Weekly Premier schedule (the team votes on which slots to play; opponent unknown until the match starts)",
      `Player action: voted that they CAN play ${formatSlotDay(slot.scheduledAt, timezone)} at ${formatSlotTime(slot.scheduledAt, timezone)} (${timezone})`,
      // Since 2026-10-08 the reaction waits for the agent pick, so the agent is a database fact the card shows too.
      ...(agent ? [`Agent they locked in for that slot: ${agent.name} (${ROLE_SINGULAR[agent.role]}) — this is the agent they will play; refer to no other`] : []),
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
