import type { MemoryRow, MemoryType } from "../../database/schema/memories.js";
import type { AiMode } from "../ai/aiMode.js";
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
export const MAX_RETRIEVED_MEMORIES = 4;

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
const PREFERRED_TYPES: Record<AiMode, MemoryType[]> = {
  ROAST: ["RUNNING_JOKE", "VALORANT_PREFERENCE", "TEAM_JOKE", "MATCH_EVENT"],
  CELEBRATE: ["RUNNING_JOKE", "VALORANT_PREFERENCE", "TEAM_JOKE", "MATCH_EVENT", "ACHIEVEMENT"],
  CONSOLE: ["PLAYER_PREFERENCE", "PERSONALITY_TRAIT", "MATCH_EVENT", "HABIT", "TEAM_HISTORY"],
};

/** Section 31: CONSOLE "should avoid aggressive roast material" — actively discouraged, not just deprioritized. */
const DISCOURAGED_TYPES: Record<AiMode, MemoryType[]> = {
  ROAST: [],
  CELEBRATE: [],
  CONSOLE: ["RUNNING_JOKE", "TEAM_JOKE"],
};

function modeRelevance(type: MemoryType, mode: AiMode): number {
  if (DISCOURAGED_TYPES[mode].includes(type)) return 0;
  if (PREFERRED_TYPES[mode].includes(type)) return 1;
  return 0.35; // present and plausible, just not this mode's specialty — section 33 is a hybrid score, not a hard type filter
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
const WEIGHTS = { modeRelevance: 2, importance: 1, confidence: 1, recency: 1 };

export function scoreMemory(memory: MemoryRow, mode: AiMode, now: Date = new Date()): number {
  return (
    WEIGHTS.modeRelevance * modeRelevance(memory.type, mode) +
    WEIGHTS.importance * (memory.importance / 100) +
    WEIGHTS.confidence * memory.confidence +
    WEIGHTS.recency * recencyScore(memory.createdAt, now)
  );
}

/**
 * Where a memory is about to be used, not who it's about — both audiences
 * only ever draw from ONE player's own memories (retrieveMemories takes
 * memories for a single player; nothing here ever mixes players).
 * CELEBRATE/ROAST post publicly in the match channel (an `@mention`
 * anyone on the server can read); CONSOLE is a real 1:1 DM with that same
 * player.
 */
export type MemoryAudience = "PUBLIC_CHANNEL" | "PRIVATE_DM";

export function audienceForMode(mode: AiMode): MemoryAudience {
  return mode === "CONSOLE" ? "PRIVATE_DM" : "PUBLIC_CHANNEL";
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
  mode: AiMode;
  forbiddenTopics: string[];
  limit?: number;
  now?: Date;
}): MemoryRow[] {
  const audience = audienceForMode(params.mode);
  const now = params.now ?? new Date();
  const limit = params.limit ?? MAX_RETRIEVED_MEMORIES;

  return params.memories
    .filter((m) => isEligible(m, audience, params.forbiddenTopics))
    .map((m) => ({ memory: m, score: scoreMemory(m, params.mode, now) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.memory);
}
