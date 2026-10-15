import type { AppContext } from "../../appContext.js";
import type { ServerConfigRow } from "../../database/schema/serverConfig.js";
import { buildVoteNudgeDm, selectVoteNudgeRecipients } from "../../modules/schedules/voteNudge.js";

export interface VoteNudgeSummary {
  voteNudgesSent: number;
  /** DMs closed to the bot (Discord 50007) — claimed so they are never retried, logged, harmless. */
  voteNudgesUnreachable: number;
  /** Transient Discord failures — the claim was released, the next tick retries. */
  voteNudgesFailed: number;
}

function discordErrorCode(err: unknown): number | undefined {
  return typeof err === "object" && err !== null && "code" in err && typeof (err as { code: unknown }).code === "number"
    ? (err as { code: number }).code
    : undefined;
}

/** Discord's "Cannot send messages to this user" — the player's DMs are closed to the bot. */
const CANNOT_DM_USER = 50007;

/**
 * Mari's "you haven't voted" DM (2026-10-14, owner's request): a day after a
 * weekly schedule is posted, every active Premier player who hasn't answered it
 * gets one private message listing the slots still open and linking to the
 * schedule. Runs inside every reminder cron tick (reminderCronJob.ts), so it
 * needs no extra scheduler entry.
 *
 * Who qualifies is decided by the pure selectVoteNudgeRecipients (voteNudge.ts).
 * Per recipient: claim -> DM -> mark sent, the same claim-before-send shape as
 * every other send here (plan section 50) — at most one nudge per player per
 * poll, even with overlapping ticks. A transient Discord failure releases the
 * claim so the next tick retries; closed DMs keep it, so an unreachable player
 * is tried once, not every five minutes. Nothing in here can affect votes,
 * attendance or the reminders (plan sections 48 / 66 #8): it is called from a
 * try/catch, and each player is isolated from the next.
 *
 * The message is deterministic (no model) — see buildVoteNudgeDm.
 */
export async function runScheduleVoteNudges(ctx: AppContext, configs: ServerConfigRow[], now: Date): Promise<VoteNudgeSummary> {
  const repo = ctx.repositories.schedules;
  const summary: VoteNudgeSummary = { voteNudgesSent: 0, voteNudgesUnreachable: 0, voteNudgesFailed: 0 };

  for (const config of configs) {
    const roster = await ctx.repositories.players.listActivePlayersByGuild(config.guildId);
    if (roster.length === 0) continue;

    for (const poll of await repo.listOpenPolls(config.guildId)) {
      const view = await repo.getView(poll.id);
      if (!view) continue;
      const { recipients, upcomingSlots } = selectVoteNudgeRecipients({ ...view, roster, now });

      for (const player of recipients) {
        if (!(await repo.claimVoteNudge(poll.id, player.discordUserId))) continue; // already nudged (or another tick has it)
        try {
          const channel = await ctx.discord.createDmChannel(player.discordUserId);
          await ctx.discord.sendDirectMessage(channel.id, { content: buildVoteNudgeDm({ player, poll: view.poll, upcomingSlots }) });
          await repo.markVoteNudgeSent(poll.id, player.discordUserId);
          summary.voteNudgesSent++;
          ctx.logger.info({ event: "schedule.voteNudgeSent", pollId: poll.id, playerId: player.id }, "Sent Mari's vote reminder DM");
        } catch (err) {
          const code = discordErrorCode(err);
          if (code === CANNOT_DM_USER) {
            summary.voteNudgesUnreachable++;
            ctx.logger.info({ event: "schedule.voteNudgeUnreachable", pollId: poll.id, playerId: player.id }, "Can't DM this player — vote reminder not sent (not retried)");
          } else {
            summary.voteNudgesFailed++;
            await repo.releaseVoteNudge(poll.id, player.discordUserId);
            ctx.logger.warn(
              { event: "schedule.voteNudgeFailed", pollId: poll.id, playerId: player.id, discordErrorCode: code, err: err instanceof Error ? err.message : String(err) },
              "Vote reminder DM failed — will retry next tick",
            );
          }
        }
      }
    }
  }
  return summary;
}
