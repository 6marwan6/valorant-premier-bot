import type { AppContext } from "../appContext.js";
import type { ScheduleView } from "../database/repositories/scheduleRepository.js";
import { buildAgentBoard } from "../modules/agents/agentBoard.js";
import { loadAgentEmojis } from "./agentEmojiCache.js";

/** Discord error 10008: the message was deleted (someone cleaned the channel). */
function isUnknownMessage(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === 10008;
}

/**
 * Keeps the public AGENT SELECT lineup (modules/agents/agentBoard.ts) current:
 * edits the poll's lineup message in place, or posts it the first time — which
 * is also how a schedule posted before this feature existed gets one, on its
 * next vote or pick.
 *
 * Best-effort, exactly like syncScheduleMessage: the database is already the
 * source of truth (plan principle #2) and a vote or pick is already recorded by
 * the time this runs, so a Discord failure is logged and swallowed — this
 * function never throws.
 *
 * Posting is claimed in the database first (ScheduleRepository.claimAgentBoardPost),
 * so two simultaneous clicks can't post two lineups (plan section 50); if the
 * message was deleted in Discord the stale id is forgotten and a fresh one posted.
 */
export async function syncAgentBoard(ctx: AppContext, view: ScheduleView, now: Date = new Date()): Promise<void> {
  const { poll } = view;
  const repo = ctx.repositories.schedules;
  try {
    if (!poll.agentBoardMessageId && poll.status !== "OPEN") return; // nothing to retire, and no reason to post for a cancelled schedule

    const [customAgents, emojis] = await Promise.all([repo.listCustomAgents(poll.guildId), loadAgentEmojis(ctx.discord, ctx.logger)]);
    const board = buildAgentBoard(view, customAgents, emojis, now);
    const payload = { content: board.content, embeds: board.embeds, components: board.components, suppressMentions: true as const };

    if (poll.agentBoardMessageId) {
      try {
        await ctx.discord.editChannelMessage(poll.channelId, poll.agentBoardMessageId, payload);
        return;
      } catch (err) {
        if (!isUnknownMessage(err) || poll.status !== "OPEN") throw err;
        await repo.setAgentBoardMessageId(poll.id, null); // deleted in Discord — post a fresh one below
      }
    }

    if (!(await repo.claimAgentBoardPost(poll.id))) return; // another click is already posting it
    let sent: { id: string };
    try {
      sent = await ctx.discord.sendChannelMessage(poll.channelId, payload);
    } catch (err) {
      await repo.setAgentBoardMessageId(poll.id, null).catch(() => undefined); // release the claim so the next change retries at once
      throw err;
    }
    await repo.setAgentBoardMessageId(poll.id, sent.id);
  } catch (err) {
    ctx.logger.warn(
      { event: "agentBoard.syncFailed", pollId: poll.id, guildId: poll.guildId, err: err instanceof Error ? err.message : String(err) },
      "Failed to refresh the AGENT SELECT lineup (votes and picks are still recorded)",
    );
  }
}
