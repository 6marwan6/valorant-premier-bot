import type { AppContext } from "../appContext.js";
import type { ScheduleView } from "../database/repositories/scheduleRepository.js";
import { buildScheduleMessage } from "../modules/schedules/scheduleMessage.js";

/** Builds the card for a poll from current database state (roster read fresh, so "No vote yet" is always current). */
export async function renderSchedule(ctx: AppContext, view: ScheduleView, now: Date = new Date()) {
  const roster = await ctx.repositories.players.listActivePlayersByGuild(view.poll.guildId);
  return buildScheduleMessage(view, roster, now);
}

/**
 * Pushes a fresh card onto an already-posted schedule message — used by the
 * admin commands (/schedule-slot, /cancel-schedule), which change state
 * outside a button click and so have no interaction to `update()`.
 * Best-effort like syncAnnouncementIfPosted: the database is already the
 * source of truth (plan principle #2), so a Discord failure is logged, not
 * thrown.
 */
export async function syncScheduleMessage(ctx: AppContext, view: ScheduleView): Promise<void> {
  if (!view.poll.messageId) return;
  try {
    const { content, embeds, components } = await renderSchedule(ctx, view);
    await ctx.discord.editChannelMessage(view.poll.channelId, view.poll.messageId, { content, embeds, components });
  } catch (err) {
    ctx.logger.warn(
      { event: "schedule.syncFailed", pollId: view.poll.id, guildId: view.poll.guildId, err: err instanceof Error ? err.message : String(err) },
      "Failed to refresh the posted schedule message (database is still correct)",
    );
  }
}
