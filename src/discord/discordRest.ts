import { REST, Routes, type APIActionRowComponent, type APIButtonComponent, type APIEmbed } from "discord.js";
import { MessageFlags } from "discord-api-types/v10";
import type { ActionRowBuilder, ButtonBuilder, EmbedBuilder } from "discord.js";

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

/** A decorated public reaction (attendance banter): the `<@user>` ping goes in `content`, everything else in the embed. */
export interface MentionCard {
  embeds: EmbedBuilder[];
}

export interface ReplyPayload {
  /** Optional now that embeds exist (reminderMessages.ts, Phase 9+): Discord requires at least one of content/embeds, never both empty — callers are responsible for supplying one or the other. */
  content?: string;
  embeds?: EmbedBuilder[];
  components?: ActionRowBuilder<ButtonBuilder>[];
  ephemeral?: boolean;
  /** Public replies that carry model-written text: `allowed_mentions: { parse: [] }` so nothing in it can ping anyone (2026-09-29 server chat). */
  suppressMentions?: boolean;
  /** With `suppressMentions`: the only users allowed to be pinged (/mari-say `mention`, /mari-voice `mention`). Everything else in the text stays inert. */
  mentionUserIds?: string[];
}

/** Discord's `allowed_mentions` for a channel message; undefined = Discord's default (mentions in the text ping). */
export function allowedMentionsFor(payload: Pick<ReplyPayload, "suppressMentions" | "mentionUserIds">): { parse: []; users?: string[] } | undefined {
  if (!payload.suppressMentions) return undefined;
  const users = [...new Set(payload.mentionUserIds ?? [])];
  return users.length > 0 ? { parse: [], users } : { parse: [] };
}

function serializeComponents(
  components: ActionRowBuilder<ButtonBuilder>[] | undefined,
): APIActionRowComponent<APIButtonComponent>[] | undefined {
  if (!components || components.length === 0) return components === undefined ? undefined : [];
  return components.map((row) => row.toJSON() as APIActionRowComponent<APIButtonComponent>);
}

function serializeEmbeds(embeds: EmbedBuilder[] | undefined): APIEmbed[] | undefined {
  if (!embeds || embeds.length === 0) return embeds === undefined ? undefined : [];
  return embeds.map((e) => e.toJSON());
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

  /**
   * The emojis this application owns (the agent portraits uploaded by `npm run sync-agent-emojis`). Application emojis
   * work in every server the bot is in, with no extra permission. Throws on a Discord error; callers fall back to glyphs.
   */
  async listApplicationEmojis(): Promise<Array<{ id: string; name: string | null }>> {
    const res = (await this.rest.get(Routes.applicationEmojis(this.applicationId))) as { items?: Array<{ id: string; name: string | null }> };
    return res.items ?? [];
  }

  /** Posts a brand-new message to a channel — used by /post-match and the reminder cron job (plain-text roster announcement, or an embed nudge — reminderMessages.ts). */
  async sendChannelMessage(channelId: string, payload: ReplyPayload): Promise<{ id: string }> {
    return (await this.rest.post(Routes.channelMessages(channelId), {
      body: {
        content: payload.content,
        embeds: serializeEmbeds(payload.embeds),
        components: serializeComponents(payload.components),
        // Until 2026-10-02 this was silently dropped: suppressMentions never reached Discord.
        allowed_mentions: allowedMentionsFor(payload),
      },
    })) as { id: string };
  }

  /**
   * Sends a Discord *voice message* (the waveform player), 2026-10-01 (d). Discord's three steps: ask for an
   * upload slot, PUT the Ogg/Opus bytes to it, then post a message with the voice-message flag (8192), the
   * uploaded filename, the duration and a waveform. Such a message can't carry any text.
   */
  async sendVoiceMessage(channelId: string, note: { ogg: Buffer; durationSecs: number; waveform: string }): Promise<{ id: string }> {
    const filename = "voice-message.ogg";
    const slot = (await this.rest.post(`/channels/${channelId}/attachments` as `/${string}`, {
      body: { files: [{ filename, file_size: note.ogg.length, id: "0" }] },
    })) as { attachments?: Array<{ upload_url: string; upload_filename: string }> };
    const target = slot.attachments?.[0];
    if (!target) throw new Error("Discord gave no upload slot for the voice message");
    const put = await fetch(target.upload_url, { method: "PUT", headers: { "Content-Type": "audio/ogg" }, body: new Uint8Array(note.ogg), signal: AbortSignal.timeout(15_000) });
    if (!put.ok) throw new Error(`Voice message upload failed with HTTP ${put.status}`);
    return (await this.rest.post(Routes.channelMessages(channelId), {
      body: {
        flags: 8192, // IS_VOICE_MESSAGE
        attachments: [{ id: "0", filename, uploaded_filename: target.upload_filename, duration_secs: note.durationSecs, waveform: note.waveform }],
      },
    })) as { id: string };
  }

  /** Fallback when the voice-message flow is refused: the same audio as an ordinary .ogg attachment (still playable, just not the voice-message UI). */
  async sendAudioFile(channelId: string, ogg: Buffer, filename = "mari.ogg"): Promise<{ id: string }> {
    return (await this.rest.post(Routes.channelMessages(channelId), {
      body: { attachments: [{ id: 0, filename }] },
      files: [{ name: filename, data: ogg, contentType: "audio/ogg" }],
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
  async sendMentionMessage(channelId: string, content: string, mentionUserId: string, card?: MentionCard): Promise<{ id: string }> {
    // With a card the text lives in the embed (an embed never pings, so the
    // ping stays in `content`); without one it is the plain `<@user> text`.
    const body = card
      ? { content: `<@${mentionUserId}>`, embeds: serializeEmbeds(card.embeds), allowed_mentions: { parse: [], users: [mentionUserId] } }
      : { content: `<@${mentionUserId}> ${content}`, allowed_mentions: { parse: [], users: [mentionUserId] } };
    return (await this.rest.post(Routes.channelMessages(channelId), { body })) as { id: string };
  }

  /** Edits an existing message by id — used by announcementSync.ts (edit/cancel outside a button click). */
  async editChannelMessage(channelId: string, messageId: string, payload: ReplyPayload): Promise<void> {
    await this.rest.patch(Routes.channelMessage(channelId, messageId), {
      body: {
        content: payload.content,
        embeds: serializeEmbeds(payload.embeds),
        components: serializeComponents(payload.components),
        // The schedule card keeps its @mentions in the message text; re-rendering it must never notify anyone again.
        allowed_mentions: allowedMentionsFor(payload),
      },
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
      body: {
        content: payload.content,
        embeds: serializeEmbeds(payload.embeds),
        components: serializeComponents(payload.components),
        allowed_mentions: payload.suppressMentions ? { parse: [] } : undefined,
      },
    });
  }

  /**
   * Removes the deferred placeholder. A command that deferred PUBLICLY (`/mari`
   * — its answer belongs in the channel) but then has an error only the
   * caller should see deletes the placeholder and sends an ephemeral
   * followup instead: a deferral's visibility can't be changed afterwards.
   */
  async deleteOriginalInteractionResponse(interactionToken: string): Promise<void> {
    await this.rest.delete(Routes.webhookMessage(this.applicationId, interactionToken, "@original"));
  }

  /**
   * A public channel message that replies to a specific message (`@Mari` in
   * the server, 2026-09-29). Never pings anyone: `allowed_mentions` is
   * empty, so the reply reference doesn't ping the author either — the
   * threading is visible, no notification storm.
   */
  async sendChannelReply(channelId: string, payload: ReplyPayload, replyToMessageId: string): Promise<{ id: string }> {
    return (await this.rest.post(Routes.channelMessages(channelId), {
      body: {
        content: payload.content,
        message_reference: { message_id: replyToMessageId, fail_if_not_exists: false },
        allowed_mentions: { parse: [], replied_user: false },
      },
    })) as { id: string };
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
        embeds: serializeEmbeds(payload.embeds),
        components: serializeComponents(payload.components),
        flags: payload.ephemeral ? MessageFlags.Ephemeral : undefined,
      },
    });
  }
}
