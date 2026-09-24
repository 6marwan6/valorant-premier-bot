import { REST, Routes, type APIActionRowComponent, type APIButtonComponent } from "discord.js";
import { MessageFlags } from "discord-api-types/v10";
import type { ActionRowBuilder, ButtonBuilder } from "discord.js";

export type DiscordRest = REST;

export function createDiscordRest(botToken: string): DiscordRest {
  return new REST({ version: "10" }).setToken(botToken);
}

/** The subset of a Discord message the DM poller reads. */
export interface DiscordChannelMessage {
  id: string;
  content: string;
  author: { id: string; bot?: boolean };
}

export interface ReplyPayload {
  content: string;
  components?: ActionRowBuilder<ButtonBuilder>[];
  ephemeral?: boolean;
}

function serializeComponents(
  components: ActionRowBuilder<ButtonBuilder>[] | undefined,
): APIActionRowComponent<APIButtonComponent>[] | undefined {
  if (!components || components.length === 0) return components === undefined ? undefined : [];
  return components.map((row) => row.toJSON() as APIActionRowComponent<APIButtonComponent>);
}

/**
 * Every outbound Discord call the app makes, now that there's no gateway
 * Client to hang `channel.send()`/`message.edit()` off of. Each of these
 * is a single stateless HTTPS request — exactly what a Vercel serverless
 * function can do without a persistent connection (plan section 6).
 */
export class DiscordRestClient {
  constructor(
    private readonly rest: DiscordRest,
    private readonly applicationId: string,
  ) {}

  /** Posts a brand-new message to a channel — used once, by /post-match. */
  async sendChannelMessage(channelId: string, payload: ReplyPayload): Promise<{ id: string }> {
    return (await this.rest.post(Routes.channelMessages(channelId), {
      body: { content: payload.content, components: serializeComponents(payload.components) },
    })) as { id: string };
  }

  /**
   * Opens (or fetches — Discord returns the existing one) the DM channel
   * between the bot and a user. Phase 7: private conversations (plan
   * section 59). Fails with Discord error 50007 when the user doesn't
   * accept DMs from this bot; callers treat any failure as "can't DM".
   */
  async createDmChannel(userId: string): Promise<{ id: string }> {
    return (await this.rest.post(Routes.userChannels(), { body: { recipient_id: userId } })) as { id: string };
  }

  /**
   * Sends a message into a DM channel. Unlike `sendChannelMessage` this
   * always sets `allowed_mentions: { parse: [] }` — the text includes
   * player- and model-written content, and nothing in a private DM should
   * ever be able to ping anyone (aiOutput.ts neutralizes mentions too; this
   * is the second layer).
   */
  async sendDirectMessage(channelId: string, payload: ReplyPayload): Promise<{ id: string }> {
    return (await this.rest.post(Routes.channelMessages(channelId), {
      body: {
        content: payload.content,
        components: serializeComponents(payload.components),
        allowed_mentions: { parse: [] },
      },
    })) as { id: string };
  }

  /**
   * Reads messages from a channel, oldest first, optionally only those
   * after a given message id. Works from a stateless function (no gateway),
   * which is what lets the DM poller pick up typed replies. Message content
   * in DMs with the bot is readable without the privileged Message Content
   * intent.
   */
  async listChannelMessages(
    channelId: string,
    options: { after?: string | null; limit?: number } = {},
  ): Promise<DiscordChannelMessage[]> {
    const query = new URLSearchParams({ limit: String(options.limit ?? 50) });
    if (options.after) query.set("after", options.after);
    const raw = (await this.rest.get(Routes.channelMessages(channelId), { query })) as DiscordChannelMessage[];
    // Discord's ordering with `after` isn't something to lean on; sort by snowflake.
    return [...raw].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0));
  }

  /**
   * Public message that @mentions exactly one user (attendance reactions).
   * `allowed_mentions` restricts pings to that user, so nothing else in the
   * text — model-written or otherwise — can ping anyone.
   */
  async sendMentionMessage(channelId: string, content: string, mentionUserId: string): Promise<{ id: string }> {
    return (await this.rest.post(Routes.channelMessages(channelId), {
      body: { content: `<@${mentionUserId}> ${content}`, allowed_mentions: { parse: [], users: [mentionUserId] } },
    })) as { id: string };
  }

  /** Edits an existing message by id — used by announcementSync.ts (edit/cancel outside a button click). */
  async editChannelMessage(channelId: string, messageId: string, payload: ReplyPayload): Promise<void> {
    await this.rest.patch(Routes.channelMessage(channelId, messageId), {
      body: { content: payload.content, components: serializeComponents(payload.components) },
    });
  }

  /**
   * Fills in the deferred placeholder for a slash command (plan-driven
   * design note: every command in this app defers as ephemeral
   * immediately on receipt — see api/interactions.ts — so "reply" here
   * means "edit that placeholder with the real content," matching what
   * `interaction.reply()` looked like to callers in the old gateway code).
   */
  async editOriginalInteractionResponse(interactionToken: string, payload: ReplyPayload): Promise<void> {
    await this.rest.patch(Routes.webhookMessage(this.applicationId, interactionToken, "@original"), {
      body: { content: payload.content, components: serializeComponents(payload.components) },
    });
  }

  /**
   * Sends a NEW followup message (optionally ephemeral) without touching
   * the original. Used for button-click errors: the button's deferred
   * placeholder IS the public roster message, so an error must never
   * PATCH @original (that would overwrite the public message with an
   * error) — it goes here instead.
   */
  async sendInteractionFollowup(interactionToken: string, payload: ReplyPayload): Promise<void> {
    await this.rest.post(Routes.webhook(this.applicationId, interactionToken), {
      body: {
        content: payload.content,
        components: serializeComponents(payload.components),
        flags: payload.ephemeral ? MessageFlags.Ephemeral : undefined,
      },
    });
  }
}
