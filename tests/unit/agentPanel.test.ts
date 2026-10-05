import { describe, expect, it } from "vitest";
import type { AgentPickRow, CustomAgentRow, ScheduleSlotRow } from "../../src/database/schema/schedules.js";
import { MAX_AGENT_BUTTONS, MAX_AGENT_CARDS, agentsForRole, buildAgentPanel } from "../../src/modules/agents/agentPanel.js";
import { agentAddId, agentClearId, agentModalId, agentPickId, agentRoleId, agentSwitchId, isAgentCustomId, isAgentModalCustomId, parseAgentCustomId, parseAgentModalCustomId } from "../../src/modules/agents/agentCustomId.js";
import { AGENTS, agentIconUrl, roleIconUrl, ROLE_ORDER, type AgentRole } from "../../src/modules/agents/agentData.js";
import { visibleText } from "./helpers/embedText.js";

const NOW = new Date("2026-10-03T10:00:00Z");
const slot = (extra: Partial<ScheduleSlotRow> = {}): ScheduleSlotRow => ({ id: 7, pollId: 1, position: 1, scheduledAt: new Date("2026-10-10T16:00:00Z"), queueAt: null, remindMode: "AUTO", map: null, quorumAnnouncedAt: null, createdAt: NOW, ...extra });
const pick = (user: string, key: string, id = 1): AgentPickRow => ({ id, slotId: 7, discordUserId: user, agentKey: key, createdAt: NOW, updatedAt: NOW });
const custom = (key: string, name: string, role: AgentRole, by = "u9"): CustomAgentRow => ({ id: 1, guildId: "g", key, displayName: name, role, suggestedByUserId: by, suggestedByName: "X", createdAt: NOW });

function build(over: Partial<Parameters<typeof buildAgentPanel>[0]> = {}) {
  return buildAgentPanel({ poll: { id: 1, timezone: "Africa/Cairo" }, slot: slot(), picks: [], customAgents: [], viewerId: "u1", tab: "DUELIST", hasOtherSlots: false, ...over });
}
const buttons = (p: ReturnType<typeof build>) => p.components.flatMap((r) => r.toJSON().components as Array<{ custom_id: string; label: string; disabled?: boolean; style: number }>);

describe("agent custom ids", () => {
  it("round-trips every button and the popup", () => {
    expect(parseAgentCustomId(agentRoleId(7, "CONTROLLER"))).toEqual({ slotId: 7, kind: "role", role: "CONTROLLER" });
    expect(parseAgentCustomId(agentPickId(7, "kayo"))).toEqual({ slotId: 7, kind: "pick", agentKey: "kayo" });
    expect(parseAgentCustomId(agentClearId(7, "SENTINEL"))).toEqual({ slotId: 7, kind: "clear", role: "SENTINEL" });
    expect(parseAgentCustomId(agentAddId(7, "DUELIST"))).toEqual({ slotId: 7, kind: "add", role: "DUELIST" });
    expect(parseAgentCustomId(agentSwitchId(7, "INITIATOR"))).toEqual({ slotId: 7, kind: "switch", role: "INITIATOR" });
    expect(parseAgentModalCustomId(agentModalId(7, "SENTINEL"))).toEqual({ slotId: 7, role: "SENTINEL" });
    expect(isAgentCustomId("agent:7:r:D")).toBe(true);
    expect(isAgentCustomId("agentadd:7:D")).toBe(false);
    expect(isAgentModalCustomId("agentadd:7:D")).toBe(true);
  });

  it.each(["agent", "agent:x:r:D", "agent:0:r:D", "agent:7:r:Z", "agent:7:q:D", "agent:7:p:", "agent:7:p:KAY/O", "agent:7:r:D:extra", "sched:1:decline"])("rejects %s", (id) => {
    expect(parseAgentCustomId(id)).toBeNull();
  });
  it("rejects malformed popup ids", () => {
    for (const id of ["agentadd", "agentadd:x:D", "agentadd:7:Z", "agentadd:7:D:1"]) expect(parseAgentModalCustomId(id)).toBeNull();
  });
  it("stays far under Discord's 100-character limit", () => {
    expect(agentPickId(999999999, "abcdefghijklmnopqrstuvwx").length).toBeLessThan(50);
  });
});

describe("buildAgentPanel", () => {
  it("shows the day/time and the map, or says the map is TBD", () => {
    const withMap = build({ slot: slot({ map: "Ascent" }) });
    expect(visibleText(withMap)).toContain("MAP: ASCENT");
    expect(visibleText(withMap)).toContain("SAT 10/10 · 19:00");
    expect(visibleText(build())).toContain("MAP: TBD");
  });

  it("shows two suggested comps for the map, labelled A and B, with every agent named", () => {
    const e = build({ slot: slot({ map: "Ascent" }) }).embeds[0]!.toJSON();
    const comps = e.fields!.filter((f) => f.name.includes("SUGGESTED COMP"));
    expect(comps).toHaveLength(2);
    expect(comps[0]!.name).toContain("COMP A");
    expect(comps[1]!.name).toContain("COMP B");
    expect(comps[0]!.value).toContain("Jett");
    expect(comps[0]!.value).toContain("KAY/O");
    expect(comps[0]!.name).not.toContain("(general)");
  });

  it("falls back to the general comps (and says so) for a map with none, or no map", () => {
    for (const map of [null, "Summit"]) {
      const comps = build({ slot: slot({ map }) }).embeds[0]!.toJSON().fields!.filter((f) => f.name.includes("SUGGESTED COMP"));
      expect(comps).toHaveLength(2);
      expect(comps[0]!.name).toContain("(general)");
    }
  });

  it("marks agents already picked inside the comps", () => {
    const comps = build({ slot: slot({ map: "Ascent" }), picks: [pick("u2", "jett")] }).embeds[0]!.toJSON().fields!.filter((f) => f.name.includes("COMP A"));
    expect(comps[0]!.value).toContain("Jett ✅");
    expect(comps[0]!.value).not.toContain("Sova ✅");
  });

  it("groups by role: the open tab shows only that role's agents, with the in-game portrait on each", () => {
    for (const role of ROLE_ORDER) {
      const p = build({ tab: role });
      const cards = p.embeds.slice(1).map((e) => e.toJSON());
      const expected = AGENTS.filter((a) => a.role === role);
      expect(cards).toHaveLength(expected.length);
      for (const card of cards) {
        const a = expected.find((x) => card.title!.includes(x.name.toUpperCase()));
        expect(a, card.title).toBeTruthy();
        expect(card.thumbnail?.url).toBe(agentIconUrl(a!));
      }
      // the button rows list the same agents
      const labels = buttons(p).map((b) => b.label);
      for (const a of expected) expect(labels).toContain(a.name);
      for (const a of AGENTS.filter((x) => x.role !== role)) expect(labels).not.toContain(a.name);
    }
  });

  it("puts the suggested agents first and tags the rest as other options", () => {
    const cards = build({ slot: slot({ map: "Ascent" }), tab: "DUELIST" }).embeds.slice(1).map((e) => e.toJSON());
    expect(cards[0]!.title).toContain("JETT"); // suggested by Ascent comp A
    expect(cards[0]!.description).toContain("⭐ SUGGESTED · Comp A");
    const other = cards.find((c) => c.title!.includes("REYNA"))!;
    expect(other.description).toContain("OTHER OPTION");
    expect(cards.findIndex((c) => c.title!.includes("REYNA"))).toBeGreaterThan(cards.findIndex((c) => c.title!.includes("JETT")));
  });

  it("says OPEN, YOUR PICK, or who picked it — and disables other people's agents", () => {
    const p = build({ picks: [pick("u1", "jett"), pick("u2", "raze", 2)] });
    const cards = Object.fromEntries(p.embeds.slice(1).map((e) => [e.toJSON().title!.replace(/^\S+ /, ""), e.toJSON()]));
    expect(cards.JETT!.description).toContain("YOUR PICK");
    expect(cards.RAZE!.description).toContain("PICKED BY** <@u2>");
    expect(cards.NEON!.description).toContain("OPEN");
    const b = Object.fromEntries(buttons(p).map((x) => [x.label.replace(" 🔒", ""), x]));
    expect(b.Raze!.disabled).toBe(true);
    expect(b.Raze!.label).toContain("🔒");
    expect(b.Jett!.disabled).toBeFalsy();
    expect(b.Jett!.style).toBe(3); // Success: mine
    expect(b.Neon!.disabled).toBeFalsy();
  });

  it("shows my pick and the squad's picks in the header", () => {
    const e = build({ picks: [pick("u1", "jett"), pick("u2", "sova", 2)] }).embeds[0]!.toJSON();
    expect(e.fields!.find((f) => f.name.includes("YOUR PICK"))!.value).toContain("Jett");
    const squad = e.fields!.find((f) => f.name.includes("SQUAD PICKS"))!;
    expect(squad.name).toContain("2");
    expect(squad.value).toContain("<@u2> — **Sova**");
    expect(build().embeds[0]!.toJSON().fields!.find((f) => f.name.includes("YOUR PICK"))!.value).toContain("none yet");
  });

  it("has role tabs (current one disabled), an add button, a clear button only when there's something to clear, and a switch button only with other slots", () => {
    const tabs = build({ tab: "CONTROLLER" }).components[0]!.toJSON().components as Array<{ custom_id: string; label: string; disabled?: boolean }>;
    expect(tabs.map((t) => t.label)).toEqual(["Duelists", "Initiators", "Controllers", "Sentinels"]);
    expect(tabs.find((t) => t.label === "Controllers")!.disabled).toBe(true);
    const plain = buttons(build());
    expect(plain.find((b) => b.label === "Add an agent")!.custom_id).toBe("agent:7:a:D");
    expect(plain.find((b) => b.label === "Clear my pick")!.disabled).toBe(true);
    expect(plain.some((b) => b.label === "Switch slot")).toBe(false);
    const full = buttons(build({ picks: [pick("u1", "jett")], hasOtherSlots: true }));
    expect(full.find((b) => b.label === "Clear my pick")!.disabled).toBeFalsy();
    expect(full.some((b) => b.label === "Switch slot")).toBe(true);
  });

  it("shows a player-suggested agent with who added it, and a role badge instead of a portrait", () => {
    const p = build({ tab: "DUELIST", customAgents: [custom("newguy", "Newguy", "DUELIST", "u9")] });
    const card = p.embeds.map((e) => e.toJSON()).find((e) => e.title?.includes("NEWGUY"))!;
    expect(card.description).toContain("ADDED BY <@u9>");
    expect(card.thumbnail?.url).toBe(roleIconUrl("DUELIST"));
    expect(buttons(p).map((b) => b.label)).toContain("Newguy");
    // ...and only in its own role's tab
    expect(visibleText(build({ tab: "SENTINEL", customAgents: [custom("newguy", "Newguy", "DUELIST")] }))).not.toContain("NEWGUY");
  });

  it("stays inside Discord's limits even with many suggested agents: ≤10 embeds, ≤5 rows, ≤5 buttons a row", () => {
    const many = Array.from({ length: 12 }, (_, i) => custom(`extra${i}`, `Extra${i}`, "DUELIST"));
    const p = build({ tab: "DUELIST", customAgents: many, picks: [pick("u2", "extra11")] });
    expect(p.embeds.length).toBeLessThanOrEqual(10);
    expect(p.components.length).toBeLessThanOrEqual(5);
    expect(p.components.every((r) => r.components.length <= 5)).toBe(true);
    expect(buttons(p).filter((b) => b.custom_id.startsWith("agent:7:p:")).length).toBe(MAX_AGENT_BUTTONS);
    expect(p.embeds.length).toBe(1 + (MAX_AGENT_CARDS - 1) + 1); // header + cards + the "more" list
    expect(agentsForRole("DUELIST", many)).toHaveLength(8 + 12);
    const total = p.embeds.reduce((n, e) => n + JSON.stringify(e.toJSON()).length, 0);
    expect(total).toBeLessThan(6000);
  });

  it("every role fits comfortably as-is", () => {
    for (const role of ROLE_ORDER) {
      const p = build({ tab: role, hasOtherSlots: true, picks: [pick("u1", AGENTS.find((a) => a.role === role)!.key)] });
      expect(p.embeds.length).toBeLessThanOrEqual(10);
      expect(p.components.length).toBeLessThanOrEqual(5);
      expect(p.embeds.reduce((n, e) => n + JSON.stringify(e.toJSON()).length, 0)).toBeLessThan(6000);
    }
  });

  it("mentions a map in the message line and carries a one-line notice", () => {
    const p = build({ slot: slot({ map: "Lotus" }), notice: "✅ You're playing **Jett**." });
    expect(p.content).toContain("AGENT PICK");
    expect(p.content).toContain("Lotus");
    expect(p.content).toContain("You're playing");
  });
});
