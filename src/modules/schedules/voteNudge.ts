import type { PlayerRow } from "../../database/schema/players.js";
import type { SchedulePollRow, ScheduleSlotRow, ScheduleVoteRow, ScheduleDeclineRow } from "../../database/schema/schedules.js";
import { MIN_PLAYERS_TO_QUEUE, effectiveAt, formatSlotDay, formatSlotTime } from "./scheduleLogic.js";

/**
 * How long a schedule has been up before Mari DMs the players who haven't
 * answered it (2026-10-14, owner's request: "after one day"). A constant, not a
 * setting — design principle #11; make it a `server_config` column if the team
 * ever wants a different delay.
 */
export const VOTE_NUDGE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Who should get the "you haven't voted" DM for a poll right now. Pure — the job
 * reads the database and calls this, so every rule is testable without one.
 *
 * - the poll must be OPEN, have a posted message to link to, and be at least a
 *   day old;
 * - at least one slot must still be ahead of us (a week that is over has nothing
 *   left to vote on);
 * - only active Premier PLAYERS — server members take no part in Premier
 *   (Plan_Amendment_Weekly_Schedule Part 2) and are never nudged;
 * - anyone who voted for a slot *or* said "can't play any day" has answered.
 */
export function selectVoteNudgeRecipients(params: {
  poll: SchedulePollRow;
  slots: ScheduleSlotRow[];
  votes: ScheduleVoteRow[];
  declines: ScheduleDeclineRow[];
  roster: PlayerRow[];
  now: Date;
}): { recipients: PlayerRow[]; upcomingSlots: ScheduleSlotRow[] } {
  const { poll, slots, votes, declines, roster, now } = params;
  const none = { recipients: [], upcomingSlots: [] };
  if (poll.status !== "OPEN" || !poll.messageId) return none;
  if (now.getTime() - poll.createdAt.getTime() < VOTE_NUDGE_AFTER_MS) return none;

  const upcomingSlots = slots.filter((s) => effectiveAt(s).getTime() > now.getTime());
  if (upcomingSlots.length === 0) return none;

  const answered = new Set<string>([...votes.map((v) => v.discordUserId), ...declines.map((d) => d.discordUserId)]);
  const recipients = roster.filter((p) => p.active && p.kind === "PLAYER" && !answered.has(p.discordUserId));
  return { recipients, upcomingSlots };
}

const OPENERS = [
  "it's Mari 👋 the schedule has been up for a day and I still don't see a vote from you.",
  "Mari here. I've been staring at the schedule for 24 hours and your name is nowhere on it 👀",
  "quick one from Mari — the schedule's been out since yesterday and you haven't answered it yet.",
];

/** Stable pick so a given (poll, player) always reads the same, and tests don't flake. */
function pickOpener(pollId: number, discordUserId: string): string {
  let h = pollId;
  for (const ch of discordUserId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return OPENERS[h % OPENERS.length]!;
}

/**
 * The DM text. Deterministic — every fact (slots, map, link) comes from the
 * database and no model is involved (plan sections 14 and 66 #9), so it can't
 * invent a slot, can't hit a protected topic and still goes out when the AI is
 * off (section 48). Mari's voice comes from the fixed opener lines above.
 * Plain text; the DM sender sets `allowed_mentions: { parse: [] }` regardless.
 */
export function buildVoteNudgeDm(params: {
  player: Pick<PlayerRow, "displayName" | "discordUserId">;
  poll: Pick<SchedulePollRow, "id" | "guildId" | "channelId" | "messageId" | "timezone">;
  upcomingSlots: ScheduleSlotRow[];
}): string {
  const { player, poll, upcomingSlots } = params;
  const lines = upcomingSlots.map((s) => {
    const at = effectiveAt(s);
    return `• ${formatSlotDay(s.scheduledAt, poll.timezone)} · ${formatSlotTime(at, poll.timezone)}${s.map ? ` · 🗺️ ${s.map}` : ""}`;
  });
  const link = `https://discord.com/channels/${poll.guildId}/${poll.channelId}/${poll.messageId}`;
  return [
    `Hey ${player.displayName}, ${pickOpener(poll.id, player.discordUserId)}`,
    "",
    ...lines,
    "",
    `We need ${MIN_PLAYERS_TO_QUEUE} to queue. Tap every slot you can play — or **can't play any day** if this week's a no — here:`,
    link,
  ].join("\n");
}
