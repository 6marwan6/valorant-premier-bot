import {
  InteractionType,
  InteractionResponseType,
  MessageFlags,
  type APIInteraction,
} from "discord-api-types/v10";
import type { AppContext } from "../appContext.js";
import { verifyDiscordRequest } from "./verifyInteraction.js";
import { buildCommandInteractionAdapter, buildButtonInteractionAdapter } from "./httpInteractionAdapter.js";
import { dispatchCommand } from "./interactions/dispatchCommand.js";
import { dispatchButton } from "./interactions/dispatchButton.js";
import {
  handleConsoleReplyModal,
  buildReplyModal,
  unrecognizedReplyButtonResponse,
} from "./consoleConversation.js";
import {
  isConsoleModalCustomId,
  isConsoleReplyCustomId,
  parseConsoleReplyCustomId,
} from "../modules/ai/conversationCustomId.js";

/**
 * The whole request/response cycle for Discord's HTTP Interactions model,
 * decoupled from any specific serverless platform so it can be exercised
 * in tests without a real HTTP request (see
 * tests/unit/handleDiscordInteraction.test.ts and
 * tests/integration/httpInteractionE2E.test.ts). api/interactions.ts is
 * the thin Vercel-specific wrapper around this.
 *
 * The tricky part this function embodies: Discord expects an HTTP
 * response within 3 seconds, but our actual work (DB reads/writes) might
 * occasionally be slower than that under cold-start conditions — Neon and
 * the Vercel function itself can both have cold starts. The fix is
 * Discord's own documented pattern: acknowledge immediately with a
 * "deferred" response type (sent via `sendInitialResponse`, which the
 * caller wires to the actual HTTP response), then keep running in the
 * SAME function invocation to do the real work and deliver the real
 * content via a separate outbound "followup" REST call. Vercel's Node.js
 * runtime keeps an invocation alive until the handler's promise resolves,
 * even after the HTTP response has already been sent — so `await`ing
 * everything below `sendInitialResponse(...)` before this function
 * returns is what keeps the followup from being cut off. (This specific
 * platform behavior is documented Vercel/Node semantics as of this
 * writing but is worth re-verifying against Vercel's current docs at
 * deploy time, since this sandbox has no network access to Vercel to
 * confirm live — see README "Hosting & Deployment".)
 */
export async function handleDiscordInteraction(params: {
  rawBody: string;
  signature: string | string[] | undefined;
  timestamp: string | string[] | undefined;
  publicKey: string;
  buildCtx: () => AppContext;
  sendInitialResponse: (status: number, body: unknown) => void;
}): Promise<void> {
  const valid = await verifyDiscordRequest({
    rawBody: params.rawBody,
    signature: params.signature,
    timestamp: params.timestamp,
    publicKey: params.publicKey,
  });
  if (!valid) {
    // Plan section 55/56: untrusted input is rejected outright, not
    // partially processed. This is the literal front door — see
    // verifyInteraction.ts.
    params.sendInitialResponse(401, { error: "invalid request signature" });
    return;
  }

  let interaction: APIInteraction;
  try {
    interaction = JSON.parse(params.rawBody) as APIInteraction;
  } catch {
    params.sendInitialResponse(400, { error: "invalid JSON body" });
    return;
  }

  // Discord's endpoint-verification handshake: sent once when you first
  // configure the Interactions Endpoint URL in the Developer Portal, and
  // periodically thereafter. Must be answered with a bare PONG — no
  // context, no ctx needed.
  if (interaction.type === InteractionType.Ping) {
    params.sendInitialResponse(200, { type: InteractionResponseType.Pong });
    return;
  }

  if (interaction.type === InteractionType.ApplicationCommand) {
    const ctx = params.buildCtx();
    // Every command in this app replies ephemerally (see README's Phase
    // 1-3 command inventory) — deferring as ephemeral up front means the
    // eventual followup inherits that automatically.
    params.sendInitialResponse(200, {
      type: InteractionResponseType.DeferredChannelMessageWithSource,
      data: { flags: MessageFlags.Ephemeral },
    });
    const adapter = buildCommandInteractionAdapter(interaction as never, ctx.discord);
    await dispatchCommand(adapter, ctx);
    return;
  }

  if (interaction.type === InteractionType.MessageComponent) {
    // Phase 7: the "💬 Reply" button under a private DM. Opening a modal
    // has to be the interaction's very first response (it can't follow a
    // defer), so this is answered here, before any ctx/database work — the
    // conversation id is carried in the custom_id and only checked once the
    // modal is *submitted*.
    if (isConsoleReplyCustomId(interaction.data.custom_id)) {
      const conversationId = parseConsoleReplyCustomId(interaction.data.custom_id);
      params.sendInitialResponse(200, conversationId === null ? unrecognizedReplyButtonResponse() : buildReplyModal(conversationId));
      return;
    }

    const ctx = params.buildCtx();
    // Deferred as an update to the message the button lives on (the
    // public roster) — see rosterMessage.ts / dispatchButton.ts for why
    // errors must go through a separate ephemeral followup instead of
    // resolving this deferred update.
    params.sendInitialResponse(200, { type: InteractionResponseType.DeferredMessageUpdate });
    const adapter = buildButtonInteractionAdapter(interaction as never, ctx.discord);
    await dispatchButton(adapter, ctx);
    return;
  }

  if (interaction.type === InteractionType.ModalSubmit && isConsoleModalCustomId(interaction.data.custom_id)) {
    const ctx = params.buildCtx();
    // The modal was opened from a button on the bot's DM message, so a
    // deferred *update* is valid and lets the handler edit that message
    // (removing its now-answered Reply button) via @original.
    params.sendInitialResponse(200, { type: InteractionResponseType.DeferredMessageUpdate });
    await handleConsoleReplyModal(interaction, ctx);
    return;
  }

  // Autocomplete, other modals, etc. — none exist in this app.
  params.sendInitialResponse(400, { error: "unsupported interaction type" });
}
