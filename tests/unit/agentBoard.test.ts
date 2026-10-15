import { describe, expect, it } from "vitest";
import type { ScheduleView } from "../../src/database/repositories/scheduleRepository.js";
import type { AgentPickKind, AgentPickRow, CustomAgentRow, ScheduleSlotRow, ScheduleVoteRow } from "../../src/database/schema/schedules.js";
import { buildAgentBoard } from "../../src/modules/agents/agentBoard.js";
import { agentEmojiMapFrom } from "../../src/modules/agents/agentEmojis.js";
import { visibleText } from "./helpers/embedText.js";

const NOW = new Date("2026-10-03T10:00:00Z");
const slot = (id: number, position: number, iso: string, extra: Partial<ScheduleSlotRow> = {}): ScheduleSlotRow => ({ id, pollId: 1, position, scheduledAt: new Date(iso), queueAt: null, remindMode: "AUTO", map: null, quorumAnnouncedAt: null, createdAt: NOW, ...extra });
const vote = (slotId: number, user: string): ScheduleVoteRow => ({ id: slotId * 1000 + Number(user.replace(/\D/g, "")), pollId: 1, slotId, discordUserId: user, discordDisplayName: user, createdAt: NOW });
let nextId = 1;
const pick = (user: string, key: string, kind: AgentPickKind = "MAIN"): AgentPickRow => ({ id: nextId++, pollId: 1, discordUserId: user, agentKey: key, kind, createdAt: NOW, updatedAt: NOW });
const view = (over: Partial<ScheduleView> = {}): ScheduleView => ({
  poll: { id: 1, guildId: "g", status: "OPEN", timezone: "Africa/Cairo", channelId: "c", messageId: "m", agentBoardMessageId: null, agentBoardClaimedAt: null, createdAt: NOW, updatedAt: NOW },
  slots: [slot(11, 1, "2026-10-10T16:00:00Z", { map: "Ascent" }), slot(12, 2, "2026-10-11T16:00:00Z", { map: "Ascent" })],
  votes: [],
  declines: [],
  picks: [],
  ...over,
});
const fieldsOf = (b: ReturnType<typeof buildAgentBoard>) => b.embeds[0]!.toJSON().fields ?? [];

describe("buildAgentBoard — the public AGENT SELECT lineup (one squad per schedule)", () => {
  it("says so plainly when nobody has voted yet, with no empty card, and still offers PICK AGENT", () => {
    const b = buildAgentBoard(view(), [], undefined, NOW);
    expect(b.embeds).toHaveLength(0);
    expect(b.content).toContain("AGENT SELECT");
    expect(b.content).toContain("Nobody has locked in");
    const btn = b.components[0]!.toJSON().components[0] as { custom_id: string; label: string };
    expect(btn).toMatchObject({ custom_id: "sched:1:agents", label: "PICK AGENT" });
  });

  it("is ONE card for the whole schedule, however many slots there are", () => {
    const v = view({ votes: [vote(11, "u1"), vote(12, "u1"), vote(12, "u2")], picks: [pick("u1", "jett"), pick("u2", "sova")] });
    const b = buildAgentBoard(v, [], undefined, NOW);
    expect(b.embeds).toHaveLength(1);
    expect(b.embeds[0]!.toJSON().title).toContain("THE SQUAD");
    expect(b.content).toContain("ONE SQUAD FOR EVERY SLOT");
  });

  it("shows each main agent over the player, three across, in role order, with the map and the slots", () => {
    const v = view({
      votes: [vote(11, "u1"), vote(11, "u2"), vote(11, "u3"), vote(11, "u4")],
      picks: [pick("u1", "killjoy"), pick("u2", "jett"), pick("u3", "omen")],
    });
    const b = buildAgentBoard(v, [], undefined, NOW);
    const lineup = fieldsOf(b).filter((f) => f.inline);
    expect(lineup.map((f) => f.name.replace(/^\S+ /, ""))).toEqual(["JETT", "OMEN", "KILLJOY"]); // duelist, controller, sentinel
    expect(lineup.map((f) => f.value)).toEqual(["<@u2>", "<@u3>", "<@u1>"]);
    const d = b.embeds[0]!.toJSON().description!;
    expect(d).toContain("ASCENT");
    expect(d).toContain("3/4"); // 3 of the 4 players in the squad have locked in
    expect(d).toContain("SAT 10/10 19:00");
    expect(d).toContain("SUN 11/10 19:00");
  });

  it("shows a player's second agent under their main, and only for players who chose one", () => {
    const v = view({ votes: [vote(11, "u1"), vote(11, "u2")], picks: [pick("u1", "jett"), pick("u1", "reyna", "SECOND"), pick("u2", "sova")] });
    const lineup = fieldsOf(buildAgentBoard(v, [], undefined, NOW)).filter((f) => f.inline);
    expect(lineup[0]!.name).toContain("JETT");
    expect(lineup[0]!.value).toBe("<@u1>\n↳ 2nd: ⚔️ Reyna");
    expect(lineup[1]!.value).toBe("<@u2>"); // no second chosen
  });

  it("counts a player once however many slots they are in, and counts voters across all slots as the squad", () => {
    const v = view({ votes: [vote(11, "u1"), vote(12, "u1"), vote(12, "u2")], picks: [pick("u1", "jett")] });
    const b = buildAgentBoard(v, [], undefined, NOW);
    expect(b.embeds[0]!.toJSON().description).toContain("1/2"); // u1 and u2, not u1 twice
    expect(fieldsOf(b).filter((f) => f.inline)).toHaveLength(1);
    expect(fieldsOf(b).find((f) => f.name.includes("STILL CHOOSING"))!.value).toBe("<@u2>");
  });

  it("lists players who haven't picked a main yet as still choosing — a second alone doesn't count as locked in", () => {
    const v = view({ votes: [vote(11, "u1"), vote(11, "u2")], picks: [pick("u1", "jett")] });
    const choosing = fieldsOf(buildAgentBoard(v, [], undefined, NOW)).find((f) => f.name.includes("STILL CHOOSING"))!;
    expect(choosing.value).toBe("<@u2>");
    expect(choosing.inline).toBeFalsy();
  });

  it("says MAP TBD when no map is set, and flags slots that use a different map", () => {
    const noMap = view({ slots: [slot(11, 1, "2026-10-10T16:00:00Z")], votes: [vote(11, "u1")] });
    expect(buildAgentBoard(noMap, [], undefined, NOW).embeds[0]!.toJSON().description).toContain("MAP TBD");
    const mixed = view({ slots: [slot(11, 1, "2026-10-10T16:00:00Z", { map: "Ascent" }), slot(12, 2, "2026-10-11T16:00:00Z", { map: "Bind" })], votes: [vote(11, "u1")] });
    expect(buildAgentBoard(mixed, [], undefined, NOW).embeds[0]!.toJSON().description).toContain("(+ others)");
  });

  it("leaves out slots that have already started, and players who are only in those", () => {
    const v = view({ slots: [slot(11, 1, "2026-10-02T16:00:00Z"), slot(12, 2, "2026-10-11T16:00:00Z", { map: "Ascent" })], votes: [vote(11, "u1"), vote(12, "u2")], picks: [pick("u1", "jett"), pick("u2", "sova")] });
    const b = buildAgentBoard(v, [], undefined, NOW);
    const d = b.embeds[0]!.toJSON().description!;
    expect(d).toContain("SUN 11/10");
    expect(d).not.toContain("02/10");
    expect(d).toContain("1/1");
    expect(fieldsOf(b).filter((f) => f.inline)).toHaveLength(1);
    expect(fieldsOf(b)[0]!.name).toContain("SOVA");
  });

  it("names player-suggested agents, uses the portrait emoji when uploaded, and turns green at 5 locked in", () => {
    const custom: CustomAgentRow[] = [{ id: 1, guildId: "g", key: "newguy", displayName: "Newguy", role: "CONTROLLER", suggestedByUserId: "u9", suggestedByName: "X", createdAt: NOW }];
    const emojis = agentEmojiMapFrom([{ id: "111111111111111111", name: "agent_jett" }]);
    const users = ["u1", "u2", "u3", "u4", "u5"];
    const picks = [pick("u1", "jett"), pick("u2", "newguy"), pick("u3", "sova"), pick("u4", "sage"), pick("u5", "raze")];
    const b = buildAgentBoard(view({ votes: users.map((u) => vote(11, u)), picks }), custom, emojis, NOW);
    const names = fieldsOf(b).filter((f) => f.inline).map((f) => f.name);
    expect(names).toContain("<:agent_jett:111111111111111111> JETT");
    expect(names).toContain("☁️ NEWGUY");
    expect(b.embeds[0]!.toJSON().color).toBe(0x3bd671);
    const four = buildAgentBoard(view({ votes: users.map((u) => vote(11, u)), picks: picks.slice(0, 4) }), custom, emojis, NOW);
    expect(four.embeds[0]!.toJSON().color).toBe(0xff4655); // 4 of 5 locked: still red
  });

  it("stays inside Discord's limits with a huge number of voters and seconds (no roster yet)", () => {
    const slots = Array.from({ length: 10 }, (_, i) => slot(20 + i, i + 1, `2026-10-${String(10 + i).padStart(2, "0")}T16:00:00Z`));
    const keys = ["jett", "sova", "omen", "sage", "raze", "fade", "viper", "cypher", "neon", "skye", "astra", "chamber", "reyna", "kayo", "harbor", "killjoy", "yoru", "gekko", "clove", "vyse", "breach", "brimstone", "deadlock", "iso", "phoenix"];
    const votes = slots.flatMap((s) => Array.from({ length: 60 }, (_, i) => vote(s.id, `u${i}`)));
    const picks = Array.from({ length: 25 }, (_, i) => [pick(`u${i}`, keys[i]!), pick(`u${i}`, keys[(i + 7) % keys.length]!, "SECOND")]).flat();
    const b = buildAgentBoard(view({ slots, votes, picks }), [], undefined, NOW);
    expect(b.embeds).toHaveLength(1);
    expect(fieldsOf(b).length).toBeLessThanOrEqual(25);
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
    const v = view({ votes: [vote(11, "u1")], picks: [pick("u1", "jett")] });
    expect(buildAgentBoard(v, [], undefined, NOW).content).not.toContain("<@");
  });
});
