import type { AgentPickRow, ScheduleSlotRow } from "../../database/schema/schedules.js";
import { effectiveAt } from "../schedules/scheduleLogic.js";

/**
 * Reading a schedule's squad (2026-10-15: one squad per schedule). Every message
 * that shows who plays what goes through these, so "main + optional second, the
 * same for every slot" is defined in exactly one place. Pure.
 */

export interface SquadEntry {
  main: string | null;
  second: string | null;
}

/** user id -> their MAIN and SECOND agent keys. A player with no picks has no entry. */
export function squadOf(picks: readonly AgentPickRow[]): Map<string, SquadEntry> {
  const out = new Map<string, SquadEntry>();
  for (const p of picks) {
    const entry = out.get(p.discordUserId) ?? { main: null, second: null };
    if (p.kind === "MAIN") entry.main = p.agentKey;
    else entry.second = p.agentKey;
    out.set(p.discordUserId, entry);
  }
  return out;
}

/** agent key -> the player who holds it as their MAIN (a main is unique across the squad). */
export function mainHolders(picks: readonly AgentPickRow[]): Map<string, string> {
  return new Map(picks.filter((p) => p.kind === "MAIN").map((p) => [p.agentKey, p.discordUserId]));
}

/**
 * The map the squad plays on. A schedule is one map for the week, set when it is
 * created, so this is normally just that map. If an admin later gave different
 * slots different maps, the first slot still ahead decides (it is the first
 * match) and `mixed` says the others differ, so messages can point that out
 * instead of silently showing one.
 */
export function squadMap(slots: readonly ScheduleSlotRow[], now: Date): { map: string | null; mixed: boolean } {
  const upcoming = slots.filter((s) => effectiveAt(s).getTime() > now.getTime());
  const considered = upcoming.length > 0 ? upcoming : slots;
  const maps = considered.map((s) => s.map ?? null);
  const first = maps.find((m) => m !== null) ?? null;
  return { map: first, mixed: new Set(maps).size > 1 };
}
