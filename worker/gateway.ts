/**
 * Gateway worker — the ONE always-on piece (plan section 4's 2026-09-29 note).
 *
 * Discord delivers ordinary messages (a DM to the bot, an `@Mari` mention in
 * the server) only over the Gateway, never to an HTTP endpoint, so the
 * serverless app can't see them. This tiny process holds that connection and
 * does nothing else: for each relevant message it calls the SAME services the
 * serverless app uses (ConversationService, MemoryService, ...) against the
 * SAME database, and replies over REST. It owns no state and no logic of its
 * own, and it is optional — if it's down, slash commands, buttons, reminders,
 * the DM Reply button and the cron poller all keep working (plan section 66 #8).
 *
 * Slash commands, buttons and modals are NOT handled here: while an
 * Interactions Endpoint URL is set in the Developer Portal, Discord sends
 * interactions only to that URL, so nothing is ever handled twice.
 *
 * Intents: Guilds + GuildMessages + DirectMessages, none privileged. Discord
 * still includes `content` for messages that mention the bot and for DMs,
 * which is all this needs — so the privileged "Message Content" intent stays
 * OFF. (Worth one manual check on first run: if `@Mari` messages arrive with
 * empty content, enable that intent in the Developer Portal.)
 *
 * Run: `npm run worker` (tsx). Env: the same variables as the Vercel
 * deployment, plus GATEWAY_WORKER=true. See README "Gateway worker".
 */
import http from "node:http";
import { Client, Events, GatewayIntentBits, Partials, ChannelType, type Message } from "discord.js";
import { loadEnv } from "../src/config/env.js";
import { logger } from "../src/config/logger.js";
import { createDatabase } from "../src/database/client.js";
import { createDiscordRest, DiscordRestClient } from "../src/discord/discordRest.js";
import { buildAppContext, type AppContext } from "../src/appContext.js";
import { deliverConversationReply } from "../src/discord/consoleConversation.js";
import { runServerChatTurn } from "../src/discord/serverChat.js";
import { MAX_PLAYER_MESSAGE_CHARS } from "../src/modules/ai/conversationService.js";

const env = loadEnv();
const { db, pool } = createDatabase(env);
const rest = createDiscordRest(env.DISCORD_BOT_TOKEN);
const discord = new DiscordRestClient(rest, env.DISCORD_CLIENT_ID);
const ctx: AppContext = buildAppContext({ discord, db, env: { ...env, GATEWAY_WORKER: true }, logger });

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages],
  // DM channels arrive as partials; without this, DM messages are never emitted.
  partials: [Partials.Channel, Partials.Message],
});

/**
 * One turn at a time per player. Two messages typed in quick succession must
 * be answered in order (the database's source_ref claim prevents duplicates,
 * not reordering), and the second one should see the first one's answer in the
 * transcript.
 */
const queues = new Map<string, Promise<unknown>>();
function enqueue(userId: string, job: () => Promise<void>): Promise<void> {
  const previous = queues.get(userId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(job);
  queues.set(userId, next);
  void next.finally(() => {
    if (queues.get(userId) === next) queues.delete(userId);
  });
  return next;
}

/** Shows "M.A.R.I. is typing…" while the model thinks (refreshed: Discord clears it after ~10 s). */
async function withTyping<T>(message: Message, work: () => Promise<T>): Promise<T> {
  const channel = message.channel;
  const tick = () => {
    if ("sendTyping" in channel) void channel.sendTyping().catch(() => undefined);
  };
  tick();
  const timer = setInterval(tick, 8_000);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

async function handleDm(message: Message): Promise<void> {
  const guildId = env.DISCORD_GUILD_ID;
  const player = await ctx.repositories.players.getByDiscordUserId(guildId, message.author.id);
  if (!player || !player.active) {
    // Not on the roster: say so once, kindly, rather than silently ignoring a person who DMed the bot.
    await discord.sendDirectMessage(message.channelId, {
      content: "I only chat with players on the team roster — ask an admin to add you with `/add-player`.",
    });
    return;
  }

  const text = message.content.trim().slice(0, MAX_PLAYER_MESSAGE_CHARS);
  if (text.length === 0) return; // attachments/stickers only

  const routed = await withTyping(message, () =>
    ctx.services.conversations.routeDmMessage({
      guildId,
      player,
      dmChannelId: message.channelId,
      discordMessageId: message.id,
      text,
    }),
  );

  if (routed.kind === "unavailable") {
    await discord.sendDirectMessage(message.channelId, { content: "I'm not available right now — try again later." });
    return;
  }

  const { outcome, conversation } = routed;
  if (outcome.kind === "reply") {
    const delivered = await deliverConversationReply(ctx, { conversation: outcome.conversation, dmChannelId: message.channelId, outcome });
    logger.info(
      { event: "worker.dm.replied", conversationId: conversation.id, mode: conversation.mode, delivered, source: outcome.source },
      "DM message answered",
    );
  } else if (outcome.kind === "ended") {
    // e.g. a CONSOLE conversation that just timed out mid-flight: the next message opens a fresh chat.
    await discord.sendDirectMessage(message.channelId, { content: "That chat had wrapped up — send me that again and we'll start a fresh one 👋" });
  }
}

async function handleMention(message: Message, botId: string): Promise<void> {
  const guildId = env.DISCORD_GUILD_ID;
  const player = await ctx.repositories.players.getByDiscordUserId(guildId, message.author.id);
  // Silence for non-players: a public reply would just be noise (and would reveal who is/isn't on the roster).
  if (!player || !player.active) return;

  const text = message.content.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim().slice(0, MAX_PLAYER_MESSAGE_CHARS);
  if (text.length === 0) return;

  await withTyping(message, () =>
    runServerChatTurn(ctx, {
      guildId,
      player,
      text,
      sourceRef: `message:${message.id}`,
      deliver: async (reply) => {
        await discord.sendChannelReply(message.channelId, { content: reply }, message.id);
      },
    }),
  );
}

client.on(Events.MessageCreate, (message) => {
  if (message.author.bot || message.system) return;

  const isDm = message.channel.type === ChannelType.DM;
  const botId = client.user?.id;
  if (!botId) return;

  const isMention = !isDm && message.guildId === env.DISCORD_GUILD_ID && message.mentions.users.has(botId) && !message.mentions.everyone;
  if (!isDm && !isMention) return;

  void enqueue(message.author.id, async () => {
    try {
      if (isDm) await handleDm(message);
      else await handleMention(message, botId);
    } catch (err) {
      logger.error({ event: "worker.message.failed", isDm, err: err instanceof Error ? err.message : String(err) }, "Worker failed to handle a message");
    }
  });
});

client.once(Events.ClientReady, (c) => {
  logger.info({ event: "worker.ready", user: c.user.tag }, "Gateway worker connected");
});
client.on(Events.Error, (err) => logger.error({ event: "worker.client.error", err: err.message }, "Discord client error"));
client.on(Events.ShardDisconnect, (event, shardId) => logger.warn({ event: "worker.shard.disconnect", code: event.code, shardId }, "Gateway disconnected (discord.js reconnects on its own)"));

// Some free hosts want something listening on $PORT to consider the app healthy.
if (process.env.PORT) {
  http
    .createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(client.isReady() ? "ok" : "starting");
    })
    .listen(Number(process.env.PORT), () => logger.info({ event: "worker.health.listening", port: process.env.PORT }, "Health endpoint up"));
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ event: "worker.shutdown", signal }, "Shutting down");
  await client.destroy();
  await pool.end().catch(() => undefined);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (err) => logger.error({ event: "worker.unhandledRejection", err: err instanceof Error ? err.message : String(err) }, "Unhandled rejection"));

await client.login(env.DISCORD_BOT_TOKEN);
