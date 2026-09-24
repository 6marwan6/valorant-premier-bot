import type { VercelRequest, VercelResponse } from "@vercel/node";
import { loadEnv } from "../../src/config/env.js";
import { logger } from "../../src/config/logger.js";
import { createDatabase } from "../../src/database/client.js";
import { createDiscordRest, DiscordRestClient } from "../../src/discord/discordRest.js";
import { buildAppContext } from "../../src/appContext.js";
import { isAuthorizedCronRequest } from "../../src/services/scheduling/cronAuth.js";
import { runDmReplyPollJob } from "../../src/services/scheduling/dmReplyPollJob.js";

/**
 * Optional external-cron entry point (Phase 7) that picks up replies a
 * player *typed* into a bot DM, as opposed to sent through the 💬 Reply
 * button (which needs no cron at all). Same auth and shape as
 * api/cron/reminders.ts: point cron-job.org / Upstash QStash at it with
 * `Authorization: Bearer <CRON_SECRET>`. A 1-5 minute interval is what makes
 * typed replies feel responsive; see README "Phase 7" for the trade-off
 * (it wakes the database every tick).
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  const env = loadEnv();

  if (!isAuthorizedCronRequest(req.headers.authorization, env.CRON_SECRET)) {
    logger.warn({ event: "cron.unauthorized", route: "dm-replies" }, "Rejected an unauthorized cron request");
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const { db } = createDatabase(env);
  const rest = createDiscordRest(env.DISCORD_BOT_TOKEN);
  const discord = new DiscordRestClient(rest, env.DISCORD_CLIENT_ID);
  const ctx = buildAppContext({ discord, db, env, logger });

  const startedAt = Date.now();
  try {
    const summary = await runDmReplyPollJob(ctx);
    ctx.logger.info(
      { event: "cron.dmReplies.completed", ...summary, latencyMs: Date.now() - startedAt },
      "DM reply poll tick completed",
    );
    res.status(200).json({ ok: true, ...summary });
  } catch (err) {
    ctx.logger.error(
      { event: "cron.dmReplies.failed", err: err instanceof Error ? err.message : String(err), latencyMs: Date.now() - startedAt },
      "DM reply poll tick threw",
    );
    res.status(500).json({ ok: false, error: "internal error" });
  }
}
