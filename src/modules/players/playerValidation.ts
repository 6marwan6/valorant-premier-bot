import type { PlayerRow } from "../../database/schema/players.js";

/**
 * Plan section 8's role example (Duelist) plus section 62's roster sketch
 * (Controller, Initiator, Sentinel) — Valorant's four standard role
 * classes. Presented to admins as Discord command *choices*
 * (SlashCommandBuilder.addStringOption's addChoices) rather than free
 * text, so there's no typo/validation path to get wrong in the first
 * place — see addPlayer.ts / editPlayer.ts.
 */
export const PLAYER_ROLE_CHOICES: Array<{ name: string; value: PlayerRow["role"] }> = [
  { name: "Duelist", value: "DUELIST" },
  { name: "Initiator", value: "INITIATOR" },
  { name: "Controller", value: "CONTROLLER" },
  { name: "Sentinel", value: "SENTINEL" },
];

const MAX_LIST_ITEMS = 12;
const MAX_ITEM_LENGTH = 40;

export interface ParsedListResult {
  ok: true;
  values: string[];
}
export interface ParsedListError {
  ok: false;
  error: string;
}

/**
 * Shared parser for the two free-text comma-separated inputs plan
 * sections 8 and 10 use (`agents`, `protectedTopics`). Deliberately does
 * NOT validate agent names against Valorant's actual current roster —
 * Riot adds/reworks agents over time and this app has no reliable way to
 * keep a hardcoded list current, so the tradeoff is trusting the admin's
 * spelling over silently rejecting a real agent this list doesn't know
 * about yet. What IS enforced: non-empty, de-duplicated (case-insensitive,
 * keeping the first casing seen), and bounded in count/length so a
 * malformed option can't produce something absurd in an AI prompt later
 * (plan section 57: "keep prompts compact").
 */
export function parseCommaSeparatedList(raw: string, fieldLabel: string): ParsedListResult | ParsedListError {
  const seen = new Set<string>();
  const values: string[] = [];

  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (trimmed.length > MAX_ITEM_LENGTH) {
      return { ok: false, error: `Each ${fieldLabel} entry must be ${MAX_ITEM_LENGTH} characters or fewer.` };
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(trimmed);
  }

  if (values.length === 0) {
    return { ok: false, error: `Give at least one ${fieldLabel}, separated by commas.` };
  }
  if (values.length > MAX_LIST_ITEMS) {
    return { ok: false, error: `That's too many ${fieldLabel} entries — keep it to ${MAX_LIST_ITEMS} or fewer.` };
  }

  return { ok: true, values };
}

/**
 * Plan section 8: "Preferred Agent" must actually be one of the player's
 * `agents` (section 8's example: Jett is listed under Agents AND set as
 * Preferred Agent) — never a floating value the rest of the profile
 * doesn't back up. Case-insensitive so "jett" still matches "Jett".
 */
export function validatePreferredAgent(preferredAgent: string, agents: string[]): string | null {
  const match = agents.find((a) => a.toLowerCase() === preferredAgent.trim().toLowerCase());
  if (!match) {
    return `Preferred agent "${preferredAgent}" must be one of the agents you just listed: ${agents.join(", ")}.`;
  }
  return null;
}
