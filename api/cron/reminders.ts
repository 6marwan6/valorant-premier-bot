import type { VercelRequest, VercelResponse } from "@vercel/node";
import { loadEnv } from "../../src/config/env.js";
import { logger } from "../../src/config/logger.js";
import { createDatabase } from "../../src/database/client.js";
import { createDiscordRest, DiscordRestClient } from "../../src/discord/discordRest.js";
import { buildAppContext } from "../../src/appContext.js";
import { isAuthorizedCronRequest } from "../../src/services/scheduling/cronAuth.js";
import { runReminderCronJob } from "../../src/services/scheduling/reminderCronJob.js";

/**
 * The external cron entry point (plan section 6: "scheduled/cron
 * execution"; README "Hosting & Deployment": Vercel's own free-tier cron
 * only fires once a day, too coarse for section 13's minutes-apart
 * reminders, so an external scheduler — cron-job.org or Upstash QStash —
 * hits this URL directly instead). Point it here on a short interval
 * (every 5-15 minutes is plenty for a 6-7 person team's reminder
 * granularity) with header `Authorization: Bearer <CRON_SECRET>`.
 *
 * Deliberately its own file/route rather than folded into
 * api/interactions.ts or made a generic "?job=" dispatcher: each cron job
 * this project adds (Phase 8's message-poll job, eventually) gets its own
 * URL, its own schedule in the external cron dashboard, and its own
 * maxDuration in vercel.json — plain Vercel file-based routing already
 * gives us that for free. What *is* shared across jobs is the auth check
 * (cronAuth.ts) and the AppContext-building boilerplate below, copied
 * from api/interactions.ts's own lazy-ctx pattern.
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  const env = loadEnv();

  if (!isAuthorizedCronRequest(req.headers.authorization, env.CRON_SECRET)) {
    logger.warn({ event: "cron.unauthorized", route: "reminders" }, "Rejected an unauthorized cron request");
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const { db } = createDatabase(env);
  const rest = createDiscordRest(env.DISCORD_BOT_TOKEN);
  const discord = new DiscordRestClient(rest, env.DISCORD_CLIENT_ID);
  const ctx = buildAppContext({ discord, db, env, logger });

  const startedAt = Date.now();
  try {
    const summary = await runReminderCronJob(ctx);
    ctx.logger.info(
      { event: "cron.reminders.completed", ...summary, latencyMs: Date.now() - startedAt },
      "Reminders cron tick completed",
    );
    res.status(200).json({ ok: true, ...summary });
  } catch (err) {
    // Plan section 48/49: a cron failure must never look like a success,
    // but it also must never crash the process — Vercel functions always
    // return a response either way, and the external scheduler will just
    // retry on its own next interval.
    ctx.logger.error(
      { event: "cron.reminders.failed", err: err instanceof Error ? err.message : String(err), latencyMs: Date.now() - startedAt },
      "Reminders cron tick threw",
    );
    res.status(500).json({ ok: false, error: "internal error" });
  }
}
