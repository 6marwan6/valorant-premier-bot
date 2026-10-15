import { describe, expect, it } from "vitest";
import type { AgentPickKind, AgentPickRow, CustomAgentRow, ScheduleSlotRow } from "../../src/database/schema/schedules.js";
import { MAX_AGENT_BUTTONS, agentsForRole, buildAgentPanel } from "../../src/modules/agents/agentPanel.js";
import {
  agentAddId,
  agentClearId,
  agentModalId,
  agentPickId,
  agentRoleId,
  agentTargetId,
  isAgentCustomId,
  isAgentModalCustomId,
  isLegacyAgentCustomId,
  parseAgentCustomId,
  parseAgentModalCustomId,
} from "../../src/modules/agents/agentCustomId.js";
import { AGENTS, agentIconUrl, ROLE_ORDER, type AgentRole } from "../../src/modules/agents/agentData.js";
import { visibleText } from "./helpers/embedText.js";
import { agentEmojiMapFrom } from "../../src/modules/agents/agentEmojis.js";

const NOW = new Date("2026-10-03T10:00:00Z");
const slot = (extra: Partial<ScheduleSlotRow> = {}): ScheduleSlotRow => ({ id: 7, pollId: 1, position: 1, scheduledAt: new Date("2026-10-10T16:00:00Z"), queueAt: null, remindMode: "AUTO", map: null, quorumAnnouncedAt: null, createdAt: NOW, ...extra });
let nextId = 1;
const pick = (user: string, key: string, kind: AgentPickKind = "MAIN"): AgentPickRow => ({ id: nextId++, pollId: 1, discordUserId: user, agentKey: key, kind, createdAt: NOW, updatedAt: NOW });
const custom = (key: string, name: string, role: AgentRole, by = "u9"): CustomAgentRow => ({ id: 1, guildId: "g", key, displayName: name, role, suggestedByUserId: by, suggestedByName: "X", createdAt: NOW });

function build(over: Partial<Parameters<typeof buildAgentPanel>[0]> = {}) {
  return buildAgentPanel({ poll: { id: 1, timezone: "Africa/Cairo" }, slots: [slot()], picks: [], customAgents: [], viewerId: "u1", tab: "DUELIST", target: "MAIN", now: NOW, ...over });
}
const buttons = (p: ReturnType<typeof build>) => p.components.flatMap((r) => r.toJSON().components as Array<{ custom_id: string; label: string; disabled?: boolean; style: number }>);

describe("agent custom ids (per schedule, with a main/second target)", () => {
  it("round-trips every button and the popup", () => {
    expect(parseAgentCustomId(agentRoleId(7, "CONTROLLER", "SECOND"))).toEqual({ pollId: 7, kind: "role", role: "CONTROLLER", target: "SECOND" });
    expect(parseAgentCustomId(agentPickId(7, "kayo", "MAIN"))).toEqual({ pollId: 7, kind: "pick", agentKey: "kayo", target: "MAIN" });
    expect(parseAgentCustomId(agentPickId(7, "kayo", "SECOND"))).toEqual({ pollId: 7, kind: "pick", agentKey: "kayo", target: "SECOND" });
    expect(parseAgentCustomId(agentTargetId(7, "INITIATOR", "SECOND"))).toEqual({ pollId: 7, kind: "target", role: "INITIATOR", target: "SECOND" });
    expect(parseAgentCustomId(agentClearId(7, "SENTINEL", "ALL"))).toEqual({ pollId: 7, kind: "clear", role: "SENTINEL", scope: "ALL" });
    expect(parseAgentCustomId(agentClearId(7, "SENTINEL", "SECOND"))).toEqual({ pollId: 7, kind: "clear", role: "SENTINEL", scope: "SECOND" });
    expect(parseAgentCustomId(agentAddId(7, "DUELIST", "MAIN"))).toEqual({ pollId: 7, kind: "add", role: "DUELIST", target: "MAIN" });
    expect(parseAgentModalCustomId(agentModalId(7, "SENTINEL", "SECOND"))).toEqual({ pollId: 7, role: "SENTINEL", target: "SECOND" });
    expect(isAgentCustomId("squad:7:r:D1")).toBe(true);
    expect(isAgentCustomId("squadadd:7:D1")).toBe(false);
    expect(isAgentModalCustomId("squadadd:7:D1")).toBe(true);
  });

  it("treats a panel from before the squad was per schedule as legacy, never as a poll id", () => {
    // `agent:<slotId>:...` carried a slot id; reading it as a poll id would act on the wrong schedule.
    expect(isLegacyAgentCustomId("agent:12:p:jett")).toBe(true);
    expect(isAgentCustomId("agent:12:p:jett")).toBe(false);
    expect(parseAgentCustomId("agent:12:p:jett")).toBeNull();
    expect(isLegacyAgentCustomId("squad:12:p:jett")).toBe(false);
  });

  it.each(["squad", "squad:x:r:D1", "squad:0:r:D1", "squad:7:r:Z1", "squad:7:r:D3", "squad:7:r:D", "squad:7:t:D", "squad:7:z:D", "squad:7:p:", "squad:7:q:KAY/O", "squad:7:r:D1:extra", "sched:1:decline"])("rejects %s", (id) => {
    expect(parseAgentCustomId(id)).toBeNull();
  });
  it("rejects malformed popup ids", () => {
    for (const id of ["squadadd", "squadadd:x:D1", "squadadd:7:Z1", "squadadd:7:D", "squadadd:7:D1:1"]) expect(parseAgentModalCustomId(id)).toBeNull();
  });
  it("stays far under Discord's 100-character limit", () => {
    expect(agentPickId(999999999, "abcdefghijklmnopqrstuvwx", "SECOND").length).toBeLessThan(50);
  });
});

const grid = (p: ReturnType<typeof build>) => p.embeds[1]!.toJSON();
const cellOf = (p: ReturnType<typeof build>, name: string) => grid(p).fields!.find((f) => f.name.includes(name.toUpperCase()))!;
const header = (p: ReturnType<typeof build>) => p.embeds[0]!.toJSON();

describe("buildAgentPanel — one squad for every slot", () => {
  it("is two embeds — a header and one grid — instead of a tall card per agent", () => {
    for (const role of ROLE_ORDER) expect(build({ tab: role }).embeds).toHaveLength(2);
  });

  it("says the pick is for every slot, lists them all, and shows the map (or that it is TBD)", () => {
    const slots = [slot({ map: "Ascent" }), slot({ id: 8, position: 2, scheduledAt: new Date("2026-10-11T16:00:00Z"), map: "Ascent" })];
    const text = visibleText(build({ slots }));
    expect(text).toContain("ONE SQUAD FOR EVERY SLOT");
    expect(text).toContain("SAT 10/10 · 19:00");
    expect(text).toContain("SUN 11/10 · 19:00");
    expect(text).toContain("MAP: ASCENT");
    expect(text).not.toContain("some slots use another map");
    expect(visibleText(build())).toContain("MAP: TBD");
  });

  it("uses the first slot's map for the comps, and says so if other slots differ", () => {
    const slots = [slot({ map: "Ascent" }), slot({ id: 8, position: 2, scheduledAt: new Date("2026-10-11T16:00:00Z"), map: "Bind" })];
    const p = build({ slots });
    expect(visibleText(p)).toContain("MAP: ASCENT");
    expect(visibleText(p)).toContain("some slots use another map");
    expect(header(p).description).toContain("COMP A — Standard"); // Ascent's comps
  });

  it("shows two suggested comps for the map, labelled A and B, with every agent named", () => {
    const d = header(build({ slots: [slot({ map: "Ascent" })] })).description!;
    expect(d).toContain("COMP A — Standard");
    expect(d).toContain("COMP B");
    expect(d).toContain("Jett");
    expect(d).toContain("KAY/O");
    expect(d).not.toContain("(general)");
  });

  it("falls back to the general comps (and says so) for a map with none, or no map", () => {
    for (const map of [null, "Summit"]) {
      const d = header(build({ slots: [slot({ map })] })).description!;
      expect(d).toContain("COMP A");
      expect(d).toContain("(general)");
    }
  });

  it("ticks an agent inside the comps only when someone has it as their MAIN, not as a second", () => {
    const d = header(build({ slots: [slot({ map: "Ascent" })], picks: [pick("u2", "jett"), pick("u2", "sova", "SECOND")] })).description!;
    expect(d).toContain("Jett ✅");
    expect(d).not.toContain("Sova ✅");
  });

  it("leaves a blank line between blocks so the header isn't crowded", () => {
    expect(header(build({ slots: [slot({ map: "Ascent" })] })).description!.split("\n\n").length).toBeGreaterThanOrEqual(4); // slots/map, your picks, comp A, comp B
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
    const fields = grid(build({ slots: [slot({ map: "Ascent" })], tab: "DUELIST" })).fields!;
    expect(fields[0]!.name).toContain("JETT"); // Ascent comp A
    expect(fields[0]!.value).toContain("⭐ Comp A");
    const reyna = fields.findIndex((f) => f.name.includes("REYNA"));
    expect(reyna).toBeGreaterThan(0);
    expect(fields[reyna]!.value).not.toContain("⭐");
  });
});

describe("choosing the MAIN agent", () => {
  it("says OPEN, YOUR MAIN, or who holds it — and disables other people's mains", () => {
    const p = build({ picks: [pick("u1", "jett"), pick("u2", "raze")] });
    expect(grid(p).title).toContain("choosing your MAIN");
    expect(cellOf(p, "Jett").value).toContain("✅ **YOUR MAIN**");
    expect(cellOf(p, "Raze").value).toContain("🔒 <@u2>");
    expect(cellOf(p, "Neon").value).toContain("Open");
    const b = Object.fromEntries(buttons(p).map((x) => [x.label.replace(" 🔒", ""), x]));
    expect(b.Raze!.disabled).toBe(true);
    expect(b.Raze!.label).toContain("🔒");
    expect(b.Raze!.custom_id).toBe("squad:1:p:raze"); // a main pick
    expect(b.Jett!.disabled).toBeFalsy();
    expect(b.Jett!.style).toBe(3); // Success: mine
    expect(b.Neon!.disabled).toBeFalsy();
  });

  it("another player's SECOND doesn't block the agent — a second is only a backup", () => {
    const p = build({ picks: [pick("u2", "sova"), pick("u2", "raze", "SECOND")] });
    expect(cellOf(p, "Raze").value).toContain("Open");
    expect(buttons(p).find((b) => b.label === "Raze")!.disabled).toBeFalsy();
  });

  it("shows my main and second (main's portrait as the thumbnail) and the whole squad with its seconds", () => {
    const p = build({ picks: [pick("u1", "jett"), pick("u1", "reyna", "SECOND"), pick("u2", "sova")] });
    const h = header(p);
    expect(h.description).toContain("**YOUR MAIN:** **Jett**");
    expect(h.description).toContain("**YOUR SECOND:** **Reyna**");
    expect(h.description).toContain("SQUAD · 2 locked");
    expect(h.description).toContain("<@u1> — **Jett**  ·  2nd Reyna");
    expect(h.description).toContain("<@u2> — **Sova**");
    expect(h.thumbnail?.url).toBe(agentIconUrl(AGENTS.find((a) => a.key === "jett")!));
    const none = header(build());
    expect(none.description).toContain("none yet");
    expect(none.thumbnail).toBeUndefined();
    expect(none.description).not.toContain("locked"); // no squad list yet
  });

  it("uses the uploaded portrait emoji on the grid, the buttons and the squad list, and the role glyph when there is none", () => {
    const emojis = agentEmojiMapFrom([{ id: "111111111111111111", name: "agent_jett" }, { id: "222222222222222222", name: "random_other" }]);
    const p = build({ emojis });
    expect(cellOf(p, "Jett").name).toContain("<:agent_jett:111111111111111111>");
    expect(cellOf(p, "Raze").name).toContain("⚔️"); // no emoji uploaded for Raze
    const jett = p.components.flatMap((r) => r.toJSON().components as Array<{ label?: string; emoji?: { id?: string } }>).find((b) => b.label === "Jett")!;
    expect(jett.emoji?.id).toBe("111111111111111111");
    expect(header(build({ emojis, picks: [pick("u1", "jett")] })).description).toContain("<@u1> — <:agent_jett:111111111111111111> **Jett**");
    expect(cellOf(build(), "Jett").name).toContain("⚔️"); // without any emojis the panel still builds
  });
});

describe("choosing the SECOND agent (optional)", () => {
  const second = (picks: AgentPickRow[]) => build({ target: "SECOND", picks });

  it("says so in the title, sends second picks, and can't take your own main", () => {
    const p = second([pick("u1", "jett")]);
    expect(grid(p).title).toContain("choosing your SECOND");
    expect(cellOf(p, "Jett").value).toContain("⭐ your main");
    const b = Object.fromEntries(buttons(p).map((x) => [x.label, x]));
    expect(b.Jett!.disabled).toBe(true);
    expect(b.Reyna!.custom_id).toBe("squad:1:q:reyna"); // a second pick
    expect(b.Reyna!.disabled).toBeFalsy();
  });

  it("lets you pick an agent someone else has as their main (it's only your backup), and tells you whose", () => {
    const p = second([pick("u1", "jett"), pick("u2", "raze")]);
    expect(cellOf(p, "Raze").value).toContain("🎯 <@u2>'s main");
    expect(buttons(p).find((b) => b.label === "Raze")!.disabled).toBeFalsy();
  });

  it("marks your current second", () => {
    const p = second([pick("u1", "jett"), pick("u1", "reyna", "SECOND")]);
    expect(cellOf(p, "Reyna").value).toContain("✅ **YOUR 2ND**");
    expect(buttons(p).find((b) => b.label === "Reyna")!.style).toBe(3);
  });

  it("role tabs keep the target, so switching tab doesn't drop you back to your main", () => {
    const tabs = second([pick("u1", "jett")]).components[0]!.toJSON().components as Array<{ custom_id: string; label: string }>;
    expect(tabs.find((t) => t.label === "Sentinels")!.custom_id).toBe("squad:1:r:S2");
    expect((build().components[0]!.toJSON().components as Array<{ custom_id: string; label: string }>).find((t) => t.label === "Sentinels")!.custom_id).toBe("squad:1:r:S1");
  });
});

describe("the action buttons", () => {
  const labels = (p: ReturnType<typeof build>) => buttons(p).map((b) => b.label);

  it("has role tabs (current one disabled) and an add button that remembers the target", () => {
    const tabs = build({ tab: "CONTROLLER" }).components[0]!.toJSON().components as Array<{ label: string; disabled?: boolean }>;
    expect(tabs.map((t) => t.label)).toEqual(["Duelists", "Initiators", "Controllers", "Sentinels"]);
    expect(tabs.find((t) => t.label === "Controllers")!.disabled).toBe(true);
    expect(buttons(build()).find((b) => b.label === "Add an agent")!.custom_id).toBe("squad:1:a:D1");
    expect(buttons(build({ target: "SECOND", picks: [pick("u1", "jett")] })).find((b) => b.label === "Add an agent")!.custom_id).toBe("squad:1:a:D2");
  });

  it("offers 'Pick a second agent' only once there is a main, and 'Back to my main' while choosing the second", () => {
    const none = buttons(build()).find((b) => b.label === "Pick a second agent")!;
    expect(none.disabled).toBe(true); // a second needs a main first
    const withMain = buttons(build({ picks: [pick("u1", "jett")] })).find((b) => b.label === "Pick a second agent")!;
    expect(withMain.disabled).toBeFalsy();
    expect(withMain.custom_id).toBe("squad:1:t:D2");
    const back = buttons(build({ target: "SECOND", picks: [pick("u1", "jett")] })).find((b) => b.label === "Back to my main")!;
    expect(back.custom_id).toBe("squad:1:t:D1");
    expect(labels(build({ target: "SECOND", picks: [pick("u1", "jett")] }))).not.toContain("Pick a second agent");
  });

  it("has Clear my picks (only with something to clear) and Clear second (only with a second); no slot switcher", () => {
    expect(buttons(build()).find((b) => b.label === "Clear my picks")!.disabled).toBe(true);
    expect(labels(build())).not.toContain("Clear second");
    const mainOnly = build({ picks: [pick("u1", "jett")] });
    expect(buttons(mainOnly).find((b) => b.label === "Clear my picks")!.disabled).toBeFalsy();
    expect(labels(mainOnly)).not.toContain("Clear second");
    const both = build({ picks: [pick("u1", "jett"), pick("u1", "reyna", "SECOND")] });
    expect(buttons(both).find((b) => b.label === "Clear second")!.custom_id).toBe("squad:1:y:D");
    expect(buttons(both).find((b) => b.label === "Clear my picks")!.custom_id).toBe("squad:1:x:D");
    expect(labels(both)).not.toContain("Switch slot");
  });

  it("shows a player-suggested agent with who added it, with the role glyph, only in its own role's tab", () => {
    const p = build({ tab: "DUELIST", customAgents: [custom("newguy", "Newguy", "DUELIST", "u9")] });
    const c = cellOf(p, "Newguy");
    expect(c.value).toContain("➕ by <@u9>");
    expect(c.name).toContain("⚔️");
    expect(buttons(p).map((b) => b.label)).toContain("Newguy");
    expect(visibleText(build({ tab: "SENTINEL", customAgents: [custom("newguy", "Newguy", "DUELIST")] }))).not.toContain("NEWGUY");
  });
});

describe("Discord's limits", () => {
  const fullSquad = [pick("u1", "jett"), pick("u1", "reyna", "SECOND"), pick("u2", "sova"), pick("u3", "omen"), pick("u4", "killjoy"), pick("u5", "kayo"), pick("u6", "sage"), pick("u7", "cypher")];

  it("stays inside them even with many suggested agents: ≤10 embeds, ≤25 fields, ≤5 rows, ≤5 buttons a row, <6000 characters", () => {
    const many = Array.from({ length: 12 }, (_, i) => custom(`extra${i}`, `Extra${i}`, "DUELIST"));
    for (const target of ["MAIN", "SECOND"] as const) {
      const p = build({ tab: "DUELIST", target, customAgents: many, picks: [...fullSquad, pick("u8", "extra11")] });
      expect(p.embeds.length).toBeLessThanOrEqual(10);
      expect(grid(p).fields!.length).toBeLessThanOrEqual(25);
      expect(p.components.length).toBeLessThanOrEqual(5);
      expect(p.components.every((r) => r.components.length <= 5)).toBe(true);
      expect(buttons(p).filter((b) => /^squad:1:[pq]:/.test(b.custom_id)).length).toBe(MAX_AGENT_BUTTONS);
      expect(p.embeds.reduce((n, e) => n + JSON.stringify(e.toJSON()).length, 0)).toBeLessThan(6000);
    }
    expect(agentsForRole("DUELIST", many)).toHaveLength(8 + 12);
  });

  it("every role and both targets fit as-is, with a full squad, several slots and every button showing", () => {
    const slots = [slot({ map: "Ascent" }), slot({ id: 8, position: 2, scheduledAt: new Date("2026-10-11T16:00:00Z"), map: "Ascent" }), slot({ id: 9, position: 3, scheduledAt: new Date("2026-10-12T16:00:00Z"), map: "Ascent" })];
    for (const role of ROLE_ORDER) {
      for (const target of ["MAIN", "SECOND"] as const) {
        const p = build({ tab: role, target, slots, picks: fullSquad });
        expect(p.components.length).toBeLessThanOrEqual(5);
        expect(p.components.every((r) => r.components.length <= 5)).toBe(true);
        expect(p.embeds.reduce((n, e) => n + JSON.stringify(e.toJSON()).length, 0)).toBeLessThan(6000);
      }
    }
  });

  it("carries a one-line notice, and always sends a content string so an edit clears the previous notice", () => {
    expect(build({ notice: "✅ Your main is **Jett**." }).content).toContain("Your main");
    expect(build().content).toBe("");
  });
});
