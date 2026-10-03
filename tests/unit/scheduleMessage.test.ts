import { describe, expect, it } from "vitest";
import type { ScheduleView } from "../../src/database/repositories/scheduleRepository.js";
import type { ScheduleSlotRow, ScheduleVoteRow } from "../../src/database/schema/schedules.js";
import { buildQuorumMessage, buildScheduleMessage, buildSlotReminderMessage } from "../../src/modules/schedules/scheduleMessage.js";
import { visibleText } from "./helpers/embedText.js";

const TZ = "Africa/Cairo";
const NOW = new Date("2026-10-03T10:00:00Z");

function slot(id: number, position: number, iso: string, extra: Partial<ScheduleSlotRow> = {}): ScheduleSlotRow {
  return { id, pollId: 1, position, scheduledAt: new Date(iso), queueAt: null, remindMode: "AUTO", quorumAnnouncedAt: null, createdAt: NOW, ...extra };
}
function vote(slotId: number, user: string, name = user): ScheduleVoteRow {
  return { id: slotId * 100 + Number(user.replace(/\D/g, "") || 0), pollId: 1, slotId, discordUserId: user, discordDisplayName: name, createdAt: NOW };
}
function view(over: Partial<ScheduleView> = {}): ScheduleView {
  return {
    poll: { id: 1, guildId: "g", status: "OPEN", timezone: TZ, channelId: "c", messageId: "m", createdAt: NOW, updatedAt: NOW },
    slots: [slot(11, 1, "2026-10-10T16:00:00Z"), slot(12, 2, "2026-10-11T16:00:00Z")],
    votes: [],
    declines: [],
    ...over,
  };
}
const embed = (m: ReturnType<typeof buildScheduleMessage>) => m.embeds[0]!.toJSON();
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
    const fields = embed(m).fields!;
    expect(embed(m).description).toContain("■■□□□ 2/5");
    expect(fields[0]!.name).toContain("SAT 10/10 · 19:00");
    expect(fields[0]!.name).toContain("2/5");
    expect(fields[0]!.value).toContain("Ahmed");
    expect(fields[0]!.value).toContain("Omar");
    expect(fields[1]!.value).toContain("Ahmed");
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
    const names = embed(buildScheduleMessage(v, roster, NOW)).fields!.map((f) => f.name);
    expect(names).toContain("🚫 Can't play any day · 1");
    expect(names).toContain("⚪ No vote yet · 1");
    expect(visibleText(buildScheduleMessage(v, roster, NOW))).toContain("⚔️ **Ahmed**");
    // Without a roster there is nobody to call out as "not voted".
    expect(embed(buildScheduleMessage(v, [], NOW)).fields!.map((f) => f.name).join()).not.toContain("No vote yet");
  });

  it("has one button per slot plus 'CAN'T PLAY ANY DAY', and disables slots that have started", () => {
    const v = view({ slots: [slot(11, 1, "2026-10-02T16:00:00Z"), slot(12, 2, "2026-10-11T16:00:00Z")] });
    const b = buttons(buildScheduleMessage(v, [], NOW));
    expect(b.map((x) => x.custom_id)).toEqual(["sched:1:vote:11", "sched:1:vote:12", "sched:1:decline"]);
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
    expect(embed(m).fields!.length).toBeLessThanOrEqual(25);
  });

  it("cancelled: grey, struck through, no buttons", () => {
    const v = view();
    const m = buildScheduleMessage({ ...v, poll: { ...v.poll, status: "CANCELLED" } }, [], NOW);
    expect(m.content).toContain("CANCELLED");
    expect(embed(m).color).toBe(0x4f545c);
    expect(embed(m).title).toContain("~~");
    expect(m.components).toHaveLength(0);
  });

  it("escapes markdown in names and keeps every field under Discord's limit", () => {
    const votes = Array.from({ length: 60 }, (_, i) => vote(11, `u${i}`, `**x${i}**_${"z".repeat(30)}`));
    const m = buildScheduleMessage(view({ votes }), [], NOW);
    expect(embed(m).fields!.every((f) => f.value.length <= 1024)).toBe(true);
    expect(embed(m).fields![0]!.value).toContain("\\*\\*x0");
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
    expect(text).toContain("⚔️ **P0** · Jett");
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
