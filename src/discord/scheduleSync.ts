import type { AppContext } from "../appContext.js";
import type { ScheduleView } from "../database/repositories/scheduleRepository.js";
import { buildScheduleMessage } from "../modules/schedules/scheduleMessage.js";
import { syncAgentBoard } from "./agentBoardSync.js";
import { loadAgentEmojis } from "./agentEmojiCache.js";

/** Builds the card for a poll from current database state (roster read fresh, so "No vote yet" is always current). */
export async function renderSchedule(ctx: AppContext, view: ScheduleView, now: Date = new Date()) {
  const [roster, customAgents, emojis] = await Promise.all([
    ctx.repositories.players.listActivePlayersByGuild(view.poll.guildId),
    ctx.repositories.schedules.listCustomAgents(view.poll.guildId),
    loadAgentEmojis(ctx.discord, ctx.logger), // never throws; empty = no portraits yet
  ]);
  // `suppressMentions`: the card carries the roster's @mentions in its text, and a re-render (a vote, an edit) must never
  // notify anyone again. Only the very first post pings — createSchedule overrides this with the roster as the allowed users.
  return { ...buildScheduleMessage(view, roster, now, customAgents, emojis), suppressMentions: true as const, rosterIds: roster.map((p) => p.discordUserId) };
}

/**
 * Pushes a fresh card onto an already-posted schedule message — used by the
 * admin commands (/schedule-slot, /cancel-schedule) and by agent picks, which
 * change state outside a vote click and so have no interaction to `update()`.
 * It also refreshes the AGENT SELECT lineup that goes with the card.
 * Best-effort like syncAnnouncementIfPosted: the database is already the
 * source of truth (plan principle #2), so a Discord failure is logged, not
 * thrown.
 */
export async function syncScheduleMessage(ctx: AppContext, view: ScheduleView): Promise<void> {
  if (!view.poll.messageId) return;
  try {
    const { content, embeds, components, suppressMentions } = await renderSchedule(ctx, view);
    await ctx.discord.editChannelMessage(view.poll.channelId, view.poll.messageId, { content, embeds, components, suppressMentions });
  } catch (err) {
    ctx.logger.warn(
      { event: "schedule.syncFailed", pollId: view.poll.id, guildId: view.poll.guildId, err: err instanceof Error ? err.message : String(err) },
      "Failed to refresh the posted schedule message (database is still correct)",
    );
  }
  // The public AGENT SELECT lineup follows the card (a pick, a map or queue change, a cancellation). Never throws.
  await syncAgentBoard(ctx, view);
}
