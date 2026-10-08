import { AGENTS, agentEmojiName, agentIconUrl, type AgentInfo } from "./agentData.js";
import { agentsMissingEmojis } from "./agentEmojis.js";

/**
 * The logic behind `npm run sync-agent-emojis`, with every outside call (valorant-api, image resizing, Discord)
 * passed in so it can be tested without a network.
 *
 * Image URLs are read from valorant-api's own metadata for each agent instead of being guessed (a guessed
 * `displayiconsmall.png` 404'd for every agent — 2026-10-08). The candidates are tried in order, and the app's own
 * known-good thumbnail URL is the last resort. Whatever is downloaded is resized to a 128x128 PNG before upload, so
 * Discord's 256 KB emoji limit never depends on which source image we happened to get.
 */
export const MAX_EMOJI_BYTES = 256 * 1024;
export const EMOJI_PIXELS = 128;

/** The image URLs valorant-api.com reports for an agent (`GET /v1/agents/<uuid>` → `data`). */
export interface AgentImageMeta {
  displayIconSmall?: string | null;
  displayIcon?: string | null;
  killfeedPortrait?: string | null;
}

/** Candidate portrait URLs, best first (a head-and-shoulders icon), https only, no duplicates. */
export function portraitCandidates(agent: Pick<AgentInfo, "uuid">, meta: AgentImageMeta | null): string[] {
  const urls = [meta?.displayIconSmall, meta?.displayIcon, meta?.killfeedPortrait, agentIconUrl(agent)];
  return [...new Set(urls.filter((u): u is string => typeof u === "string" && u.startsWith("https://")))];
}

export interface SyncDeps {
  /** Names of the emojis the application already owns. */
  existingNames: readonly string[];
  /** valorant-api metadata for one agent; may throw (the agent is then tried with the fallback URL only). */
  fetchMeta(uuid: string): Promise<AgentImageMeta>;
  /** Downloads an image; throws with a message like "HTTP 404" when it can't. */
  fetchBytes(url: string): Promise<Buffer>;
  /** Turns any downloaded image into the PNG that gets uploaded (resized to EMOJI_PIXELS). */
  toEmojiPng(bytes: Buffer): Promise<Buffer>;
  /** Creates the application emoji. Throws on a Discord error. */
  upload(name: string, png: Buffer): Promise<void>;
  onProgress?(event: { agent: string; ok: boolean; detail: string }): void;
}

export interface SyncResult {
  uploaded: string[];
  failed: Array<{ agent: string; reason: string }>;
  alreadyThere: number;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function syncAgentEmojis(deps: SyncDeps): Promise<SyncResult> {
  const missing = agentsMissingEmojis(deps.existingNames);
  const result: SyncResult = { uploaded: [], failed: [], alreadyThere: AGENTS.length - missing.length };

  for (const agent of missing) {
    const fail = (reason: string) => {
      result.failed.push({ agent: agent.key, reason });
      deps.onProgress?.({ agent: agent.key, ok: false, detail: reason });
    };

    let meta: AgentImageMeta | null = null;
    try {
      meta = await deps.fetchMeta(agent.uuid);
    } catch {
      // fall through: the fallback URL is still tried
    }

    const problems: string[] = [];
    let png: Buffer | null = null;
    for (const url of portraitCandidates(agent, meta)) {
      try {
        const out = await deps.toEmojiPng(await deps.fetchBytes(url));
        if (out.length > MAX_EMOJI_BYTES) throw new Error(`resized image is still ${out.length} bytes`);
        png = out;
        break;
      } catch (err) {
        problems.push(`${url.split("/").pop()}: ${msg(err)}`);
      }
    }
    if (!png) {
      fail(`no usable image (${problems.join("; ") || "no candidates"})`);
      continue;
    }

    try {
      await deps.upload(agentEmojiName(agent.key), png);
      result.uploaded.push(agent.key);
      deps.onProgress?.({ agent: agent.key, ok: true, detail: `${png.length} bytes` });
    } catch (err) {
      fail(`Discord rejected the upload: ${msg(err)}`);
    }
  }
  return result;
}
