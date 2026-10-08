import type { ButtonInteraction } from "discord.js";
import type { AppContext } from "../../appContext.js";
import { parseScheduleCustomId } from "../../modules/schedules/scheduleCustomId.js";
import { buildQuorumMessage, buildScheduleReactionCard } from "../../modules/schedules/scheduleMessage.js";
import { buildDeclineEvent, buildVoteEvent } from "../../modules/schedules/scheduleAiEvent.js";
import type { ScheduleSlotRow } from "../../database/schema/schedules.js";
import { avatarUrlOf } from "../avatarUrl.js";
import { defaultTab, renderPanel } from "./dispatchAgentPick.js";
import { formatSlotDay, formatSlotTime } from "../../modules/schedules/scheduleLogic.js";
import { resolveDisplayName } from "../displayName.js";
import { renderSchedule } from "../scheduleSync.js";
import { syncAgentBoard } from "../agentBoardSync.js";
import { loadAgentEmojis } from "../agentEmojiCache.js";

/**
 * Mari's reaction to a schedule vote (2026-10-03): CELEBRATE for a player's
 * first slot in a poll, ROAST for their "can't play any day" — each at most
 * once per player per poll (claimed in the database *before* the model is
 * called, plan section 50), so toggling votes or tapping a second slot never
 * turns the channel into a chat log. Posted publicly with an @mention, like
 * the attendance reactions. Fully isolated: the vote is already recorded and
 * the card already updated, so nothing in here can fail the click (plan
 * sections 48 / 66 #8), and a fallback line is never posted publicly (the
 * player already got their private confirmation).
 */
async function reactWithMari(
  interaction: ButtonInteraction,
  ctx: AppContext,
  params: { guildId: string; pollId: number; channelId: string; timezone: string; kind: "VOTE" | "DECLINE"; slot?: ScheduleSlotRow; slotCount: number },
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
            event: buildVoteEvent({ pollId: params.pollId, slot: params.slot!, timezone: params.timezone }),
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
    });
    await ctx.discord.sendMentionMessage(params.channelId, outcome.text, player.discordUserId, card);
  } catch (err) {
    ctx.logger.warn(
      { event: "schedule.aiReactionFailed", pollId: params.pollId, kind: params.kind, err: err instanceof Error ? err.message : String(err) },
      "Mari's schedule reaction failed (the vote is still recorded)",
    );
  }
}

/**
 * A click on the weekly schedule card: `sched:<pollId>:vote:<slotId>` toggles
 * "I can play this slot"; `sched:<pollId>:decline` is "I can't play any day".
 *
 * Same shape as the attendance flow (plan section 15): authenticate, apply the
 * change in the database, refresh the one public card with `update()`, then
 * the extras — each fully isolated, so nothing after the database write can
 * turn a recorded vote into an error (plan sections 48/66 #8):
 *
 *  - a private confirmation of the player's current slots (deterministic);
 *  - Mari's public reaction (CELEBRATE for a first slot, ROAST for "can't
 *    play any day"), at most once per player per poll — see reactWithMari;
 *  - when this vote is the one that gives a slot its squad (5), the public
 *    "SQUAD LOCKED" card pinging the voters — posted at most once per slot
 *    (the repository claims it atomically, plan section 50).
 *
 * Voting is a toggle by design (a vote card is for changing your mind): the
 * unique (slot, player) index guarantees a double-delivered click can never
 * create a duplicate row, only flip the one row.
 */
export async function dispatchScheduleButton(interaction: ButtonInteraction, ctx: AppContext): Promise<void> {
  const action = parseScheduleCustomId(interaction.customId);
  if (!action) {
    await interaction.reply({ content: "This button isn't recognized anymore.", ephemeral: true });
    return;
  }
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: "This can only be used in a server.", ephemeral: true });
    return;
  }

  const startedAt = Date.now();
  const who = { discordUserId: interaction.user.id, displayName: resolveDisplayName(interaction) };
  try {
    if (action.kind === "agents") {
      // "🎯 PICK AGENT" on the card: open my panel for my first upcoming slot. The click was acknowledged as an update of
      // the public card, which stays untouched — the panel is a private follow-up.
      const opened = await ctx.services.agentPicks.openFirst({ guildId, pollId: action.pollId, discordUserId: who.discordUserId });
      if (!opened.ok) {
        await interaction.reply({ content: `❌ ${opened.error}`, ephemeral: true });
        return;
      }
      const profile = await ctx.repositories.players.getByDiscordUserId(guildId, who.discordUserId);
      const emojis = await loadAgentEmojis(ctx.discord, ctx.logger);
      await interaction.followUp({ ...renderPanel(opened.value, who.discordUserId, defaultTab(profile), undefined, emojis), ephemeral: true });
      return;
    }

    if (action.kind === "vote") {
      const result = await ctx.services.schedules.vote({ guildId, pollId: action.pollId, slotId: action.slotId, ...who });
      if (!result.ok) {
        await interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
        return;
      }
      const { view, slot, action: did, reachedQuorum, yourPositions } = result.value;
      const card = await renderSchedule(ctx, view);
      await interaction.update(card);
      ctx.logger.info(
        { event: "schedule.voted", guildId, pollId: action.pollId, slotId: slot.id, discordUserId: who.discordUserId, action: did, latencyMs: Date.now() - startedAt },
        "Schedule vote recorded",
      );

      const tz = view.poll.timezone;
      const label = `${formatSlotDay(slot.scheduledAt, tz)} ${formatSlotTime(slot.scheduledAt, tz)}`;
      const mine = yourPositions.length
        ? `You're in for slot${yourPositions.length === 1 ? "" : "s"} **${yourPositions.join(", ")}**.`
        : "You're not on any slot right now.";
      if (did === "added") {
        // 2026-10-04: choosing a date opens the AGENT PICK panel (map, suggested comps, agents by role) instead of a bare
        // confirmation. If it can't be built the player still gets the plain confirmation — the vote is already recorded.
        const panel = await ctx.services.agentPicks.load({ guildId, slotId: slot.id, discordUserId: who.discordUserId }).catch(() => null);
        const profile = await ctx.repositories.players.getByDiscordUserId(guildId, who.discordUserId).catch(() => undefined);
        const notice = `✅ You're **in** for **${label}**. ${mine} Pick your agent below 👇`;
        const emojis = await loadAgentEmojis(ctx.discord, ctx.logger);
        const reply = panel?.ok ? { ...renderPanel(panel.value, who.discordUserId, defaultTab(profile), notice, emojis), ephemeral: true } : { content: `✅ You're **in** for **${label}**. ${mine}`, ephemeral: true };
        await interaction.followUp(reply).catch(() => undefined);
      } else {
        await interaction.followUp({ content: `↩️ Removed your vote for **${label}**. ${mine}`, ephemeral: true }).catch(() => undefined);
      }

      // The public AGENT SELECT lineup shows who is in (and drops a pick that went with a removed vote). Never throws.
      await syncAgentBoard(ctx, view);

      if (did === "added") {
        await reactWithMari(interaction, ctx, {
          guildId,
          pollId: action.pollId,
          channelId: view.poll.channelId,
          timezone: tz,
          kind: "VOTE",
          slot,
          slotCount: view.slots.length,
        });
      }

      if (reachedQuorum) {
        try {
          const roster = await ctx.repositories.players.listActivePlayersByGuild(guildId);
          const voters = view.votes.filter((v) => v.slotId === slot.id);
          const customAgents = await ctx.repositories.schedules.listCustomAgents(guildId);
          const quorum = buildQuorumMessage(slot, voters, roster, tz, view.picks, customAgents);
          await ctx.discord.sendChannelMessage(view.poll.channelId, {
            content: quorum.content,
            embeds: quorum.embeds,
            suppressMentions: true,
            mentionUserIds: quorum.mentionUserIds,
          });
        } catch (err) {
          ctx.logger.warn(
            { event: "schedule.quorumPostFailed", pollId: action.pollId, slotId: slot.id, err: err instanceof Error ? err.message : String(err) },
            "Squad-locked card failed (the vote is still recorded)",
          );
        }
      }
      return;
    }

    const result = await ctx.services.schedules.decline({ guildId, pollId: action.pollId, ...who });
    if (!result.ok) {
      await interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
      return;
    }
    await interaction.update(await renderSchedule(ctx, result.value.view));
    ctx.logger.info(
      { event: "schedule.declined", guildId, pollId: action.pollId, discordUserId: who.discordUserId, changed: result.value.changed, latencyMs: Date.now() - startedAt },
      "Schedule decline recorded",
    );
    await interaction
      .followUp({ content: "🚫 Got it — you can't play any day this week. Tap a slot any time if that changes.", ephemeral: true })
      .catch(() => undefined);
    if (result.value.changed) {
      await syncAgentBoard(ctx, result.value.view); // a decline frees the player's pick (and their place in the lineup)
      await reactWithMari(interaction, ctx, {
        guildId,
        pollId: action.pollId,
        channelId: result.value.view.poll.channelId,
        timezone: result.value.view.poll.timezone,
        kind: "DECLINE",
        slotCount: result.value.view.slots.length,
      });
    }
  } catch (err) {
    const cause = err instanceof Error && "cause" in err ? (err as { cause?: unknown }).cause : undefined;
    ctx.logger.error(
      {
        event: "schedule.failed",
        guildId,
        pollId: action.pollId,
        latencyMs: Date.now() - startedAt,
        err: err instanceof Error ? err.message : String(err),
        cause: cause instanceof Error ? cause.message : undefined,
      },
      "Schedule button handler threw",
    );
    // Plan sections 48/49: never claim the vote was recorded when it wasn't.
    const failure = "Something went wrong recording your vote. Please try again.";
    if (interaction.deferred || interaction.replied) await interaction.followUp({ content: failure, ephemeral: true }).catch(() => undefined);
    else await interaction.reply({ content: failure, ephemeral: true }).catch(() => undefined);
  }
}
