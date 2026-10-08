import type { Logger } from "../config/logger.js";
import { NO_AGENT_EMOJIS, agentEmojiMapFrom, type AgentEmojiMap } from "../modules/agents/agentEmojis.js";
import type { DiscordRestClient } from "./discordRest.js";

/**
 * The agent portrait emojis, fetched from Discord at most once per `OK_TTL_MS` per process (a warm serverless instance
 * or the gateway worker) and shared by every concurrent caller. A failed lookup is remembered for `FAIL_TTL_MS` so a
 * Discord hiccup costs one request a minute, not one per button press — and yields an empty map, which callers render
 * with role glyphs. This function never throws.
 */
const OK_TTL_MS = 10 * 60_000;
const FAIL_TTL_MS = 60_000;

interface Entry {
  expiresAt: number;
  value: Promise<AgentEmojiMap>;
}
const entries = new WeakMap<object, Entry>();

export async function loadAgentEmojis(discord: Pick<DiscordRestClient, "listApplicationEmojis">, logger?: Pick<Logger, "warn">, now: number = Date.now()): Promise<AgentEmojiMap> {
  const hit = entries.get(discord);
  if (hit && hit.expiresAt > now) return hit.value;

  const value = (async (): Promise<AgentEmojiMap> => {
    try {
      const map = agentEmojiMapFrom(await discord.listApplicationEmojis());
      entries.set(discord, { expiresAt: now + OK_TTL_MS, value: Promise.resolve(map) });
      return map;
    } catch (err) {
      logger?.warn({ event: "agent.emojiLookupFailed", err: err instanceof Error ? err.message : String(err) }, "Couldn't load the agent portrait emojis — using role glyphs");
      entries.set(discord, { expiresAt: now + FAIL_TTL_MS, value: Promise.resolve(NO_AGENT_EMOJIS) });
      return NO_AGENT_EMOJIS;
    }
  })();
  entries.set(discord, { expiresAt: now + FAIL_TTL_MS, value }); // in flight: concurrent callers share this lookup
  return value;
}

/** Forgets the cached lookup (tests, and right after the sync script uploads new emojis in-process). */
export function clearAgentEmojiCache(discord: object): void {
  entries.delete(discord);
}
