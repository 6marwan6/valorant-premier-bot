import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import {
  ComponentType,
  InteractionResponseType,
  MessageFlags,
  TextInputStyle,
  type APIModalInteractionResponseCallbackData,
  type APIModalSubmitInteraction,
} from "discord-api-types/v10";
import type { AppContext } from "../appContext.js";
import type { AiConversationRow } from "../database/schema/aiConversations.js";
import type { MatchRow } from "../database/schema/matches.js";
import type { PlayerRow } from "../database/schema/players.js";
import {
  CONSOLE_MODAL_FIELD_ID,
  CONSOLE_MODAL_MAX_LENGTH,
  buildConsoleModalCustomId,
  buildConsoleReplyCustomId,
  parseConsoleModalCustomId,
} from "../modules/ai/conversationCustomId.js";
import type { ReplyOutcome } from "../modules/ai/conversationService.js";

/**
 * Discord side of Phase 7's private conversations (plan section 59: "Discord
 * DM, conversation state, follow-up questions, CONSOLE conversation flow").
 * The decisions live in modules/ai/conversationService.ts; this file only
 * moves messages.
 *
 * **How a player replies, given the hosting model.** A DM reply typed into
 * the chat box is an ordinary channel message, and this app has no gateway
 * connection (README "Hosting & Deployment") — Discord never pushes such a
 * message to an HTTP endpoint. Two paths therefore feed the same
 * ConversationService.handlePlayerReply:
 *
 *   1. **The 💬 Reply button** under every bot DM opens a modal; its submit
 *      *is* an interaction, so it arrives instantly over the existing
 *      endpoint. Works with zero extra setup.
 *   2. **Typed DMs**, picked up by an optional cron poll of open
 *      conversations' DM channels (services/scheduling/dmReplyPollJob.ts) —
 *      the same cron-polling design already decided for Phase 8's channel
 *      messages. Not instant; only works once that cron job is scheduled.
 *
 * Both are idempotent against each other and against retries (see
 * ai_messages.source_ref).
 */

const REPLY_FOOTER = "\n\n-# 💬 Tap **Reply** to answer";

/** Discord's hard limit on message content. */
const DISCORD_MESSAGE_LIMIT = 2000;

export function buildReplyRow(conversationId: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildConsoleReplyCustomId(conversationId))
      .setLabel("Reply")
      .setEmoji("💬")
      .setStyle(ButtonStyle.Primary),
  );
}

/**
 * The modal the Reply button opens. Built without touching the database —
 * it has to be the interaction's *first* response (Discord's 3s rule).
 *
 * The text input sits inside a Label component: wrapping modal inputs in an
 * action row is deprecated in Discord's API (see the discord-api-types
 * doc on `APIModalInteractionResponseCallbackData.components`).
 */
export function buildReplyModal(conversationId: number): {
  type: InteractionResponseType.Modal;
  data: APIModalInteractionResponseCallbackData;
} {
  return {
    type: InteractionResponseType.Modal,
    data: {
      custom_id: buildConsoleModalCustomId(conversationId),
      title: "Reply to M.A.R.I.",
      components: [
        {
          type: ComponentType.Label,
          label: "Your reply",
          component: {
            type: ComponentType.TextInput,
            custom_id: CONSOLE_MODAL_FIELD_ID,
            style: TextInputStyle.Paragraph,
            min_length: 1,
            max_length: CONSOLE_MODAL_MAX_LENGTH,
            required: true,
          },
        },
      ],
    },
  };
}

/** The ephemeral "can't do that" response for a Reply button whose id doesn't parse. */
export function unrecognizedReplyButtonResponse() {
  return {
    type: InteractionResponseType.ChannelMessageWithSource,
    data: { content: "This button isn't recognized anymore.", flags: MessageFlags.Ephemeral },
  };
}

/** `> ` on every line so the player's own words read as a quote above the reply. */
export function quoteForDm(text: string): string {
  return text
    .trim()
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
}

function withReplyFooter(text: string): string {
  return `${text}${REPLY_FOOTER}`;
}

function discordErrorCode(err: unknown): number | undefined {
  return typeof err === "object" && err !== null && "code" in err && typeof (err as { code: unknown }).code === "number"
    ? (err as { code: number }).code
    : undefined;
}

export type StartConsoleDmResult = "started" | "already_open" | "unavailable" | "dm_failed";

/**
 * WANTS_TO_BUT_CANNOT -> open a conversation and DM the opener (plan
 * sections 20 and 61). "unavailable" (AI off, or the player turned AI
 * follow-ups off) and "dm_failed" (closed DMs etc.) both tell the caller to
 * fall back to the Phase 6 single private message; "already_open" means
 * nothing should be sent (plan section 50). Never throws for a Discord
 * failure — those become "dm_failed".
 */
export async function startConsoleDm(
  ctx: AppContext,
  params: { player: PlayerRow; match: MatchRow },
): Promise<StartConsoleDmResult> {
  const outcome = await ctx.services.conversations.startConsole(params);
  if (outcome.kind !== "started") return outcome.kind;

  const { conversation, openerText } = outcome;
  let dmChannelId: string;
  let messageId: string;
  try {
    const channel = await ctx.discord.createDmChannel(params.player.discordUserId);
    const sent = await ctx.discord.sendDirectMessage(channel.id, {
      content: withReplyFooter(openerText),
      components: [buildReplyRow(conversation.id)],
    });
    dmChannelId = channel.id;
    messageId = sent.id;
  } catch (err) {
    ctx.logger.warn(
      {
        event: "ai.conversation.dmFailed",
        conversationId: conversation.id,
        playerId: params.player.id,
        matchId: params.match.id,
        discordErrorCode: discordErrorCode(err),
        err: err instanceof Error ? err.message : String(err),
      },
      "Could not DM the player; falling back to an in-channel private message",
    );
    await ctx.services.conversations.abandon(conversation.id, "DM_UNAVAILABLE");
    return "dm_failed";
  }

  // The DM is out. From here a bookkeeping failure must not turn into
  // "dm_failed" (the player HAS the message) — log it and carry on.
  try {
    await ctx.services.conversations.recordOpener({
      conversationId: conversation.id,
      text: openerText,
      dmChannelId,
      discordMessageId: messageId,
    });
  } catch (err) {
    ctx.logger.error(
      {
        event: "ai.conversation.recordOpenerFailed",
        conversationId: conversation.id,
        err: err instanceof Error ? err.message : String(err),
      },
      "DM sent but recording it failed",
    );
  }

  ctx.logger.info(
    { event: "ai.conversation.started", conversationId: conversation.id, playerId: params.player.id, matchId: params.match.id },
    "Private CONSOLE conversation started",
  );
  return "started";
}

type ReplyOutcomeWithText = Extract<ReplyOutcome, { kind: "reply" }>;

/**
 * Delivers a generated reply into the DM and records it. Returns whether
 * it actually reached the player. `echo` (the modal path) prepends the
 * player's own words as a quote, because text entered in a modal never
 * appears in the chat on its own; typed DMs are already visible so the
 * poller passes none.
 */
export async function deliverConversationReply(
  ctx: AppContext,
  params: {
    conversation: AiConversationRow;
    dmChannelId: string;
    outcome: ReplyOutcomeWithText;
    echo?: string;
  },
): Promise<boolean> {
  const { conversation, outcome } = params;

  let body = outcome.text;
  if (outcome.continues) body = withReplyFooter(body);
  if (params.echo) {
    // Keep the quote from ever pushing the message over Discord's limit.
    const room = Math.max(0, DISCORD_MESSAGE_LIMIT - body.length - 2);
    const quote = quoteForDm(params.echo).slice(0, room);
    if (quote.length > 0) body = `${quote}\n${body}`;
  }

  try {
    await ctx.discord.sendDirectMessage(params.dmChannelId, {
      content: body,
      components: outcome.continues ? [buildReplyRow(conversation.id)] : [],
    });
  } catch (err) {
    ctx.logger.error(
      {
        event: "ai.conversation.replyDeliveryFailed",
        conversationId: conversation.id,
        discordErrorCode: discordErrorCode(err),
        err: err instanceof Error ? err.message : String(err),
      },
      "Failed to deliver a conversation reply",
    );
    return false;
  }

  try {
    await ctx.services.conversations.recordAssistantMessage(conversation.id, outcome.text);
  } catch (err) {
    ctx.logger.error(
      {
        event: "ai.conversation.recordReplyFailed",
        conversationId: conversation.id,
        err: err instanceof Error ? err.message : String(err),
      },
      "Reply delivered but recording it failed",
    );
  }
  return true;
}

const CONVERSATION_ENDED_MESSAGE = "This chat has wrapped up 👍";

/**
 * Pulls the reply text out of a modal submission. Accepts both payload
 * shapes — the Label wrapper this app sends (`{type: 18, component}`) and
 * the deprecated action-row wrapper (`{type: 1, components: [...]}`) — so an
 * old modal still sitting open in someone's client when Discord's behavior
 * shifts doesn't lose their message.
 */
export function extractModalText(raw: Pick<APIModalSubmitInteraction, "data">): string {
  for (const row of raw.data.components as unknown as Array<Record<string, unknown>>) {
    const fields: Array<Record<string, unknown>> = [];
    if (row.component && typeof row.component === "object") fields.push(row.component as Record<string, unknown>);
    if (Array.isArray(row.components)) fields.push(...(row.components as Array<Record<string, unknown>>));
    for (const field of fields) {
      if (field.custom_id === CONSOLE_MODAL_FIELD_ID && typeof field.value === "string") return field.value;
    }
  }
  return "";
}

/**
 * A submitted Reply modal (already acknowledged with a deferred message
 * update by handleDiscordInteraction). Runs the turn, sends the reply as a
 * new DM message, then removes the answered message's button.
 *
 * Errors here never touch attendance (plan section 66 #8): the worst case
 * is the player being told, privately, to try again.
 */
export async function handleConsoleReplyModal(raw: APIModalSubmitInteraction, ctx: AppContext): Promise<void> {
  const conversationId = parseConsoleModalCustomId(raw.data.custom_id);
  const sender = (raw.member?.user ?? raw.user)!;
  const startedAt = Date.now();

  if (conversationId === null) {
    ctx.logger.warn({ event: "ai.conversation.modalUnrecognized" }, "Received an unrecognized modal submit");
    return;
  }

  const text = extractModalText(raw);
  // Only used when the conversation row has no DM channel recorded (the
  // opener's bookkeeping failed); the interaction itself happened in that DM.
  const interactionChannelId = raw.channel_id ?? raw.channel?.id;
  try {
    const outcome = await ctx.services.conversations.handlePlayerReply({
      conversationId,
      discordUserId: sender.id,
      text,
      sourceRef: `interaction:${raw.id}`,
    });

    switch (outcome.kind) {
      case "duplicate":
      case "ignored":
        return;

      case "not_found":
      case "forbidden":
        // Same message either way: don't confirm whether someone else's conversation exists (plan section 44).
        await ctx.discord.sendInteractionFollowup(raw.token, {
          content: "I couldn't find that conversation.",
          ephemeral: true,
        });
        return;

      case "ended": {
        if (interactionChannelId) {
          await ctx.discord.sendDirectMessage(interactionChannelId, { content: CONVERSATION_ENDED_MESSAGE });
        }
        await removeButton(ctx, raw);
        return;
      }

      case "reply": {
        const dmChannelId = outcome.conversation.dmChannelId ?? interactionChannelId;
        const delivered =
          dmChannelId !== undefined &&
          (await deliverConversationReply(ctx, { conversation: outcome.conversation, dmChannelId, outcome, echo: text }));
        if (!delivered) {
          await ctx.discord.sendInteractionFollowup(raw.token, {
            content: "Something went wrong sending my reply. Please try again.",
            ephemeral: true,
          });
          return;
        }
        // Only after the reply is out: taking the button away first would
        // leave the player with nothing to press if delivery failed.
        await removeButton(ctx, raw);
        ctx.logger.info(
          {
            event: "ai.conversation.replied",
            conversationId,
            via: "modal",
            source: outcome.source,
            continues: outcome.continues,
            latencyMs: Date.now() - startedAt,
          },
          "Conversation reply sent",
        );
        return;
      }
    }
  } catch (err) {
    ctx.logger.error(
      {
        event: "ai.conversation.modalFailed",
        conversationId,
        latencyMs: Date.now() - startedAt,
        err: err instanceof Error ? err.message : String(err),
      },
      "Reply modal handler threw",
    );
    await ctx.discord
      .sendInteractionFollowup(raw.token, {
        content: "Something went wrong handling your reply. Please try again.",
        ephemeral: true,
      })
      .catch(() => undefined);
  }
}

/** Strips the Reply button (and its footer hint) from the DM message the player just answered. Best effort. */
async function removeButton(ctx: AppContext, raw: APIModalSubmitInteraction): Promise<void> {
  const original = raw.message?.content ?? "";
  try {
    await ctx.discord.editOriginalInteractionResponse(raw.token, {
      content: original.replace(REPLY_FOOTER, ""),
      components: [],
    });
  } catch (err) {
    ctx.logger.warn(
      { event: "ai.conversation.removeButtonFailed", err: err instanceof Error ? err.message : String(err) },
      "Could not remove the answered Reply button",
    );
  }
}
