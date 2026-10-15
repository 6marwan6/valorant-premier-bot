import type { PlayerRow } from "../../database/schema/players.js";
import type { SchedulePollRow, ScheduleSlotRow, ScheduleVoteRow, ScheduleDeclineRow, VoteNudgeKind } from "../../database/schema/schedules.js";
import { MIN_PLAYERS_TO_QUEUE, effectiveAt, formatSlotDay, formatSlotTime } from "./scheduleLogic.js";

/**
 * How long a schedule has been up before Mari DMs the players who haven't
 * answered it (2026-10-14, owner's request: "after one day"). A constant, not a
 * setting — design principle #11; make it a `server_config` column if the team
 * ever wants a different delay.
 */
export const VOTE_NUDGE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * How long before the first slot still ahead the *final* DM goes out to anyone
 * who still hasn't answered (2026-10-15, owner's request: "8 hours before the
 * match"). Same reasoning as above: a constant.
 */
export const VOTE_NUDGE_FINAL_BEFORE_MS = 8 * 60 * 60 * 1000;

export interface VoteNudgeSelection {
  recipients: PlayerRow[];
  upcomingSlots: ScheduleSlotRow[];
}

/**
 * Who should get a given "you haven't voted" DM for a poll right now. Pure — the
 * job reads the database and calls this, so every rule is testable without one.
 *
 * Common to both kinds:
 * - the poll must be OPEN and have a posted message to link to;
 * - at least one slot must still be ahead of us (a week that is over has
 *   nothing left to vote on);
 * - only active Premier PLAYERS — server members take no part in Premier
 *   (Plan_Amendment_Weekly_Schedule Part 2) and are never nudged;
 * - anyone who voted for a slot *or* said "can't play any day" has answered.
 *
 * FIRST — the schedule has been up for a day, and the final window (below) has
 * not opened yet. Once it has, FINAL is the only DM a late reader gets, so
 * nobody receives two reminders back to back.
 *
 * FINAL — we are within 8 hours of the first slot still ahead, and the
 * schedule was posted *before* that window opened (a schedule posted inside it
 * is itself the reminder).
 */
export function selectVoteNudgeRecipients(params: {
  kind: VoteNudgeKind;
  poll: SchedulePollRow;
  slots: ScheduleSlotRow[];
  votes: ScheduleVoteRow[];
  declines: ScheduleDeclineRow[];
  roster: PlayerRow[];
  now: Date;
}): VoteNudgeSelection {
  const { kind, poll, slots, votes, declines, roster, now } = params;
  const none: VoteNudgeSelection = { recipients: [], upcomingSlots: [] };
  if (poll.status !== "OPEN" || !poll.messageId) return none;

  const upcomingSlots = slots.filter((s) => effectiveAt(s).getTime() > now.getTime());
  if (upcomingSlots.length === 0) return none;

  const firstAt = Math.min(...upcomingSlots.map((s) => effectiveAt(s).getTime()));
  const finalWindowOpensAt = firstAt - VOTE_NUDGE_FINAL_BEFORE_MS;
  const inFinalWindow = now.getTime() >= finalWindowOpensAt;

  if (kind === "FIRST") {
    if (now.getTime() - poll.createdAt.getTime() < VOTE_NUDGE_AFTER_MS) return none;
    if (inFinalWindow) return none;
  } else {
    if (!inFinalWindow) return none;
    if (poll.createdAt.getTime() >= finalWindowOpensAt) return none;
  }

  const answered = new Set<string>([...votes.map((v) => v.discordUserId), ...declines.map((d) => d.discordUserId)]);
  const recipients = roster.filter((p) => p.active && p.kind === "PLAYER" && !answered.has(p.discordUserId));
  return { recipients, upcomingSlots };
}

const FIRST_OPENERS = [
  "it's Mari 👋 the schedule has been up for a day and I still don't see a vote from you.",
  "Mari here. I've been staring at the schedule for 24 hours and your name is nowhere on it 👀",
  "quick one from Mari — the schedule's been out since yesterday and you haven't answered it yet.",
];

const FINAL_OPENERS = [
  "Mari again 👋 {when} and I still don't have an answer from you.",
  "last call from Mari — {when} and your name still isn't on the schedule 👀",
  "Mari here, one more time: {when} and I'm still waiting on you.",
];

/** Stable pick so a given (poll, player) always reads the same, and tests don't flake. */
function pick(list: string[], pollId: number, discordUserId: string): string {
  let h = pollId;
  for (const ch of discordUserId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return list[h % list.length]!;
}

/** "the first slot is about 8 hours away" — computed from the clock and the slot, never guessed. */
function hoursAway(ms: number): string {
  const hours = Math.max(1, Math.round(ms / (60 * 60 * 1000)));
  return `the first slot is about ${hours} hour${hours === 1 ? "" : "s"} away`;
}

/**
 * The DM text. Deterministic — every fact (slots, map, link, hours to go) comes
 * from the database and the clock and no model is involved (plan sections 14 and
 * 66 #9), so it can't invent a slot, can't hit a protected topic and still goes
 * out when the AI is off (section 48). Mari's voice comes from the fixed opener
 * lines above. Plain text; no buttons.
 */
export function buildVoteNudgeDm(params: {
  kind?: VoteNudgeKind;
  now?: Date;
  player: Pick<PlayerRow, "displayName" | "discordUserId">;
  poll: Pick<SchedulePollRow, "id" | "guildId" | "channelId" | "messageId" | "timezone">;
  upcomingSlots: ScheduleSlotRow[];
}): string {
  const { player, poll, upcomingSlots } = params;
  const kind = params.kind ?? "FIRST";
  const lines = upcomingSlots.map((s) => {
    const at = effectiveAt(s);
    return `• ${formatSlotDay(s.scheduledAt, poll.timezone)} · ${formatSlotTime(at, poll.timezone)}${s.map ? ` · 🗺️ ${s.map}` : ""}`;
  });
  const link = `https://discord.com/channels/${poll.guildId}/${poll.channelId}/${poll.messageId}`;

  let opener: string;
  if (kind === "FINAL") {
    const now = params.now ?? new Date();
    const firstAt = Math.min(...upcomingSlots.map((s) => effectiveAt(s).getTime()));
    opener = pick(FINAL_OPENERS, poll.id, player.discordUserId).replace("{when}", hoursAway(firstAt - now.getTime()));
  } else {
    opener = pick(FIRST_OPENERS, poll.id, player.discordUserId);
  }

  return [
    `Hey ${player.displayName}, ${opener}`,
    "",
    ...lines,
    "",
    `We need ${MIN_PLAYERS_TO_QUEUE} to queue. Tap every slot you can play — or **can't play any day** if this week's a no — here:`,
    link,
  ].join("\n");
}
