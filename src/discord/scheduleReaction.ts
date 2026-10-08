import type { ButtonInteraction } from "discord.js";
import type { AppContext } from "../appContext.js";
import type { ScheduleSlotRow } from "../database/schema/schedules.js";
import { buildDeclineEvent, buildVoteEvent } from "../modules/schedules/scheduleAiEvent.js";
import { buildScheduleReactionCard } from "../modules/schedules/scheduleMessage.js";
import type { AgentRole } from "../modules/agents/agentData.js";
import { avatarUrlOf } from "./avatarUrl.js";
import { loadAgentEmojis } from "./agentEmojiCache.js";

/**
 * Mari's public reaction to the weekly schedule (2026-10-03): CELEBRATE for a
 * player's first locked-in slot in a poll, ROAST for their "can't play any
 * day" — each at most once per player per poll (claimed in the database
 * *before* the model is called, plan section 50), so toggling votes, changing
 * an agent or tapping a second slot never turns the channel into a chat log.
 * Posted publicly with an @mention, like the attendance reactions.
 *
 * Since 2026-10-08 (owner's request) the CELEBRATE card waits until the player
 * has *picked an agent*: it is sent from the agent pick, not from the vote, so it
 * can say — and show — the agent they locked in. A player who votes but never
 * picks gets no card (the lineup message shows them as "still choosing").
 * Where it is posted is `server_config.reaction_channel_id` (set with /setup
 * reaction_channel), falling back to the schedule's own channel.
 *
 * Fully isolated: the vote or pick is already recorded and the cards already
 * updated, so nothing in here can fail the click (plan sections 48 / 66 #8), and
 * a fallback line is never posted publicly (the player already got their
 * private confirmation). The model writes only the text; the slot, the agent
 * and the role on the card are database facts (plan section 14).
 */
export async function reactWithMari(
  interaction: ButtonInteraction,
  ctx: AppContext,
  params: {
    guildId: string;
    pollId: number;
    /** The schedule's own channel — where the reaction goes when no reaction channel is configured. */
    channelId: string;
    timezone: string;
    kind: "VOTE" | "DECLINE";
    slot?: ScheduleSlotRow;
    slotCount: number;
    /** VOTE only: the agent the player just locked in. */
    agent?: { key: string; name: string; role: AgentRole };
  },
): Promise<void> {
  if (!ctx.services.ai.enabled) return;
  try {
    const player = await ctx.repositories.players.getByDiscordUserId(params.guildId, interaction.user.id);
    // Premier players only — a server member can't get this far (the service rejects the vote), but the check is cheap and keeps this honest.
    if (!player || !player.active || player.kind !== "PLAYER") return;
    if (!(await ctx.services.schedules.claimAiReaction(params.pollId, player.discordUserId, params.kind))) return;

    const outcome =
      params.kind === "VOTE"
        ? await ctx.services.ai.respondToScheduleVote({
            player,
            mode: "CELEBRATE",
            pollId: params.pollId,
            event: buildVoteEvent({ pollId: params.pollId, slot: params.slot!, timezone: params.timezone, agent: params.agent }),
          })
        : await ctx.services.ai.respondToScheduleVote({
            player,
            mode: "ROAST",
            pollId: params.pollId,
            event: buildDeclineEvent({ pollId: params.pollId, slotCount: params.slotCount }),
          });
    if (outcome.source !== "ai") return;

    const card = buildScheduleReactionCard({
      player,
      kind: params.kind,
      text: outcome.text,
      pollId: params.pollId,
      slot: params.slot,
      timezone: params.timezone,
      avatarUrl: avatarUrlOf(interaction),
      agent: params.agent,
      emojis: await loadAgentEmojis(ctx.discord, ctx.logger),
    });
    const config = await ctx.repositories.serverConfig.getByGuildId(params.guildId);
    await ctx.discord.sendMentionMessage(config?.reactionChannelId ?? params.channelId, outcome.text, player.discordUserId, card);
  } catch (err) {
    ctx.logger.warn(
      { event: "schedule.aiReactionFailed", pollId: params.pollId, kind: params.kind, err: err instanceof Error ? err.message : String(err) },
      "Mari's schedule reaction failed (the vote or pick is still recorded)",
    );
  }
}
