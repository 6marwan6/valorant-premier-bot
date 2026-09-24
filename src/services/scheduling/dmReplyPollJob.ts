import type { AppContext } from "../../appContext.js";
import { deliverConversationReply } from "../../discord/consoleConversation.js";

export interface DmReplyPollSummary {
  conversationsChecked: number;
  conversationsEnded: number;
  repliesSent: number;
  failures: number;
}

/**
 * One tick of the typed-DM-reply poller (plan section 59, Phase 7). The
 * app has no gateway connection (README "Hosting & Deployment"), so a
 * player who *types* a reply into the bot's DM — instead of tapping the
 * 💬 Reply button — is only noticed by asking Discord for the channel's
 * newest messages. This is the same cron-polling design already decided
 * for Phase 8's channel messages, applied to the (few, private, short-lived)
 * DM channels of conversations that are still open.
 *
 * Per open conversation:
 *
 * 1. If it should already be over (idle for too long, match started or
 *    cancelled, the player turned AI follow-ups off) — end it, no message.
 * 2. Fetch DM messages after the stored cursor. Nothing new -> done.
 * 3. Keep only what the *player* wrote (never the bot's own messages, never
 *    anyone else's), join a burst of messages into ONE turn, and hand it to
 *    ConversationService — the very same entry point the Reply button uses.
 *    The turn is identified by the newest player message's id, so an
 *    overlapping tick, a retry, or the same text arriving another way is
 *    answered once (plan section 50; see ai_messages.source_ref).
 * 4. Only then advance the cursor — and only past what was actually read,
 *    so anything typed while the model was thinking is picked up next tick.
 *
 * One conversation failing (Discord or DB hiccup) never stops the others,
 * and nothing here can touch attendance (plan section 66 #8).
 */
export async function runDmReplyPollJob(ctx: AppContext, now: Date = new Date()): Promise<DmReplyPollSummary> {
  const summary: DmReplyPollSummary = { conversationsChecked: 0, conversationsEnded: 0, repliesSent: 0, failures: 0 };
  if (!ctx.services.conversations.enabled) return summary;

  const open = await ctx.services.conversations.listOpenForPolling();

  for (const conversation of open) {
    summary.conversationsChecked++;
    try {
      const dmChannelId = conversation.dmChannelId;
      if (!dmChannelId) continue;

      const player = await ctx.repositories.players.getById(conversation.playerId);
      const match = await ctx.repositories.matches.getById(conversation.matchId);

      const invalid = await ctx.services.conversations.endReasonIfInvalid(conversation, now, {
        player: player ?? undefined,
        match: match ?? undefined,
      });
      if (invalid || !player) {
        await ctx.services.conversations.end(conversation.id, invalid ?? "COMPLETED");
        summary.conversationsEnded++;
        continue;
      }

      const messages = await ctx.discord.listChannelMessages(dmChannelId, { after: conversation.lastSeenMessageId });
      if (messages.length === 0) continue;

      const newestSeen = messages[messages.length - 1]!.id;
      const mine = messages.filter((m) => m.author.id === player.discordUserId && !m.author.bot && m.content.trim().length > 0);

      if (mine.length > 0) {
        const outcome = await ctx.services.conversations.handlePlayerReply({
          conversationId: conversation.id,
          discordUserId: player.discordUserId,
          text: mine.map((m) => m.content).join("\n"),
          sourceRef: `message:${mine[mine.length - 1]!.id}`,
          now,
        });

        if (outcome.kind === "reply") {
          const delivered = await deliverConversationReply(ctx, { conversation: outcome.conversation, dmChannelId, outcome });
          if (delivered) summary.repliesSent++;
          else summary.failures++;
        } else if (outcome.kind === "ended") {
          summary.conversationsEnded++;
        }
      }

      await ctx.services.conversations.advancePollCursor(conversation.id, newestSeen);
    } catch (err) {
      summary.failures++;
      ctx.logger.error(
        {
          event: "cron.dmReplies.conversationFailed",
          conversationId: conversation.id,
          err: err instanceof Error ? err.message : String(err),
        },
        "DM poll failed for one conversation",
      );
    }
  }

  return summary;
}
