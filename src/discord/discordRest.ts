import { REST, Routes, type APIActionRowComponent, type APIButtonComponent } from "discord.js";
import { MessageFlags } from "discord-api-types/v10";
import type { ActionRowBuilder, ButtonBuilder } from "discord.js";

export type DiscordRest = REST;

export function createDiscordRest(botToken: string): DiscordRest {
  return new REST({ version: "10" }).setToken(botToken);
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
