import { describe, expect, it } from "vitest";
import type { AgentPickRow, CustomAgentRow, ScheduleSlotRow } from "../../src/database/schema/schedules.js";
import { MAX_AGENT_BUTTONS, agentsForRole, buildAgentPanel } from "../../src/modules/agents/agentPanel.js";
import { agentAddId, agentClearId, agentModalId, agentPickId, agentRoleId, agentSwitchId, isAgentCustomId, isAgentModalCustomId, parseAgentCustomId, parseAgentModalCustomId } from "../../src/modules/agents/agentCustomId.js";
import { AGENTS, agentIconUrl, ROLE_ORDER, type AgentRole } from "../../src/modules/agents/agentData.js";
import { visibleText } from "./helpers/embedText.js";
import { agentEmojiMapFrom } from "../../src/modules/agents/agentEmojis.js";

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

const grid = (p: ReturnType<typeof build>) => p.embeds[1]!.toJSON();
const cellOf = (p: ReturnType<typeof build>, name: string) => grid(p).fields!.find((f) => f.name.includes(name.toUpperCase()))!;

describe("buildAgentPanel", () => {
  it("is two embeds — a header and one grid — instead of a tall card per agent", () => {
    for (const role of ROLE_ORDER) expect(build({ tab: role }).embeds).toHaveLength(2);
  });

  it("shows the day/time and the map, or says the map is TBD", () => {
    const withMap = build({ slot: slot({ map: "Ascent" }) });
    expect(visibleText(withMap)).toContain("MAP: ASCENT");
    expect(visibleText(withMap)).toContain("SAT 10/10 · 19:00");
    expect(visibleText(build())).toContain("MAP: TBD");
  });

  it("shows two suggested comps for the map, labelled A and B, with every agent named", () => {
    const d = build({ slot: slot({ map: "Ascent" }) }).embeds[0]!.toJSON().description!;
    expect(d).toContain("COMP A — Standard");
    expect(d).toContain("COMP B");
    expect(d).toContain("Jett");
    expect(d).toContain("KAY/O");
    expect(d).not.toContain("(general)");
  });

  it("falls back to the general comps (and says so) for a map with none, or no map", () => {
    for (const map of [null, "Summit"]) {
      const d = build({ slot: slot({ map }) }).embeds[0]!.toJSON().description!;
      expect(d).toContain("COMP A");
      expect(d).toContain("(general)");
    }
  });

  it("marks agents already picked inside the comps", () => {
    const d = build({ slot: slot({ map: "Ascent" }), picks: [pick("u2", "jett")] }).embeds[0]!.toJSON().description!;
    expect(d).toContain("Jett ✅");
    expect(d).not.toContain("Sova ✅");
  });

  it("leaves a blank line between blocks so the header isn't crowded", () => {
    const d = build({ slot: slot({ map: "Ascent" }) }).embeds[0]!.toJSON().description!;
    expect(d.split("\n\n").length).toBeGreaterThanOrEqual(4); // when/map, your pick, comp A, comp B
  });

  it("groups by role: the open tab is one grid of that role's agents, three across, with a button for each", () => {
    for (const role of ROLE_ORDER) {
      const p = build({ tab: role });
      const expected = AGENTS.filter((a) => a.role === role);
      const fields = grid(p).fields!;
      expect(fields).toHaveLength(expected.length);
      expect(fields.every((f) => f.inline)).toBe(true); // inline fields are what sit side by side
      for (const a of expected) expect(fields.some((f) => f.name.includes(a.name.toUpperCase()))).toBe(true);
      const labels = buttons(p).map((b) => b.label);
      for (const a of expected) expect(labels).toContain(a.name);
      for (const a of AGENTS.filter((x) => x.role !== role)) expect(labels).not.toContain(a.name);
    }
  });

  it("puts the suggested agents first and marks them with their comp", () => {
    const fields = grid(build({ slot: slot({ map: "Ascent" }), tab: "DUELIST" })).fields!;
    expect(fields[0]!.name).toContain("JETT"); // Ascent comp A
    expect(fields[0]!.value).toContain("⭐ Comp A");
    const reyna = fields.findIndex((f) => f.name.includes("REYNA"));
    expect(reyna).toBeGreaterThan(0);
    expect(fields[reyna]!.value).not.toContain("⭐");
  });

  it("says OPEN, YOU, or who picked it — and disables other people's agents", () => {
    const p = build({ picks: [pick("u1", "jett"), pick("u2", "raze", 2)] });
    expect(cellOf(p, "Jett").value).toContain("✅ **YOU**");
    expect(cellOf(p, "Raze").value).toContain("🔒 <@u2>");
    expect(cellOf(p, "Neon").value).toContain("Open");
    const b = Object.fromEntries(buttons(p).map((x) => [x.label.replace(" 🔒", ""), x]));
    expect(b.Raze!.disabled).toBe(true);
    expect(b.Raze!.label).toContain("🔒");
    expect(b.Jett!.disabled).toBeFalsy();
    expect(b.Jett!.style).toBe(3); // Success: mine
    expect(b.Neon!.disabled).toBeFalsy();
  });

  it("shows my pick (with its portrait as the header thumbnail) and the squad's picks", () => {
    const mine = build({ picks: [pick("u1", "jett"), pick("u2", "sova", 2)] }).embeds[0]!.toJSON();
    expect(mine.description).toContain("**YOUR PICK:** **Jett**");
    expect(mine.description).toContain("SQUAD · 2 locked");
    expect(mine.description).toContain("<@u2> — **Sova**");
    expect(mine.thumbnail?.url).toBe(agentIconUrl(AGENTS.find((a) => a.key === "jett")!));
    const none = build().embeds[0]!.toJSON();
    expect(none.description).toContain("none yet");
    expect(none.thumbnail).toBeUndefined();
    expect(none.description).not.toContain("SQUAD");
  });

  it("uses the uploaded portrait emoji on the grid and the buttons, and the role glyph when there is none", () => {
    const emojis = agentEmojiMapFrom([{ id: "111111111111111111", name: "agent_jett" }, { id: "222222222222222222", name: "random_other" }]);
    const p = build({ emojis });
    expect(cellOf(p, "Jett").name).toContain("<:agent_jett:111111111111111111>");
    expect(cellOf(p, "Raze").name).toContain("⚔️"); // no emoji uploaded for Raze
    const jett = p.components.flatMap((r) => r.toJSON().components as Array<{ label?: string; emoji?: { id?: string } }>).find((b) => b.label === "Jett")!;
    expect(jett.emoji?.id).toBe("111111111111111111");
    // without any emojis the panel still builds
    expect(cellOf(build(), "Jett").name).toContain("⚔️");
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

  it("shows a player-suggested agent with who added it, with the role glyph, only in its own role's tab", () => {
    const p = build({ tab: "DUELIST", customAgents: [custom("newguy", "Newguy", "DUELIST", "u9")] });
    const c = cellOf(p, "Newguy");
    expect(c.value).toContain("➕ by <@u9>");
    expect(c.name).toContain("⚔️");
    expect(buttons(p).map((b) => b.label)).toContain("Newguy");
    expect(visibleText(build({ tab: "SENTINEL", customAgents: [custom("newguy", "Newguy", "DUELIST")] }))).not.toContain("NEWGUY");
  });

  it("stays inside Discord's limits even with many suggested agents: ≤10 embeds, ≤25 fields, ≤5 rows, ≤5 buttons a row, <6000 characters", () => {
    const many = Array.from({ length: 12 }, (_, i) => custom(`extra${i}`, `Extra${i}`, "DUELIST"));
    const p = build({ tab: "DUELIST", customAgents: many, picks: [pick("u2", "extra11")] });
    expect(p.embeds.length).toBeLessThanOrEqual(10);
    expect(grid(p).fields!.length).toBeLessThanOrEqual(25);
    expect(p.components.length).toBeLessThanOrEqual(5);
    expect(p.components.every((r) => r.components.length <= 5)).toBe(true);
    expect(buttons(p).filter((b) => b.custom_id.startsWith("agent:7:p:")).length).toBe(MAX_AGENT_BUTTONS);
    expect(agentsForRole("DUELIST", many)).toHaveLength(8 + 12);
    expect(p.embeds.reduce((n, e) => n + JSON.stringify(e.toJSON()).length, 0)).toBeLessThan(6000);
  });

  it("every role fits comfortably as-is", () => {
    for (const role of ROLE_ORDER) {
      const p = build({ tab: role, hasOtherSlots: true, picks: [pick("u1", AGENTS.find((a) => a.role === role)!.key)] });
      expect(p.components.length).toBeLessThanOrEqual(5);
      expect(p.embeds.reduce((n, e) => n + JSON.stringify(e.toJSON()).length, 0)).toBeLessThan(6000);
    }
  });

  it("carries a one-line notice, and always sends a content string so an edit clears the previous notice", () => {
    expect(build({ notice: "✅ You're playing **Jett**." }).content).toContain("You're playing");
    expect(build().content).toBe("");
  });
});
