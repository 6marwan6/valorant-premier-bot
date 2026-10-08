import { describe, expect, it } from "vitest";
import type { ScheduleView } from "../../src/database/repositories/scheduleRepository.js";
import type { AgentPickRow, CustomAgentRow, ScheduleSlotRow, ScheduleVoteRow } from "../../src/database/schema/schedules.js";
import { buildAgentBoard } from "../../src/modules/agents/agentBoard.js";
import { agentEmojiMapFrom } from "../../src/modules/agents/agentEmojis.js";
import { visibleText } from "./helpers/embedText.js";

const NOW = new Date("2026-10-03T10:00:00Z");
const slot = (id: number, position: number, iso: string, extra: Partial<ScheduleSlotRow> = {}): ScheduleSlotRow => ({ id, pollId: 1, position, scheduledAt: new Date(iso), queueAt: null, remindMode: "AUTO", map: null, quorumAnnouncedAt: null, createdAt: NOW, ...extra });
const vote = (slotId: number, user: string): ScheduleVoteRow => ({ id: slotId * 1000 + Number(user.replace(/\D/g, "")), pollId: 1, slotId, discordUserId: user, discordDisplayName: user, createdAt: NOW });
const pick = (slotId: number, user: string, key: string): AgentPickRow => ({ id: slotId * 1000 + Number(user.replace(/\D/g, "")), slotId, discordUserId: user, agentKey: key, createdAt: NOW, updatedAt: NOW });
const view = (over: Partial<ScheduleView> = {}): ScheduleView => ({
  poll: { id: 1, guildId: "g", status: "OPEN", timezone: "Africa/Cairo", channelId: "c", messageId: "m", agentBoardMessageId: null, agentBoardClaimedAt: null, createdAt: NOW, updatedAt: NOW },
  slots: [slot(11, 1, "2026-10-10T16:00:00Z", { map: "Ascent" }), slot(12, 2, "2026-10-11T16:00:00Z")],
  votes: [],
  declines: [],
  picks: [],
  ...over,
});
const fieldsOf = (b: ReturnType<typeof buildAgentBoard>, i = 0) => b.embeds[i]!.toJSON().fields ?? [];

describe("buildAgentBoard — the public AGENT SELECT lineup", () => {
  it("says so plainly when nobody has voted yet, with no empty cards, and still offers PICK AGENT", () => {
    const b = buildAgentBoard(view(), [], undefined, NOW);
    expect(b.embeds).toHaveLength(0);
    expect(b.content).toContain("AGENT SELECT");
    expect(b.content).toContain("Nobody has locked in");
    const btn = b.components[0]!.toJSON().components[0] as { custom_id: string; label: string };
    expect(btn).toMatchObject({ custom_id: "sched:1:agents", label: "PICK AGENT" });
  });

  it("shows each picked agent over the player who picked it, three across, in role order", () => {
    const v = view({
      votes: [vote(11, "u1"), vote(11, "u2"), vote(11, "u3"), vote(11, "u4")],
      picks: [pick(11, "u1", "killjoy"), pick(11, "u2", "jett"), pick(11, "u3", "omen")],
    });
    const b = buildAgentBoard(v, [], undefined, NOW);
    expect(b.embeds).toHaveLength(1); // slot 2 has no votes, so no card
    const fields = fieldsOf(b);
    const lineup = fields.filter((f) => f.inline);
    expect(lineup.map((f) => f.name.replace(/^\S+ /, ""))).toEqual(["JETT", "OMEN", "KILLJOY"]); // duelist, controller, sentinel
    expect(lineup.map((f) => f.value)).toEqual(["<@u2>", "<@u3>", "<@u1>"]);
    expect(b.embeds[0]!.toJSON().title).toContain("SAT 10/10 · 19:00");
    expect(b.embeds[0]!.toJSON().description).toContain("ASCENT");
    expect(b.embeds[0]!.toJSON().description).toContain("3/4");
  });

  it("lists voters who haven't picked yet as still choosing", () => {
    const v = view({ votes: [vote(11, "u1"), vote(11, "u2")], picks: [pick(11, "u1", "jett")] });
    const fields = fieldsOf(buildAgentBoard(v, [], undefined, NOW));
    const choosing = fields.find((f) => f.name.includes("STILL CHOOSING"))!;
    expect(choosing.value).toBe("<@u2>");
    expect(choosing.inline).toBeFalsy();
  });

  it("never shows another slot's picks, and says MAP TBD when no map is set", () => {
    const v = view({ votes: [vote(11, "u1"), vote(12, "u1")], picks: [pick(11, "u1", "jett"), pick(12, "u1", "sova")] });
    const b = buildAgentBoard(v, [], undefined, NOW);
    expect(b.embeds).toHaveLength(2);
    expect(fieldsOf(b, 0)[0]!.name).toContain("JETT");
    expect(visibleText({ embeds: [b.embeds[0]!] })).not.toContain("SOVA");
    expect(fieldsOf(b, 1)[0]!.name).toContain("SOVA");
    expect(b.embeds[1]!.toJSON().description).toContain("MAP TBD");
  });

  it("skips slots that have already started", () => {
    const v = view({ slots: [slot(11, 1, "2026-10-02T16:00:00Z"), slot(12, 2, "2026-10-11T16:00:00Z")], votes: [vote(11, "u1"), vote(12, "u2")] });
    const b = buildAgentBoard(v, [], undefined, NOW);
    expect(b.embeds).toHaveLength(1);
    expect(b.embeds[0]!.toJSON().title).toContain("SUN 11/10");
  });

  it("names player-suggested agents, uses the portrait emoji when uploaded, and turns green at 5 voters", () => {
    const custom: CustomAgentRow[] = [{ id: 1, guildId: "g", key: "newguy", displayName: "Newguy", role: "CONTROLLER", suggestedByUserId: "u9", suggestedByName: "X", createdAt: NOW }];
    const emojis = agentEmojiMapFrom([{ id: "111111111111111111", name: "agent_jett" }]);
    const v = view({ votes: ["u1", "u2", "u3", "u4", "u5"].map((u) => vote(11, u)), picks: [pick(11, "u1", "jett"), pick(11, "u2", "newguy")] });
    const b = buildAgentBoard(v, custom, emojis, NOW);
    const names = fieldsOf(b).filter((f) => f.inline).map((f) => f.name);
    expect(names[0]).toBe("<:agent_jett:111111111111111111> JETT");
    expect(names[1]).toBe("☁️ NEWGUY");
    expect(b.embeds[0]!.toJSON().color).toBe(0x3bd671);
  });

  it("stays inside Discord's limits with 10 slots and a huge number of voters (no roster yet)", () => {
    const slots = Array.from({ length: 10 }, (_, i) => slot(20 + i, i + 1, `2026-10-${String(10 + i).padStart(2, "0")}T16:00:00Z`));
    const votes = slots.flatMap((s) => Array.from({ length: 40 }, (_, i) => vote(s.id, `u${i}`)));
    const picks = slots.flatMap((s) => Array.from({ length: 20 }, (_, i) => pick(s.id, `u${i}`, ["jett", "sova", "omen", "sage", "raze", "fade", "viper", "cypher", "neon", "skye", "astra", "chamber", "reyna", "kayo", "harbor", "killjoy", "yoru", "gekko", "clove", "vyse"][i]!)));
    const b = buildAgentBoard(view({ slots, votes, picks }), [], undefined, NOW);
    expect(b.embeds.length).toBeLessThanOrEqual(10);
    for (const e of b.embeds) expect((e.toJSON().fields ?? []).length).toBeLessThanOrEqual(25);
    expect(b.embeds.reduce((n, e) => n + JSON.stringify(e.toJSON()).length, 0)).toBeLessThan(6000);
  });

  it("has no card and no button once the schedule is cancelled", () => {
    const v = view({ votes: [vote(11, "u1")] });
    const b = buildAgentBoard({ ...v, poll: { ...v.poll, status: "CANCELLED" } }, [], undefined, NOW);
    expect(b.embeds).toHaveLength(0);
    expect(b.components).toHaveLength(0);
    expect(b.content).toContain("cancelled");
  });

  it("never contains a mention in the message text (an embed can't notify, and nothing here should)", () => {
    const v = view({ votes: [vote(11, "u1")], picks: [pick(11, "u1", "jett")] });
    expect(buildAgentBoard(v, [], undefined, NOW).content).not.toContain("<@");
  });
});
