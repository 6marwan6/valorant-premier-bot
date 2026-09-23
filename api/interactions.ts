import type { VercelRequest, VercelResponse } from "@vercel/node";
import { waitUntil } from "@vercel/functions";
import { loadEnv } from "../src/config/env.js";
import { logger } from "../src/config/logger.js";
import { createDatabase } from "../src/database/client.js";
import { createDiscordRest, DiscordRestClient } from "../src/discord/discordRest.js";
import { buildAppContext } from "../src/appContext.js";
import { handleDiscordInteraction } from "../src/discord/handleDiscordInteraction.js";

// Disables Vercel's automatic JSON body parsing. Discord's signature is
// computed over the exact raw request bytes (timestamp + body) — a
// re-serialized `JSON.stringify(req.body)` is not guaranteed to be
// byte-identical to what Discord actually sent (key order, whitespace),
// which would make every request fail verification. See
// src/discord/verifyInteraction.ts.
export const config = {
  api: {
    bodyParser: false,
  },
};

async function readRawBody(req: VercelRequest): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  const rawBody = await readRawBody(req);
  const env = loadEnv();

  // Lazily constructed: only spun up once the request has passed
  // signature verification inside handleDiscordInteraction, so an
  // unauthenticated request never causes a database connection.
  const buildCtx = () => {
    const { db } = createDatabase(env);
    const rest = createDiscordRest(env.DISCORD_BOT_TOKEN);
    const discord = new DiscordRestClient(rest, env.DISCORD_CLIENT_ID);
    return buildAppContext({ discord, db, env, logger });
  };

  const startedAt = Date.now();
  let markAcked!: () => void;
  const acked = new Promise<void>((resolve) => {
    markAcked = resolve;
  });

  const work = handleDiscordInteraction({
    rawBody,
    signature: req.headers["x-signature-ed25519"],
    timestamp: req.headers["x-signature-timestamp"],
    publicKey: env.DISCORD_PUBLIC_KEY,
    buildCtx,
    sendInitialResponse: (status, body) => {
      res.status(status).json(body);
      logger.info(
        { event: "interaction.ack.sent", status, latencyMs: Date.now() - startedAt },
        "Initial response sent to Discord",
      );
      markAcked();
    },
   })
    .then(() => {
      logger.info(
        { event: "interaction.work.finished", latencyMs: Date.now() - startedAt },
        "Interaction work finished",
      );
    })
    .catch((err) => {
      logger.error(
        {
          event: "interaction.work.failed",
          latencyMs: Date.now() - startedAt,
          err: err instanceof Error ? err.message : String(err),
        },
        "Interaction work threw",
      );
      if (!res.headersSent) res.status(500).json({ error: "internal error" });
    })
    .finally(markAcked);

  // Keeps the invocation alive for the post-ack work (DB + followup PATCH).
  waitUntil(work);
  // Return as soon as Discord has its ack; `work` continues under waitUntil.
  await acked;
}
