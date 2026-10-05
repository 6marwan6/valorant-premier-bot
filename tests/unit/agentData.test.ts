import { describe, expect, it } from "vitest";
import {
  AGENTS,
  GENERAL_COMPS,
  MAPS,
  MAP_COMPS,
  ROLE_ORDER,
  agentByKey,
  agentIconUrl,
  agentKeyOf,
  agentsOfRole,
  compsFor,
  findAgentByName,
  findMap,
  roleFromCode,
  ROLE_CODE,
} from "../../src/modules/agents/agentData.js";

describe("agent roster", () => {
  it("has the 29 playable agents, 7-8 per role, with unique keys and portrait ids", () => {
    expect(AGENTS).toHaveLength(29);
    expect(new Set(AGENTS.map((a) => a.key)).size).toBe(29);
    expect(new Set(AGENTS.map((a) => a.uuid)).size).toBe(29);
    expect(agentsOfRole("DUELIST")).toHaveLength(8);
    expect(agentsOfRole("INITIATOR")).toHaveLength(7);
    expect(agentsOfRole("CONTROLLER")).toHaveLength(7);
    expect(agentsOfRole("SENTINEL")).toHaveLength(7);
  });

  it("every key is the normalized name, and every portrait URL is the in-game icon", () => {
    for (const a of AGENTS) {
      expect(a.key).toBe(agentKeyOf(a.name));
      expect(a.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(agentIconUrl(a)).toBe(`https://media.valorant-api.com/agents/${a.uuid}/displayicon.png`);
    }
  });

  it("spot-checks ids against the catalogue", () => {
    expect(agentByKey("jett")?.uuid).toBe("add6443a-41bd-e414-f6ad-e58d267f4e95");
    expect(agentByKey("miks")?.role).toBe("CONTROLLER");
    expect(agentByKey("veto")?.role).toBe("SENTINEL");
    expect(agentByKey("tejo")?.role).toBe("INITIATOR");
  });

  it("matches names however they're spelled", () => {
    expect(findAgentByName("KAY/O")?.key).toBe("kayo");
    expect(findAgentByName(" kay-o ")?.key).toBe("kayo");
    expect(findAgentByName("JETT")?.key).toBe("jett");
    expect(findAgentByName("Nobody")).toBeUndefined();
  });

  it("role codes round-trip", () => {
    for (const r of ROLE_ORDER) expect(roleFromCode(ROLE_CODE[r])).toBe(r);
    expect(roleFromCode("X")).toBeNull();
  });
});

describe("maps and comps", () => {
  it("lists the 13 standard maps and finds them case-insensitively", () => {
    expect(MAPS).toHaveLength(13);
    expect(findMap("ascent")).toBe("Ascent");
    expect(findMap(" SUMMIT ")).toBe("Summit");
    expect(findMap("dust2")).toBeUndefined();
  });

  const all = [...GENERAL_COMPS.map((c) => ["general", c] as const), ...Object.entries(MAP_COMPS).flatMap(([map, comps]) => comps!.map((c) => [map, c] as const))];

  it.each(all.map(([map, c]) => [`${map} / ${c.name}`, c] as const))("%s is five distinct, known agents covering all four roles", (_label, comp) => {
    expect(comp.agents).toHaveLength(5);
    expect(new Set(comp.agents).size).toBe(5);
    const roles = comp.agents.map((k) => agentByKey(k)?.role);
    expect(roles.every(Boolean)).toBe(true);
    for (const r of ROLE_ORDER) expect(roles).toContain(r);
  });

  it("two comps for every map that has its own, and the general ones as the fallback", () => {
    for (const comps of Object.values(MAP_COMPS)) expect(comps).toHaveLength(2);
    expect(GENERAL_COMPS).toHaveLength(2);
    expect(compsFor("Ascent").general).toBe(false);
    expect(compsFor("Summit").general).toBe(true);
    expect(compsFor(null).general).toBe(true);
    expect(compsFor("not a map").comps).toBe(GENERAL_COMPS);
  });
});
