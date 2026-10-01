import type { AppContext } from "../appContext.js";
import type { PlayerRow } from "../database/schema/players.js";
import type { SpokenReplyOptions } from "../modules/ai/conversationContextBuilder.js";

/**
 * The server side of the free-form chat with Mari (plan section 42/63,
 * revised 2026-09-29): `/mari` in a channel, or `@Mari` typed in one (the
 * latter via the gateway worker, plan section 4's note).
 *
 * Public by nature — everyone in the channel can read the whole exchange —
 * so everything Mari may use here is already filtered for that audience
 * (memoryRetrieval.ts `PUBLIC_CHANNEL`, teamFactsService.ts): TEAM/PUBLIC
 * memories only, and the union of every player's protected topics. This file
 * only moves messages; the decisions live in ConversationService/AiService.
 *
 * Continuing a server chat is just talking to Mari again (`/mari` or
 * `@Mari`); there is no Reply button here — the player's own message is
 * already visible in the channel, so unlike the DM modal there is nothing to
 * echo. After 5 idle hours the chat rolls over into a fresh one
 * (ConversationService.openChat) that starts from the memory table only.
 */

export type ServerChatResult =
  | { kind: "replied"; text: string }
  | { kind: "unavailable" }
  | { kind: "not_a_player" }
  | { kind: "ignored" }
  | { kind: "failed" };

/**
 * Runs one server-chat turn and hands the reply text to `deliver`, which
 * posts it (an interaction edit for `/mari`, a threaded channel reply for
 * `@Mari`). The assistant message is recorded only after `deliver` resolves,
 * so a failed post leaves the transcript unchanged and the player can simply
 * ask again (same rule as the DM path).
 */
export async function runServerChatTurn(
  ctx: AppContext,
  params: {
    guildId: string;
    player: PlayerRow | undefined;
    text: string;
    /** `command:<interaction id>` or `message:<discord message id>` — the idempotency key (plan section 50). */
    sourceRef: string;
    deliver: (text: string) => Promise<void>;
    /** Set for a reply that will be spoken aloud (voice worker): short, plain text, optionally a faster model. */
    voice?: SpokenReplyOptions;
    now?: Date;
  },
): Promise<ServerChatResult> {
  const { player } = params;
  // Same rule everywhere a player-only feature is gated: on the roster AND active.
  if (!player || !player.active) return { kind: "not_a_player" };

  const opened = await ctx.services.conversations.openChat({ guildId: params.guildId, player, mode: "SERVER_CHAT", now: params.now });
  if (opened.kind === "unavailable") return { kind: "unavailable" };

  const outcome = await ctx.services.conversations.handlePlayerReply({
    conversationId: opened.conversation.id,
    discordUserId: player.discordUserId,
    text: params.text,
    sourceRef: params.sourceRef,
    voice: params.voice,
    now: params.now,
  });

  if (outcome.kind === "duplicate" || outcome.kind === "ignored") return { kind: "ignored" };
  if (outcome.kind !== "reply") {
    ctx.logger.warn(
      { event: "ai.serverChat.unexpectedOutcome", conversationId: opened.conversation.id, outcome: outcome.kind },
      "Unexpected outcome in a server chat turn",
    );
    return { kind: "failed" };
  }

  const text = outcome.chatLimitReached ? `${outcome.text}\n\n-# That was a long one — your next message starts a fresh chat.` : outcome.text;
  try {
    await params.deliver(text);
  } catch (err) {
    ctx.logger.error(
      { event: "ai.serverChat.deliveryFailed", conversationId: opened.conversation.id, err: err instanceof Error ? err.message : String(err) },
      "Failed to post a server chat reply",
    );
    return { kind: "failed" };
  }

  try {
    await ctx.services.conversations.recordAssistantMessage(opened.conversation.id, outcome.text, null);
  } catch (err) {
    ctx.logger.error(
      { event: "ai.serverChat.recordReplyFailed", conversationId: opened.conversation.id, err: err instanceof Error ? err.message : String(err) },
      "Reply posted but recording it failed",
    );
  }
  return { kind: "replied", text };
}
