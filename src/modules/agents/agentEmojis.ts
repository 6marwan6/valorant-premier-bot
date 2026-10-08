import { AGENTS, AGENT_EMOJI_PREFIX, agentByKey, agentEmojiName } from "./agentData.js";

/**
 * Agent portraits as Discord *application emojis* (2026-10-07).
 *
 * Why: an embed can only show one picture, and embeds stack vertically, so a row of agent portraits "like the Valorant
 * select screen" can't be built from embeds. A custom emoji can sit inline anywhere — in a field name, in a message,
 * on a button — so a row of agents *can* carry their portraits. They are uploaded once by `npm run sync-agent-emojis`
 * and looked up at runtime (see discord/agentEmojiCache.ts).
 *
 * Everything here is optional: with no emojis uploaded (or Discord unreachable) callers get an empty map and fall back
 * to the role glyph, so a missing emoji can never break a panel, a vote or a pick (plan section 48 / principle #8).
 */
export interface AgentEmoji {
  id: string;
  name: string;
}

/** Agent key (`jett`) -> its uploaded portrait emoji. */
export type AgentEmojiMap = ReadonlyMap<string, AgentEmoji>;

export const NO_AGENT_EMOJIS: AgentEmojiMap = new Map();

/** Keeps only the emojis this app uploaded for known built-in agents (`agent_<key>`); everything else the application owns is ignored. */
export function agentEmojiMapFrom(list: ReadonlyArray<{ id?: string | null; name?: string | null }>): AgentEmojiMap {
  const map = new Map<string, AgentEmoji>();
  for (const e of list) {
    if (!e.id || !e.name || !/^\d{5,25}$/.test(e.id) || !e.name.startsWith(AGENT_EMOJI_PREFIX)) continue;
    const key = e.name.slice(AGENT_EMOJI_PREFIX.length);
    if (agentByKey(key)) map.set(key, { id: e.id, name: e.name });
  }
  return map;
}

/** `<:agent_jett:123>` — how the emoji is written inside message text. */
export const emojiMarkup = (e: AgentEmoji) => `<:${e.name}:${e.id}>`;

/** What stands in front of an agent's name: its portrait emoji when one is uploaded, else the role glyph. */
export function agentIconText(key: string, fallback: string, emojis: AgentEmojiMap | undefined): string {
  const e = emojis?.get(key);
  return e ? emojiMarkup(e) : fallback;
}

/** Which built-in agents still need a portrait uploaded, given the names of the emojis the application already owns. */
export function agentsMissingEmojis(existingNames: Iterable<string>): typeof AGENTS {
  const have = new Set(existingNames);
  return AGENTS.filter((a) => !have.has(agentEmojiName(a.key)));
}
