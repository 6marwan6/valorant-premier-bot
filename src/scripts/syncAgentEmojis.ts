import "dotenv/config";
import { REST, Routes } from "discord.js";
import { loadEnv } from "../config/env.js";
import { logger } from "../config/logger.js";
import { AGENTS, agentEmojiName } from "../modules/agents/agentData.js";
import { EMOJI_PIXELS, syncAgentEmojis, type AgentImageMeta } from "../modules/agents/agentEmojiSync.js";

/**
 * Uploads the agent portraits as Discord *application emojis* so the agent
 * panel and the AGENT SELECT lineup can show them in a row (see
 * modules/agents/agentEmojis.ts for why). One-time, and safe to re-run: agents
 * that already have an emoji are skipped, so after Riot adds an agent you add
 * it to agentData.ts and run this again.
 *
 * Each agent's image URLs come from valorant-api.com, and the image is resized
 * to a 128x128 PNG here (with `sharp`, a dev dependency — this script runs on
 * your machine, not in the deployed app). Needs only the bot token and client
 * id already in .env. The app picks the new emojis up within ~10 minutes.
 *
 * Run with: npm run sync-agent-emojis
 */
async function main() {
  const env = loadEnv();
  const rest = new REST().setToken(env.DISCORD_BOT_TOKEN);
  const route = Routes.applicationEmojis(env.DISCORD_CLIENT_ID);

  const sharp = (await import("sharp")).default;
  const existing = ((await rest.get(route)) as { items?: Array<{ name: string | null }> }).items ?? [];
  logger.info({ event: "agentEmojis.start", existing: existing.length, agents: AGENTS.length }, "Syncing agent portrait emojis");

  const result = await syncAgentEmojis({
    existingNames: existing.map((e) => e.name ?? ""),
    async fetchMeta(uuid) {
      const res = await fetch(`https://valorant-api.com/v1/agents/${uuid}`, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return ((await res.json()) as { data?: AgentImageMeta }).data ?? {};
    },
    async fetchBytes(url) {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    },
    toEmojiPng: (bytes) =>
      sharp(bytes).resize(EMOJI_PIXELS, EMOJI_PIXELS, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png({ compressionLevel: 9 }).toBuffer(),
    async upload(name, png) {
      await rest.post(route, { body: { name, image: `data:image/png;base64,${png.toString("base64")}` } });
    },
    onProgress: ({ agent, ok, detail }) =>
      ok ? logger.info({ event: "agentEmojis.uploaded", agent }, `Uploaded ${agent} (${detail})`) : logger.warn({ event: "agentEmojis.failed", agent, err: detail }, `Couldn't upload ${agent}`),
  });

  logger.info({ event: "agentEmojis.complete", uploaded: result.uploaded.length, failed: result.failed.length, alreadyThere: result.alreadyThere }, "Agent portrait emoji sync finished");
  if (result.failed.length > 0) {
    // Repeat the reasons at the very end so they are not lost above 29 lines of progress.
    console.error(`\n${result.failed.length} failed:\n${result.failed.map((f) => `  ${f.agent}: ${f.reason}`).join("\n")}`);
    process.exit(1);
  }
}

main().catch((err) => {
  logger.error({ event: "agentEmojis.crashed", err: String(err) }, "Agent emoji sync failed");
  process.exit(1);
});
