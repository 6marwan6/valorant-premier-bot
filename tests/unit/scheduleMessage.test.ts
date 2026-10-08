import { describe, expect, it } from "vitest";
import type { ScheduleView } from "../../src/database/repositories/scheduleRepository.js";
import type { ScheduleSlotRow, ScheduleVoteRow } from "../../src/database/schema/schedules.js";
import { buildQuorumMessage, buildScheduleMessage, buildSlotReminderMessage } from "../../src/modules/schedules/scheduleMessage.js";
import { agentEmojiMapFrom } from "../../src/modules/agents/agentEmojis.js";
import { visibleText } from "./helpers/embedText.js";

const TZ = "Africa/Cairo";
const NOW = new Date("2026-10-03T10:00:00Z");

function slot(id: number, position: number, iso: string, extra: Partial<ScheduleSlotRow> = {}): ScheduleSlotRow {
  return { id, pollId: 1, position, scheduledAt: new Date(iso), queueAt: null, remindMode: "AUTO", map: null, quorumAnnouncedAt: null, createdAt: NOW, ...extra };
}
function vote(slotId: number, user: string, name = user): ScheduleVoteRow {
  return { id: slotId * 100 + Number(user.replace(/\D/g, "") || 0), pollId: 1, slotId, discordUserId: user, discordDisplayName: name, createdAt: NOW };
}
function view(over: Partial<ScheduleView> = {}): ScheduleView {
  return {
    poll: { id: 1, guildId: "g", status: "OPEN", timezone: TZ, channelId: "c", messageId: "m", agentBoardMessageId: null, agentBoardClaimedAt: null, createdAt: NOW, updatedAt: NOW },
    slots: [slot(11, 1, "2026-10-10T16:00:00Z"), slot(12, 2, "2026-10-11T16:00:00Z")],
    votes: [],
    declines: [],
    picks: [],
    ...over,
  };
}
const embed = (m: ReturnType<typeof buildScheduleMessage>) => m.embeds[0]!.toJSON();
/** The second embed: who voted for each slot, who can't play, who hasn't voted. */
const who = (m: ReturnType<typeof buildScheduleMessage>) => m.embeds[1]!.toJSON();
const buttons = (m: ReturnType<typeof buildScheduleMessage>) => m.components.flatMap((r) => r.toJSON().components as Array<{ custom_id: string; label: string; disabled?: boolean; style: number }>);

describe("buildScheduleMessage — the weekly schedule card", () => {
  it("has the Valorant Premier look: red border, angular banner, board with a row per slot", () => {
    const m = buildScheduleMessage(view(), [], NOW);
    expect(m.content).toContain("VALORANT PREMIER");
    expect(m.content).toContain("WEEKLY SCHEDULE");
    expect(embed(m).color).toBe(0xff4655);
    expect(embed(m).title).toContain("PREMIER WEEK");
    const desc = embed(m).description!;
    expect(desc).toContain("Need 5 to queue");
    expect(desc).toContain("SAT 10/10  19:00");
    expect(desc).toContain("SUN 11/10  19:00");
    expect(desc).toContain("□□□□□ 0/5");
  });

  it("shows a vote bar and who voted for each slot", () => {
    const v = view({ votes: [vote(11, "u1", "Ahmed"), vote(11, "u2", "Omar"), vote(12, "u1", "Ahmed")] });
    const m = buildScheduleMessage(v, [], NOW);
    const blocks = who(m).description!.split("\n\n");
    expect(embed(m).description).toContain("■■□□□ 2/5");
    expect(blocks[0]).toContain("SAT 10/10 · 19:00");
    expect(blocks[0]).toContain("2/5");
    // Voters are real @mentions (2026-10-04), not typed names.
    expect(blocks[0]).toContain("<@u1>");
    expect(blocks[0]).toContain("<@u2>");
    expect(blocks[1]).toContain("<@u1>");
    expect(embed(m).description).toContain("needs **3** more");
  });

  it("turns green and announces MATCH ON when a slot has 5 votes; the top slot wins", () => {
    const five = ["u1", "u2", "u3", "u4", "u5"].map((u) => vote(12, u));
    const m = buildScheduleMessage(view({ votes: [...five, vote(11, "u1"), vote(11, "u2")] }), [], NOW);
    expect(embed(m).color).toBe(0x3bd671);
    expect(embed(m).description).toContain("MATCH ON → SUN 11/10 · 19:00");
    expect(embed(m).description).toContain("★ ON");
    expect(buttons(m).find((b) => b.custom_id.endsWith(":vote:12"))!.style).toBe(3); // Success
    expect(buttons(m).find((b) => b.custom_id.endsWith(":vote:11"))!.style).toBe(2); // Secondary
  });

  it("shows the queue time on the board and in the MATCH ON line", () => {
    const queued = view({
      slots: [slot(11, 1, "2026-10-10T16:00:00Z", { queueAt: new Date("2026-10-10T16:30:00Z") })],
      votes: ["u1", "u2", "u3", "u4", "u5"].map((u) => vote(11, u)),
    });
    const m = buildScheduleMessage(queued, [], NOW);
    expect(embed(m).description).toContain("19:00▸19:30");
    expect(embed(m).description).toContain("queue 19:30");
  });

  it("lists people who can't play any day, and (with a roster) who hasn't voted", () => {
    const roster = [
      { discordUserId: "u1", displayName: "Ahmed", role: "DUELIST" as const },
      { discordUserId: "u2", displayName: "Omar" },
      { discordUserId: "u3", displayName: "Hassan" },
    ];
    const v = view({
      votes: [vote(11, "u1", "Ahmed")],
      declines: [{ id: 1, pollId: 1, discordUserId: "u2", discordDisplayName: "Omar", createdAt: NOW }],
    });
    const text = who(buildScheduleMessage(v, roster, NOW)).description!;
    expect(text).toContain("🚫 **Can't play any day** · 1");
    expect(text).toContain("⚪ **No vote yet** · 1");
    expect(visibleText(buildScheduleMessage(v, roster, NOW))).toContain("⚔️ <@u1>");
    // Without a roster there is nobody to call out as "not voted".
    expect(who(buildScheduleMessage(v, [], NOW)).description).not.toContain("No vote yet");
  });

  it("has one button per slot plus 'CAN'T PLAY ANY DAY', and disables slots that have started", () => {
    const v = view({ slots: [slot(11, 1, "2026-10-02T16:00:00Z"), slot(12, 2, "2026-10-11T16:00:00Z")] });
    const b = buttons(buildScheduleMessage(v, [], NOW));
    expect(b.map((x) => x.custom_id)).toEqual(["sched:1:vote:11", "sched:1:vote:12", "sched:1:decline", "sched:1:agents"]);
    expect(b[0]!.disabled).toBe(true);
    expect(b[1]!.disabled).toBeFalsy();
    expect(b[2]!.label).toBe("CAN'T PLAY ANY DAY");
    expect(b[2]!.style).toBe(4); // Danger
  });

  it("lays out 10 slots in two rows plus the decline row, within Discord's 5x5 limit", () => {
    const slots = Array.from({ length: 10 }, (_, i) => slot(20 + i, i + 1, `2026-10-${String(10 + i).padStart(2, "0")}T16:00:00Z`));
    const m = buildScheduleMessage(view({ slots }), [], NOW);
    expect(m.components).toHaveLength(3);
    expect(m.components.every((r) => r.components.length <= 5)).toBe(true);
    expect(who(m).description!.length).toBeLessThanOrEqual(4096);
  });

  it("cancelled: grey, struck through, no buttons", () => {
    const v = view();
    const m = buildScheduleMessage({ ...v, poll: { ...v.poll, status: "CANCELLED" } }, [], NOW);
    expect(m.content).toContain("CANCELLED");
    expect(embed(m).color).toBe(0x4f545c);
    expect(embed(m).title).toContain("~~");
    expect(m.components).toHaveLength(0);
    expect(m.embeds).toHaveLength(1); // no "who's in" once cancelled
  });

  it("is two embeds with blank lines between blocks — status first, then who's in — instead of one packed embed", () => {
    const m = buildScheduleMessage(view({ votes: [vote(11, "u1")] }), [{ discordUserId: "u2", displayName: "O" }], NOW);
    expect(m.embeds).toHaveLength(2);
    expect(embed(m).fields ?? []).toHaveLength(0);
    expect(who(m).title).toBe("WHO'S IN");
    expect(who(m).description!.split("\n\n").length).toBeGreaterThanOrEqual(3); // slot 1, slot 2, no vote yet
    expect(who(m).footer?.text).toContain("Schedule #1");
  });

  it("keeps the description under Discord's limit for a huge slot, and never prints a typed name (mentions only)", () => {
    const votes = Array.from({ length: 600 }, (_, i) => vote(11, `u${i}`, `**x${i}**_${"z".repeat(30)}`));
    const m = buildScheduleMessage(view({ votes }), [], NOW);
    expect(who(m).description!.length).toBeLessThanOrEqual(4096);
    expect(m.embeds.reduce((n, e) => n + JSON.stringify(e.toJSON()).length, 0)).toBeLessThan(6000); // Discord's limit across all embeds
    expect(who(m).description).toContain("<@u0>");
    expect(who(m).description).not.toContain("x0");
  });
});

describe("buildQuorumMessage — squad locked", () => {
  it("lists the lineup, the queue time, pings the voters and states the reminder plan", () => {
    const s = slot(11, 1, "2026-10-10T16:00:00Z", { queueAt: new Date("2026-10-10T16:30:00Z") });
    const voters = ["u1", "u2", "u3", "u4", "u5"].map((u, i) => vote(11, u, `P${i}`));
    const roster = [{ discordUserId: "u1", displayName: "P0", role: "DUELIST" as const, preferredAgent: "Jett" }];
    const q = buildQuorumMessage(s, voters, roster, TZ);
    expect(q.mentionUserIds).toEqual(["u1", "u2", "u3", "u4", "u5"]);
    expect(q.content).toContain("<@u1>");
    expect(q.embeds[0]!.toJSON().title).toContain("SQUAD LOCKED");
    const text = visibleText(q);
    expect(text).toContain("⚔️ <@u1> · Jett");
    expect(text).toContain("Queue 19:30");
    expect(text).toContain("5 hours");
    expect(text).toContain("15 minutes");
  });
});

describe("buildSlotReminderMessage", () => {
  const s = slot(11, 1, "2026-10-10T16:00:00Z");
  const voters = ["u1", "u2", "u3", "u4", "u5"].map((u) => vote(11, u));

  it("5 hours: amber, pings the voters, says when to queue", () => {
    const r = buildSlotReminderMessage(s, voters, [], TZ, 300, 1);
    const e = r.embeds[0]!.toJSON();
    expect(e.title).toContain("5 HOURS");
    expect(e.color).toBe(0xf5a623);
    expect(r.content).toContain("<@u1>");
    expect(e.description).toContain("QUEUE AT 19:00");
    expect(e.description).not.toContain("we're queuing later");
  });

  it("15 minutes: red and urgent", () => {
    const r = buildSlotReminderMessage(s, voters, [], TZ, 15, 1);
    const e = r.embeds[0]!.toJSON();
    expect(e.title).toContain("15 MINUTES");
    expect(e.color).toBe(0xff4655);
    expect(r.content).toContain("🚨");
  });

  it("with a queue-time edit, the reminder tells them 'queue at 19:30' and the live countdown targets it", () => {
    const queued = slot(11, 1, "2026-10-10T16:00:00Z", { queueAt: new Date("2026-10-10T16:30:00Z") });
    const e = buildSlotReminderMessage(queued, voters, [], TZ, 300, 1).embeds[0]!.toJSON();
    expect(e.description).toContain("QUEUE AT 19:30");
    expect(e.description).toContain("slot time 19:00");
    expect(e.description).toContain(`<t:${Math.floor(new Date("2026-10-10T16:30:00Z").getTime() / 1000)}:R>`);
  });
});

describe("roster pings, maps and agent picks on the schedule card (2026-10-04)", () => {
  const roster = [
    { discordUserId: "u1", displayName: "Ahmed", role: "DUELIST" as const },
    { discordUserId: "u2", displayName: "Omar" },
    { discordUserId: "u3", displayName: "Hassan" },
  ];

  it("@mentions the whole roster in the message text, so posting it notifies the team", () => {
    const m = buildScheduleMessage(view(), roster, NOW);
    expect(m.content).toContain("<@u1> <@u2> <@u3>");
    expect(m.content.length).toBeLessThan(2000);
  });

  it("has no ping line without a roster, and none once cancelled", () => {
    expect(buildScheduleMessage(view(), [], NOW).content).not.toContain("<@");
    const v = view();
    expect(buildScheduleMessage({ ...v, poll: { ...v.poll, status: "CANCELLED" } }, roster, NOW).content).not.toContain("<@");
  });

  it("shows the map in the slot heading and on the board (a MAP column only once one is set)", () => {
    const withMap = view({ slots: [slot(11, 1, "2026-10-10T16:00:00Z", { map: "Ascent" }), slot(12, 2, "2026-10-11T16:00:00Z")] });
    const m = buildScheduleMessage(withMap, [], NOW);
    expect(embed(m).description).toContain("MAP");
    expect(embed(m).description).toMatch(/SAT 10\/10 {2}19:00 {2}Ascent/);
    expect(embed(m).description).toMatch(/SUN 11\/10 {2}19:00 {2}— /);
    const [first, second] = who(m).description!.split("\n\n");
    expect(first).toContain("🗺️ ASCENT");
    expect(second).not.toContain("🗺️");
    expect(embed(buildScheduleMessage(view(), [], NOW)).description).not.toContain("MAP");
  });

  it("lists each voter with the agent they picked, one per line", () => {
    const v = view({
      votes: [vote(11, "u1"), vote(11, "u2")],
      picks: [{ id: 1, slotId: 11, discordUserId: "u1", agentKey: "jett", createdAt: NOW, updatedAt: NOW }],
    });
    const block = who(buildScheduleMessage(v, roster, NOW)).description!.split("\n\n")[0]!;
    expect(block.split("\n").slice(1).join("\n")).toBe("⚔️ <@u1> · **Jett**\n<@u2>");
  });

  it("names a player-suggested agent from the custom list", () => {
    const v = view({
      votes: [vote(11, "u2")],
      picks: [{ id: 1, slotId: 11, discordUserId: "u2", agentKey: "newguy", createdAt: NOW, updatedAt: NOW }],
    });
    const custom = [{ id: 1, guildId: "g", key: "newguy", displayName: "Newguy", role: "DUELIST" as const, suggestedByUserId: "u1", suggestedByName: "Ahmed", createdAt: NOW }];
    expect(who(buildScheduleMessage(v, roster, NOW, custom)).description).toContain("<@u2> · **Newguy**");
  });

  it("has a PICK AGENT button next to CAN'T PLAY ANY DAY", () => {
    const row = buildScheduleMessage(view(), [], NOW).components.at(-1)!.toJSON().components as Array<{ custom_id: string; label: string }>;
    expect(row.map((b) => b.custom_id)).toEqual(["sched:1:decline", "sched:1:agents"]);
    expect(row[1]!.label).toBe("PICK AGENT");
  });

  it("the squad-locked card and the reminder show the map and each player's picked agent", () => {
    const s = slot(11, 1, "2026-10-10T16:00:00Z", { map: "Haven" });
    const voters = ["u1", "u2", "u3", "u4", "u5"].map((u) => vote(11, u));
    const picks = [{ id: 1, slotId: 11, discordUserId: "u1", agentKey: "kayo", createdAt: NOW, updatedAt: NOW }];
    const q = visibleText(buildQuorumMessage(s, voters, [{ discordUserId: "u1", displayName: "A", preferredAgent: "Jett" }], TZ, picks));
    expect(q).toContain("Map: Haven");
    expect(q).toContain("<@u1> · **KAY/O**"); // the pick wins over the profile's preferred agent
    const r = visibleText(buildSlotReminderMessage(s, voters, [], TZ, 300, 1, picks));
    expect(r).toContain("Map: Haven");
    expect(r).toContain("<@u1> · **KAY/O**");
  });

  it("shows the picked agent's portrait emoji next to its name once portraits are uploaded, and nothing extra before", () => {
    const v = view({ votes: [vote(11, "u1"), vote(11, "u2")], picks: [{ id: 1, slotId: 11, discordUserId: "u1", agentKey: "jett", createdAt: NOW, updatedAt: NOW }] });
    const emojis = agentEmojiMapFrom([{ id: "111111111111111111", name: "agent_jett" }]);
    expect(who(buildScheduleMessage(v, [], NOW, [], emojis)).description).toContain("<@u1> · <:agent_jett:111111111111111111> **Jett**");
    expect(who(buildScheduleMessage(v, [], NOW, [], undefined)).description).toContain("<@u1> · **Jett**");
    const u2Line = who(buildScheduleMessage(v, [], NOW, [], emojis)).description!.split("\n").find((l) => l.startsWith("<@u2>"))!;
    expect(u2Line).toBe("<@u2>"); // only the one who picked gets a portrait
  });
});
