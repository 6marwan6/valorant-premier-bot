import "dotenv/config";
import { REST, Routes } from "discord.js";
import { loadEnv } from "../config/env.js";
import { logger } from "../config/logger.js";
import { agentEmojiName, agentSmallIconUrl } from "../modules/agents/agentData.js";
import { agentsMissingEmojis } from "../modules/agents/agentEmojis.js";

/**
 * Uploads the agent portraits as Discord *application emojis* so the agent
 * panel and the AGENT SELECT lineup can show them in a row (see
 * modules/agents/agentEmojis.ts for why). One-time, and safe to re-run: agents
 * that already have an emoji are skipped, so after Riot adds an agent you add
 * it to agentData.ts and run this again.
 *
 * The portraits come from valorant-api.com (the same catalogue agentData.ts
 * points at), the small 128px-class icon so it fits Discord's 256 KB emoji limit.
 * Needs only the bot token and client id already in .env. The app picks the new
 * emojis up within ~10 minutes (or on its next cold start).
 *
 * Run with: npm run sync-agent-emojis
 */
const MAX_EMOJI_BYTES = 256 * 1024;

async function main() {
  const env = loadEnv();
  const rest = new REST().setToken(env.DISCORD_BOT_TOKEN);
  const route = Routes.applicationEmojis(env.DISCORD_CLIENT_ID);

  const existing = ((await rest.get(route)) as { items?: Array<{ name: string | null }> }).items ?? [];
  const missing = agentsMissingEmojis(existing.map((e) => e.name ?? ""));
  logger.info({ event: "agentEmojis.start", existing: existing.length, toUpload: missing.length }, "Syncing agent portrait emojis");

  let uploaded = 0;
  let failed = 0;
  for (const agent of missing) {
    try {
      const res = await fetch(agentSmallIconUrl(agent), { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`portrait download failed (HTTP ${res.status})`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > MAX_EMOJI_BYTES) throw new Error(`portrait is ${bytes.length} bytes, over Discord's ${MAX_EMOJI_BYTES} byte emoji limit`);
      await rest.post(route, { body: { name: agentEmojiName(agent.key), image: `data:image/png;base64,${bytes.toString("base64")}` } });
      uploaded++;
      logger.info({ event: "agentEmojis.uploaded", agent: agent.key }, `Uploaded ${agent.name}`);
    } catch (err) {
      failed++;
      logger.warn({ event: "agentEmojis.failed", agent: agent.key, err: err instanceof Error ? err.message : String(err) }, `Couldn't upload ${agent.name}`);
    }
  }

  logger.info({ event: "agentEmojis.complete", uploaded, failed, alreadyThere: existing.length }, "Agent portrait emoji sync finished");
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  logger.error({ event: "agentEmojis.crashed", err: String(err) }, "Agent emoji sync failed");
  process.exit(1);
});
