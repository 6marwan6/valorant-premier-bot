import type { MemoryRow, MemoryType } from "../../database/schema/memories.js";
import type { ConversationMode } from "../ai/aiMode.js";
import { mentionsForbiddenTopic } from "../ai/aiOutput.js";

/**
 * Plan section 30's pipeline, minus the semantic-retrieval step (design
 * principle #11: "introduce vector search ... only when the actual
 * product needs them" — a 6-7 person team with a consent-first, in-
 * conversation-only writer (Phase 8) will have a handful of memories per
 * player, not a corpus that needs an embedding index):
 *
 *   Current event -> structured filtering (mode/type) -> candidate
 *   memories -> ranking (section 33) -> privacy filtering -> top relevant
 *   context
 *
 * Privacy filtering actually runs FIRST here, not last — there is no
 * reason to rank, then limit, then discard something that could never be
 * shown in the first place; `retrieveMemories` below does eligibility,
 * then scoring, then the limit, in that order.
 *
 * This module only decides *which* memories, ranked how — it never talks
 * to the database (that's MemoryRepository.listByPlayer, plan section 43's
 * existing reader, reused rather than duplicated) and never renders a
 * prompt (that's aiContextBuilder.ts / conversationContextBuilder.ts).
 * Same three-way split the rest of this codebase already uses for
 * everything AI-adjacent.
 */

/** Plan sections 32/57: "Only the highest-value memories should reach the LLM" — keep prompts compact. */
export const MAX_RETRIEVED_MEMORIES = 2;

/**
 * Ceiling for a free-form chat turn (2026-09-30). This is a CEILING, not a
 * target: with the relevance gate below, a turn usually has zero or one
 * memory that actually connects to what the player just said. It used to
 * be 10 and always filled, which is exactly what made Mari cram facts into
 * every reply (plan sections 30/32: "only the highest-value memories should
 * reach the LLM" — nothing says the list must be full).
 */
export const MAX_RETRIEVED_CHAT_MEMORIES = 3;

/**
 * Relevance gate (2026-09-30). When retrieval is given the player's recent
 * message text, a memory only qualifies if `keywordOverlap` reaches this
 * floor — i.e. it shares at least one meaningful word with what was just
 * said (one shared word out of a 4+-word message = 0.25). A greeting or
 * "lol" has no meaningful words, so nothing qualifies and the prompt carries
 * no memories at all. Section 33 is a *hybrid score*; this adds the missing
 * "is it about this at all?" question in front of it, so the recency /
 * importance / confidence terms rank only among memories that pass.
 * The overlap function is the single seam to replace with embedding
 * similarity later (section 32) — nothing else here would need to change.
 */
export const MIN_QUERY_RELEVANCE = 0.25;

export function retrievalLimitFor(mode: ConversationMode): number {
  return mode === "DIRECT_CHAT" || mode === "SERVER_CHAT" ? MAX_RETRIEVED_CHAT_MEMORIES : MAX_RETRIEVED_MEMORIES;
}

/** Plan section 33's ranking formula has a recency term but no prescribed decay; a 3-week half-life keeps last week's stuff clearly ahead of last month's without last season's dropping to zero. */
const RECENCY_HALF_LIFE_DAYS = 21;

/**
 * Section 31's own worked examples, verbatim, for the two modes it gives:
 * ROAST prefers "RUNNING_JOKE, VALORANT_PREFERENCE, TEAM_JOKE,
 * MATCH_EVENT"; CONSOLE prefers "PLAYER_PREFERENCE, PERSONALITY_TRAIT,
 * relevant recent events" (read here as MATCH_EVENT, plus HABIT/
 * TEAM_HISTORY — the same "who this player is" register PERSONALITY_TRAIT
 * is) "and should avoid aggressive roast material" (RUNNING_JOKE/
 * TEAM_JOKE — see DISCOURAGED_TYPES below, a harder down-weight than
 * merely "not preferred"). Section 31 doesn't give CELEBRATE its own list;
 * it's ROAST's closest sibling — same single-shot, banter-flavored reply,
 * just the positive side of it (section 18's own example: "Team XYZ has
 * officially been warned") — so it reuses ROAST's set plus ACHIEVEMENT,
 * hype fuel a roast has no use for.
 */
const PREFERRED_TYPES: Record<ConversationMode, MemoryType[]> = {
  ROAST: ["RUNNING_JOKE", "VALORANT_PREFERENCE", "TEAM_JOKE", "MATCH_EVENT"],
  CELEBRATE: ["RUNNING_JOKE", "VALORANT_PREFERENCE", "TEAM_JOKE", "MATCH_EVENT", "ACHIEVEMENT"],
  CONSOLE: ["PLAYER_PREFERENCE", "PERSONALITY_TRAIT", "MATCH_EVENT", "HABIT", "TEAM_HISTORY"],
  // DIRECT_CHAT (2026-09-28): free-form chat has no single specialty the
  // way a reaction to a specific attendance answer does, so every type is
  // an equally plausible fit — an empty preferred-set with modeRelevance's
  // 0.35 default for everything, same as any type in any OTHER mode that
  // isn't that mode's specialty (see modeRelevance below).
  DIRECT_CHAT: [],
  SERVER_CHAT: [], // same reasoning as DIRECT_CHAT — a free chat has no single specialty
};

/** Section 31: CONSOLE "should avoid aggressive roast material" — actively discouraged, not just deprioritized. */
const DISCOURAGED_TYPES: Record<ConversationMode, MemoryType[]> = {
  ROAST: [],
  CELEBRATE: [],
  CONSOLE: ["RUNNING_JOKE", "TEAM_JOKE"],
  DIRECT_CHAT: [], // banter is exactly as welcome here as anywhere else the player initiates it
  SERVER_CHAT: [],
};

function modeRelevance(type: MemoryType, mode: ConversationMode): number {
  if (DISCOURAGED_TYPES[mode].includes(type)) return 0;
  if (PREFERRED_TYPES[mode].includes(type)) return 1;
  return 0.35; // present and plausible, just not this mode's specialty — section 33 is a hybrid score, not a hard type filter
}

/**
 * Section 33's `semantic_similarity` term, without embeddings (design
 * principle #11): the share of the player's latest message's meaningful
 * words that also appear in the memory. Crude on purpose — enough to float
 * "the memory about my exam" above "the memory about Jett" when the player
 * says "I have my exam tomorrow", nothing more. Only ever used in the
 * free-form chats, where there IS a message to compare against.
 */
const STOP_WORDS = new Set([
  "the", "and", "for", "that", "this", "with", "you", "your", "are", "was", "were", "have", "has", "had", "but", "not",
  "what", "when", "where", "who", "why", "how", "can", "just", "like", "about", "from", "they", "them", "then", "than",
  "there", "their", "will", "would", "could", "should", "its", "too", "very", "really", "got", "get", "out", "into",
  "did", "does", "tell", "say", "said", "know", "think", "much", "some", "any", "all", "one", "now", "also", "yes", "yeah",
  "okay", "please", "mari", "hey", "hello", "lol", "gonna", "going",
  // Words that appear in nearly every Valorant-team memory: matching on them says nothing about *this* message.
  "game", "games", "play", "plays", "played", "playing", "valorant", "match", "matches", "team", "tonight", "today",
  "player", "always", "every", "sometimes", "often", "frequently",
]);

/** Light suffix stripping so "exams"/"exam" and "streaming"/"streams" line up. Not a real stemmer, on purpose. */
function stem(word: string): string {
  for (const suffix of ["ing", "ed", "es", "s"]) {
    if (word.length >= suffix.length + 4 && word.endsWith(suffix)) return word.slice(0, -suffix.length);
  }
  return word;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u00c0-\uffff]+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
    .map(stem);
}

export function keywordOverlap(memoryContent: string, queryText: string | undefined): number {
  if (!queryText) return 0;
  const query = new Set(tokenize(queryText));
  if (query.size === 0) return 0;
  const memoryTokens = new Set(tokenize(memoryContent));
  let hits = 0;
  for (const word of query) if (memoryTokens.has(word)) hits++;
  return Math.min(1, hits / Math.min(query.size, 4)); // 4+ shared words is already a strong match
}

function recencyScore(createdAt: Date, now: Date): number {
  const ageDays = Math.max(0, (now.getTime() - createdAt.getTime()) / 86_400_000);
  return Math.exp(-ageDays / RECENCY_HALF_LIFE_DAYS);
}

/**
 * Section 33's conceptual formula, semantic_similarity term dropped (no
 * embeddings — see the module doc comment): mode relevance is weighted
 * highest, matching section 31's framing of type-preference as the
 * PRIMARY structured filter with the rest as secondary tie-breakers — but
 * it is still only a weight, not a hard cut, except where
 * DISCOURAGED_TYPES makes it exactly 0: a highly important, highly
 * confident, very recent memory of a non-preferred type can still edge
 * out a stale, low-importance preferred one. `importance` and
 * `confidence` are already stored in `[0, 1]`-compatible ranges (section
 * 23; `importance` is 0-100, normalized here). Exported so a future
 * tuning pass (section 33: "implemented and tuned after the basic system
 * works") has one function to change, and so tests can pin its shape
 * directly instead of only through end-to-end retrieval output.
 */
const WEIGHTS = { modeRelevance: 2, importance: 1, confidence: 1, recency: 1, keyword: 2 };

export function scoreMemory(memory: MemoryRow, mode: ConversationMode, now: Date = new Date(), queryText?: string): number {
  return (
    WEIGHTS.keyword * keywordOverlap(memory.content, queryText) +
    WEIGHTS.modeRelevance * modeRelevance(memory.type, mode) +
    WEIGHTS.importance * (memory.importance / 100) +
    WEIGHTS.confidence * memory.confidence +
    WEIGHTS.recency * recencyScore(memory.createdAt, now)
  );
}

/**
 * Where a memory is about to be used, not who it's about — both audiences
 * draw from ONE player's own memories at a time (retrieveMemories takes
 * memories for a single player; a server chat's separate "teammates'
 * shared memories" block goes through `isEligible` per owner instead —
 * see modules/ai/teamFactsService.ts).
 * CELEBRATE/ROAST post publicly in the match channel (an `@mention`
 * anyone on the server can read); CONSOLE is a real 1:1 DM with that same
 * player.
 */
export type MemoryAudience = "PUBLIC_CHANNEL" | "PRIVATE_DM";

export function audienceForMode(mode: ConversationMode): MemoryAudience {
  // CONSOLE and DIRECT_CHAT (2026-09-28) are both real 1:1 DMs; every other mode
  // (CELEBRATE/ROAST, and SERVER_CHAT since 2026-09-29) is readable by the whole server.
  return mode === "CONSOLE" || mode === "DIRECT_CHAT" ? "PRIVATE_DM" : "PUBLIC_CHANNEL";
}

/**
 * Plan section 10's flow ("Apply privacy/protection filters -> Remove
 * prohibited memories") and section 44 rule 1 ("Private information
 * should never automatically become public AI content") — rule 1,
 * concretely: a PRIVATE memory (Phase 8's only writer, `memoryService.ts`'s
 * `autoSave`, always saves PRIVATE) is only ever eligible for the audience
 * it was written for — the player's own private conversation — never for
 * a PUBLIC_CHANNEL audience, no matter how relevant it would be. PROTECTED
 * is never eligible for either (section 24: "Never provided to the LLM").
 * `forbiddenTopics` is re-checked here, at read time, using the exact same
 * matcher aiOutput.ts uses at write time (`mentionsForbiddenTopic`) — a
 * player who protects a topic AFTER a memory about it was already saved
 * is protected retroactively, without anything having to go back and
 * rewrite or delete the old row.
 */
export function isEligible(memory: MemoryRow, audience: MemoryAudience, forbiddenTopics: string[]): boolean {
  if (!memory.aiUsable) return false;
  if (memory.visibility === "PROTECTED") return false;
  if (audience === "PUBLIC_CHANNEL" && memory.visibility === "PRIVATE") return false;
  if (mentionsForbiddenTopic(memory.content, forbiddenTopics)) return false;
  return true;
}

/**
 * The whole pipeline for one player's already-fetched memories
 * (MemoryRepository.listByPlayer — a 6-7 person team's per-player memory
 * count doesn't justify pushing any of this into SQL; see the module doc
 * comment). Eligibility first, so ranking and the limit never spend effort
 * on something that was going to be discarded anyway.
 */
export function retrieveMemories(params: {
  memories: MemoryRow[];
  mode: ConversationMode;
  forbiddenTopics: string[];
  limit?: number;
  now?: Date;
  /**
   * What the player just said, for anything that has a message to react to
   * (the chats and CONSOLE replies). When this is a string — even an empty
   * one — the relevance gate applies: a memory has to actually connect to it
   * (`MIN_QUERY_RELEVANCE`) or it is left out, however high it would rank.
   * Left `undefined` (CELEBRATE/ROAST react to a button click, there is no
   * text), ranking is exactly what it was and the caller decides whether to
   * retrieve at all.
   */
  queryText?: string;
}): MemoryRow[] {
  const audience = audienceForMode(params.mode);
  const now = params.now ?? new Date();
  const limit = params.limit ?? retrievalLimitFor(params.mode);
  const gated = params.queryText !== undefined;

  return params.memories
    .filter((m) => isEligible(m, audience, params.forbiddenTopics))
    .filter((m) => !gated || isRelevantTo(m.content, params.queryText))
    .map((m) => ({ memory: m, score: scoreMemory(m, params.mode, now, params.queryText) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.memory);
}

/** The relevance gate on its own: does this text connect to what was just said? Also used for teammates' shared memories (teamFactsService.ts). */
export function isRelevantTo(content: string, queryText: string | undefined): boolean {
  return keywordOverlap(content, queryText) >= MIN_QUERY_RELEVANCE;
}

/**
 * Every memory the audience may see at all (no ranking, no limit) — what a
 * "forget that" request is allowed to point at. Same three privacy gates as
 * retrieval; kept as its own export so "what can be shown" and "what can be
 * forgotten from here" can never drift apart.
 */
export function listEligible(params: { memories: MemoryRow[]; mode: ConversationMode; forbiddenTopics: string[] }): MemoryRow[] {
  const audience = audienceForMode(params.mode);
  return params.memories.filter((m) => isEligible(m, audience, params.forbiddenTopics));
}
