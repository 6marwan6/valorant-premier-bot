import { ROLE_CODE, roleFromCode, type AgentRole } from "./agentData.js";

/**
 * Custom ids for the agent-pick panel (Discord caps a custom_id at 100
 * characters; these are under 40). Every id carries the slot it is about, and
 * the role tab the panel is on so a re-render stays on that tab.
 *
 *   agent:<slotId>:r:<D|I|C|S>   show this role's agents
 *   agent:<slotId>:p:<agentKey>  pick this agent
 *   agent:<slotId>:x:<role>      clear my pick
 *   agent:<slotId>:a:<role>      open the "add an agent" popup (role = the tab)
 *   agent:<slotId>:s:<role>      switch to my next slot
 *   agentadd:<slotId>:<role>     the popup's submit (a modal, not a button)
 *
 * Like the other codecs (attendance/customId.ts, schedules/scheduleCustomId.ts)
 * parsing returns null for anything malformed instead of throwing.
 */
const PREFIX = "agent";
const MODAL_PREFIX = "agentadd";

export type AgentAction =
  | { slotId: number; kind: "role"; role: AgentRole }
  | { slotId: number; kind: "pick"; agentKey: string }
  | { slotId: number; kind: "clear"; role: AgentRole }
  | { slotId: number; kind: "add"; role: AgentRole }
  | { slotId: number; kind: "switch"; role: AgentRole };

export const agentRoleId = (slotId: number, role: AgentRole) => `${PREFIX}:${slotId}:r:${ROLE_CODE[role]}`;
export const agentPickId = (slotId: number, agentKey: string) => `${PREFIX}:${slotId}:p:${agentKey}`;
export const agentClearId = (slotId: number, role: AgentRole) => `${PREFIX}:${slotId}:x:${ROLE_CODE[role]}`;
export const agentAddId = (slotId: number, role: AgentRole) => `${PREFIX}:${slotId}:a:${ROLE_CODE[role]}`;
export const agentSwitchId = (slotId: number, role: AgentRole) => `${PREFIX}:${slotId}:s:${ROLE_CODE[role]}`;
export const agentModalId = (slotId: number, role: AgentRole) => `${MODAL_PREFIX}:${slotId}:${ROLE_CODE[role]}`;

export const isAgentCustomId = (customId: string) => customId.startsWith(`${PREFIX}:`);
export const isAgentModalCustomId = (customId: string) => customId.startsWith(`${MODAL_PREFIX}:`);

function positiveInt(raw: string | undefined): number | null {
  const n = Number(raw);
  return raw !== undefined && /^\d+$/.test(raw) && Number.isInteger(n) && n > 0 ? n : null;
}

export function parseAgentCustomId(customId: string): AgentAction | null {
  const parts = customId.split(":");
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;
  const slotId = positiveInt(parts[1]);
  if (slotId === null) return null;
  const [, , op, arg] = parts as [string, string, string, string];
  if (op === "p") return /^[a-z0-9]{1,24}$/.test(arg) ? { slotId, kind: "pick", agentKey: arg } : null;
  const role = roleFromCode(arg);
  if (!role) return null;
  if (op === "r") return { slotId, kind: "role", role };
  if (op === "x") return { slotId, kind: "clear", role };
  if (op === "a") return { slotId, kind: "add", role };
  if (op === "s") return { slotId, kind: "switch", role };
  return null;
}

export function parseAgentModalCustomId(customId: string): { slotId: number; role: AgentRole } | null {
  const parts = customId.split(":");
  if (parts.length !== 3 || parts[0] !== MODAL_PREFIX) return null;
  const slotId = positiveInt(parts[1]);
  const role = roleFromCode(parts[2]!);
  return slotId !== null && role ? { slotId, role } : null;
}
