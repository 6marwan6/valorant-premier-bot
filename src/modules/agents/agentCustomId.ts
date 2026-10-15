import { ROLE_CODE, roleFromCode, type AgentRole } from "./agentData.js";

/**
 * Custom ids for the agent-pick panel (Discord caps a custom_id at 100
 * characters; these are under 40). Since 2026-10-15 the squad is per schedule,
 * so every id carries the **poll** it is about (it used to carry a slot), plus
 * the role tab the panel is on so a re-render stays on that tab.
 *
 *   squad:<pollId>:r:<role><target>  show this role's agents (target 1 = picking the main, 2 = the second)
 *   squad:<pollId>:p:<agentKey>      pick this agent as my MAIN
 *   squad:<pollId>:q:<agentKey>      pick this agent as my SECOND
 *   squad:<pollId>:t:<role><target>  switch the panel to picking my main (1) or second (2)
 *   squad:<pollId>:x:<role>          clear both my picks
 *   squad:<pollId>:y:<role>          clear only my second
 *   squad:<pollId>:a:<role><target>  open the "add an agent" popup (role = the tab)
 *   squadadd:<pollId>:<role><target> the popup's submit (a modal, not a button)
 *
 * The prefix changed from `agent:` on purpose: a panel left open from before
 * carries a *slot* id, which must never be read as a poll id (see
 * `isLegacyAgentCustomId`). Like the other codecs, parsing returns null for
 * anything malformed instead of throwing.
 */
const PREFIX = "squad";
const MODAL_PREFIX = "squadadd";
const LEGACY_PREFIX = "agent:";

/** Which pick the panel is choosing: the main agent, or the optional second. */
export type PickTarget = "MAIN" | "SECOND";
const TARGET_CODE: Record<PickTarget, string> = { MAIN: "1", SECOND: "2" };
const targetFromCode = (c: string | undefined): PickTarget | null => (c === "1" ? "MAIN" : c === "2" ? "SECOND" : null);

export type AgentAction =
  | { pollId: number; kind: "role"; role: AgentRole; target: PickTarget }
  | { pollId: number; kind: "pick"; agentKey: string; target: PickTarget }
  | { pollId: number; kind: "target"; role: AgentRole; target: PickTarget }
  | { pollId: number; kind: "clear"; role: AgentRole; scope: "ALL" | "SECOND" }
  | { pollId: number; kind: "add"; role: AgentRole; target: PickTarget };

const roleTarget = (role: AgentRole, target: PickTarget) => `${ROLE_CODE[role]}${TARGET_CODE[target]}`;

export const agentRoleId = (pollId: number, role: AgentRole, target: PickTarget) => `${PREFIX}:${pollId}:r:${roleTarget(role, target)}`;
export const agentPickId = (pollId: number, agentKey: string, target: PickTarget) => `${PREFIX}:${pollId}:${target === "MAIN" ? "p" : "q"}:${agentKey}`;
export const agentTargetId = (pollId: number, role: AgentRole, target: PickTarget) => `${PREFIX}:${pollId}:t:${roleTarget(role, target)}`;
export const agentClearId = (pollId: number, role: AgentRole, scope: "ALL" | "SECOND") => `${PREFIX}:${pollId}:${scope === "ALL" ? "x" : "y"}:${ROLE_CODE[role]}`;
export const agentAddId = (pollId: number, role: AgentRole, target: PickTarget) => `${PREFIX}:${pollId}:a:${roleTarget(role, target)}`;
export const agentModalId = (pollId: number, role: AgentRole, target: PickTarget) => `${MODAL_PREFIX}:${pollId}:${roleTarget(role, target)}`;

export const isAgentCustomId = (customId: string) => customId.startsWith(`${PREFIX}:`);
export const isAgentModalCustomId = (customId: string) => customId.startsWith(`${MODAL_PREFIX}:`);
/** A button from a panel posted before the squad became per-schedule (`agent:<slotId>:...`). */
export const isLegacyAgentCustomId = (customId: string) => customId.startsWith(LEGACY_PREFIX);

function positiveInt(raw: string | undefined): number | null {
  const n = Number(raw);
  return raw !== undefined && /^\d+$/.test(raw) && Number.isInteger(n) && n > 0 ? n : null;
}

function parseRoleTarget(arg: string): { role: AgentRole; target: PickTarget } | null {
  if (arg.length !== 2) return null;
  const role = roleFromCode(arg[0]!);
  const target = targetFromCode(arg[1]);
  return role && target ? { role, target } : null;
}

export function parseAgentCustomId(customId: string): AgentAction | null {
  const parts = customId.split(":");
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;
  const pollId = positiveInt(parts[1]);
  if (pollId === null) return null;
  const [, , op, arg] = parts as [string, string, string, string];
  if (op === "p" || op === "q") return /^[a-z0-9]{1,24}$/.test(arg) ? { pollId, kind: "pick", agentKey: arg, target: op === "p" ? "MAIN" : "SECOND" } : null;
  if (op === "x" || op === "y") {
    const role = roleFromCode(arg);
    return role ? { pollId, kind: "clear", role, scope: op === "x" ? "ALL" : "SECOND" } : null;
  }
  const rt = parseRoleTarget(arg);
  if (!rt) return null;
  if (op === "r") return { pollId, kind: "role", ...rt };
  if (op === "t") return { pollId, kind: "target", ...rt };
  if (op === "a") return { pollId, kind: "add", ...rt };
  return null;
}

export function parseAgentModalCustomId(customId: string): { pollId: number; role: AgentRole; target: PickTarget } | null {
  const parts = customId.split(":");
  if (parts.length !== 3 || parts[0] !== MODAL_PREFIX) return null;
  const pollId = positiveInt(parts[1]);
  const rt = parseRoleTarget(parts[2]!);
  return pollId !== null && rt ? { pollId, ...rt } : null;
}
