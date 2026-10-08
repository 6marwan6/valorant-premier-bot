/**
 * Valorant reference data for the agent-pick panel (2026-10-04, owner's
 * request): the playable agents grouped by role, each with the official
 * in-game portrait; the maps; and suggested team comps.
 *
 * Agents, roles and portraits come straight from valorant-api.com (the
 * community catalogue that mirrors the game client — the same source its
 * `displayIcon` URLs below point at), checked 2026-10-04 against the live
 * playable-agents list: 29 agents, including Veto (Oct 2025) and Miks
 * (Mar 2026). It is static on purpose: no runtime dependency on a third-party
 * API for a button press. A newer agent than this list is exactly what the
 * panel's "➕ Add an agent" is for — and adding it here later is one line.
 *
 * The comps are a *starting point*, not gospel: the meta moves every patch
 * and the map pool every Act (the seven ranked/Premier maps change roughly
 * every two months), so they are plain data — edit MAP_COMPS freely. Maps
 * without one (a brand-new map nobody has a comp for yet) fall back to the
 * general comps.
 */

export type AgentRole = "DUELIST" | "INITIATOR" | "CONTROLLER" | "SENTINEL";

export const ROLE_ORDER: readonly AgentRole[] = ["DUELIST", "INITIATOR", "CONTROLLER", "SENTINEL"];

export const ROLE_LABEL: Record<AgentRole, string> = {
  DUELIST: "Duelists",
  INITIATOR: "Initiators",
  CONTROLLER: "Controllers",
  SENTINEL: "Sentinels",
};

export const ROLE_SINGULAR: Record<AgentRole, string> = {
  DUELIST: "Duelist",
  INITIATOR: "Initiator",
  CONTROLLER: "Controller",
  SENTINEL: "Sentinel",
};

export const ROLE_GLYPH: Record<AgentRole, string> = {
  DUELIST: "⚔️",
  INITIATOR: "🔎",
  CONTROLLER: "☁️",
  SENTINEL: "🛡️",
};

/** One-letter code used in custom ids (kept short: Discord caps custom_id at 100 characters). */
export const ROLE_CODE: Record<AgentRole, string> = { DUELIST: "D", INITIATOR: "I", CONTROLLER: "C", SENTINEL: "S" };

export function roleFromCode(code: string): AgentRole | null {
  return ROLE_ORDER.find((r) => ROLE_CODE[r] === code) ?? null;
}

export const ROLE_BLURB: Record<AgentRole, string> = {
  DUELIST: "Self-sufficient fraggers who take the first fights.",
  INITIATOR: "Set the team up to enter contested ground.",
  CONTROLLER: "Slice up dangerous territory with smokes and denial.",
  SENTINEL: "Lock down areas and watch the flanks.",
};

// Role badges from the same catalogue — shown as the thumbnail of a player-suggested agent, which has no portrait of its own.
const ROLE_ICON_ID: Record<AgentRole, string> = {
  DUELIST: "dbe8757e-9e92-4ed4-b39f-9dfc589691d4",
  INITIATOR: "1b47567f-8f7b-444b-aae3-b0c634622d10",
  CONTROLLER: "4ee40330-ecdd-4f2f-98a8-eb1243428373",
  SENTINEL: "5fc02f99-4091-4486-a531-98459a3e95e9",
};

export function roleIconUrl(role: AgentRole): string {
  return `https://media.valorant-api.com/agents/roles/${ROLE_ICON_ID[role]}/displayicon.png`;
}

export interface AgentInfo {
  /** Lowercase letters and digits only ("kayo"); what a pick stores and a button's custom id carries. */
  key: string;
  name: string;
  role: AgentRole;
  /** valorant-api.com agent uuid — the in-game portrait lives at agents/<uuid>/displayicon.png. */
  uuid: string;
}

export function agentIconUrl(agent: Pick<AgentInfo, "uuid">): string {
  return `https://media.valorant-api.com/agents/${agent.uuid}/displayicon.png`;
}

/** The small portrait (valorant-api.com's `displayiconsmall`) — what the one-time emoji sync uploads, light enough for Discord's 256 KB emoji limit. */
export function agentSmallIconUrl(agent: Pick<AgentInfo, "uuid">): string {
  return `https://media.valorant-api.com/agents/${agent.uuid}/displayiconsmall.png`;
}

/** Discord application-emoji name for an agent's portrait (2-32 letters/digits/underscores): `agent_jett`, `agent_kayo`. */
export const AGENT_EMOJI_PREFIX = "agent_";
export const agentEmojiName = (key: string) => `${AGENT_EMOJI_PREFIX}${key}`;

export const AGENTS: readonly AgentInfo[] = [
  // Duelists
  { key: "jett", name: "Jett", role: "DUELIST", uuid: "add6443a-41bd-e414-f6ad-e58d267f4e95" },
  { key: "reyna", name: "Reyna", role: "DUELIST", uuid: "a3bfb853-43b2-7238-a4f1-ad90e9e46bcc" },
  { key: "raze", name: "Raze", role: "DUELIST", uuid: "f94c3b30-42be-e959-889c-5aa313dba261" },
  { key: "phoenix", name: "Phoenix", role: "DUELIST", uuid: "eb93336a-449b-9c1b-0a54-a891f7921d69" },
  { key: "yoru", name: "Yoru", role: "DUELIST", uuid: "7f94d92c-4234-0a36-9646-3a87eb8b5c89" },
  { key: "neon", name: "Neon", role: "DUELIST", uuid: "bb2a4828-46eb-8cd1-e765-15848195d751" },
  { key: "iso", name: "Iso", role: "DUELIST", uuid: "0e38b510-41a8-5780-5e8f-568b2a4f2d6c" },
  { key: "waylay", name: "Waylay", role: "DUELIST", uuid: "df1cb487-4902-002e-5c17-d28e83e78588" },
  // Initiators
  { key: "sova", name: "Sova", role: "INITIATOR", uuid: "320b2a48-4d9b-a075-30f1-1f93a9b638fa" },
  { key: "breach", name: "Breach", role: "INITIATOR", uuid: "5f8d3a7f-467b-97f3-062c-13acf203c006" },
  { key: "skye", name: "Skye", role: "INITIATOR", uuid: "6f2a04ca-43e0-be17-7f36-b3908627744d" },
  { key: "kayo", name: "KAY/O", role: "INITIATOR", uuid: "601dbbe7-43ce-be57-2a40-4abd24953621" },
  { key: "fade", name: "Fade", role: "INITIATOR", uuid: "dade69b4-4f5a-8528-247b-219e5a1facd6" },
  { key: "gekko", name: "Gekko", role: "INITIATOR", uuid: "e370fa57-4757-3604-3648-499e1f642d3f" },
  { key: "tejo", name: "Tejo", role: "INITIATOR", uuid: "b444168c-4e35-8076-db47-ef9bf368f384" },
  // Controllers
  { key: "brimstone", name: "Brimstone", role: "CONTROLLER", uuid: "9f0d8ba9-4140-b941-57d3-a7ad57c6b417" },
  { key: "viper", name: "Viper", role: "CONTROLLER", uuid: "707eab51-4836-f488-046a-cda6bf494859" },
  { key: "omen", name: "Omen", role: "CONTROLLER", uuid: "8e253930-4c05-31dd-1b6c-968525494517" },
  { key: "astra", name: "Astra", role: "CONTROLLER", uuid: "41fb69c1-4189-7b37-f117-bcaf1e96f1bf" },
  { key: "harbor", name: "Harbor", role: "CONTROLLER", uuid: "95b78ed7-4637-86d9-7e41-71ba8c293152" },
  { key: "clove", name: "Clove", role: "CONTROLLER", uuid: "1dbf2edd-4729-0984-3115-daa5eed44993" },
  { key: "miks", name: "Miks", role: "CONTROLLER", uuid: "7c8a4701-4de6-9355-b254-e09bc2a34b72" },
  // Sentinels
  { key: "sage", name: "Sage", role: "SENTINEL", uuid: "569fdd95-4d10-43ab-ca70-79becc718b46" },
  { key: "cypher", name: "Cypher", role: "SENTINEL", uuid: "117ed9e3-49f3-6512-3ccf-0cada7e3823b" },
  { key: "killjoy", name: "Killjoy", role: "SENTINEL", uuid: "1e58de9c-4950-5125-93e9-a0aee9f98746" },
  { key: "chamber", name: "Chamber", role: "SENTINEL", uuid: "22697a3d-45bf-8dd7-4fec-84a9e28c69d7" },
  { key: "deadlock", name: "Deadlock", role: "SENTINEL", uuid: "cc8b64c8-4b25-4ff9-6e7f-37b4da43d235" },
  { key: "vyse", name: "Vyse", role: "SENTINEL", uuid: "efba5359-4016-a1e5-7626-b1ae76895940" },
  { key: "veto", name: "Veto", role: "SENTINEL", uuid: "92eeef5d-43b5-1d4a-8d03-b3927a09034b" },
];

const AGENT_BY_KEY = new Map(AGENTS.map((a) => [a.key, a]));

/** "KAY/O", "kay-o", " Kayo " -> "kayo". The one normalization for agent names, used for matching and for custom agents' keys. */
export function agentKeyOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function agentByKey(key: string): AgentInfo | undefined {
  return AGENT_BY_KEY.get(key);
}

/** A built-in agent by any spelling of its name. */
export function findAgentByName(name: string): AgentInfo | undefined {
  return AGENT_BY_KEY.get(agentKeyOf(name));
}

export function agentsOfRole(role: AgentRole): AgentInfo[] {
  return AGENTS.filter((a) => a.role === role);
}

// ------------------------------------------------------------------ maps

/** All 13 standard maps (Summit, added 2026-06-23, is the newest). Not just the current pool: the pool changes every Act, and a Premier match can be on whatever the team ends up on. */
export const MAPS = ["Abyss", "Ascent", "Bind", "Breeze", "Corrode", "Fracture", "Haven", "Icebox", "Lotus", "Pearl", "Split", "Sunset", "Summit"] as const;
export type MapName = (typeof MAPS)[number];

export function findMap(input: string): MapName | undefined {
  const key = agentKeyOf(input);
  return MAPS.find((m) => agentKeyOf(m) === key);
}

// ------------------------------------------------------------------ comps

export interface Comp {
  name: string;
  /** Exactly five agent keys: one of each role plus a flex. */
  agents: readonly string[];
}

/** Used when a map has no comps of its own (a new map, or none picked yet). */
export const GENERAL_COMPS: readonly Comp[] = [
  { name: "Standard", agents: ["jett", "sova", "omen", "killjoy", "skye"] },
  { name: "Aggressive", agents: ["raze", "fade", "astra", "cypher", "kayo"] },
];

export const MAP_COMPS: Partial<Record<MapName, readonly Comp[]>> = {
  Abyss: [
    { name: "Standard", agents: ["jett", "sova", "omen", "cypher", "fade"] },
    { name: "Execute-heavy", agents: ["neon", "gekko", "clove", "killjoy", "breach"] },
  ],
  Ascent: [
    { name: "Standard", agents: ["jett", "sova", "omen", "killjoy", "kayo"] },
    { name: "Fast hits", agents: ["neon", "fade", "astra", "cypher", "skye"] },
  ],
  Bind: [
    { name: "Standard", agents: ["raze", "skye", "brimstone", "cypher", "fade"] },
    { name: "Smokes + info", agents: ["phoenix", "gekko", "viper", "killjoy", "kayo"] },
  ],
  Breeze: [
    { name: "Standard", agents: ["jett", "sova", "viper", "cypher", "skye"] },
    { name: "Wide control", agents: ["neon", "breach", "astra", "chamber", "kayo"] },
  ],
  Fracture: [
    { name: "Standard", agents: ["neon", "breach", "brimstone", "cypher", "fade"] },
    { name: "Split pushes", agents: ["raze", "sova", "harbor", "killjoy", "gekko"] },
  ],
  Haven: [
    { name: "Standard", agents: ["jett", "sova", "omen", "cypher", "breach"] },
    { name: "Fast three-site", agents: ["raze", "fade", "astra", "killjoy", "skye"] },
  ],
  Icebox: [
    { name: "Standard", agents: ["jett", "sova", "viper", "sage", "kayo"] },
    { name: "Util heavy", agents: ["raze", "gekko", "omen", "killjoy", "breach"] },
  ],
  Lotus: [
    { name: "Standard", agents: ["raze", "fade", "omen", "killjoy", "tejo"] },
    { name: "Flex", agents: ["neon", "gekko", "astra", "cypher", "skye"] },
  ],
  Pearl: [
    { name: "Standard", agents: ["jett", "fade", "astra", "killjoy", "kayo"] },
    { name: "Aggressive", agents: ["neon", "gekko", "harbor", "cypher", "breach"] },
  ],
  Split: [
    { name: "Standard", agents: ["raze", "skye", "omen", "sage", "fade"] },
    { name: "Mid control", agents: ["jett", "kayo", "brimstone", "cypher", "gekko"] },
  ],
  Sunset: [
    { name: "Standard", agents: ["jett", "gekko", "omen", "killjoy", "fade"] },
    { name: "Mid push", agents: ["raze", "sova", "astra", "cypher", "skye"] },
  ],
  // Corrode and Summit: no map-specific comps yet — they use GENERAL_COMPS until someone adds them here.
};

/** The comps shown for a map (or the general ones when the map is unset or has none of its own), and which of the two that is. */
export function compsFor(map: string | null | undefined): { comps: readonly Comp[]; general: boolean } {
  const found = map ? findMap(map) : undefined;
  const own = found ? MAP_COMPS[found] : undefined;
  return own ? { comps: own, general: false } : { comps: GENERAL_COMPS, general: true };
}
