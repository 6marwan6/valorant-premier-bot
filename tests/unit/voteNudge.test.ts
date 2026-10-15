import { describe, expect, it } from "vitest";
import { VOTE_NUDGE_AFTER_MS, buildVoteNudgeDm, selectVoteNudgeRecipients } from "../../src/modules/schedules/voteNudge.js";

const HOUR = 60 * 60 * 1000;
const created = new Date("2031-06-25T10:00:00Z");
const poll = { id: 7, guildId: "g1", channelId: "c1", messageId: "m1", status: "OPEN", timezone: "Africa/Cairo", createdAt: created } as never;
const slot = (id: number, iso: string, extra: object = {}) => ({ id, pollId: 7, position: id, scheduledAt: new Date(iso), queueAt: null, map: null, ...extra }) as never;
const player = (id: string, extra: object = {}) => ({ id: Number(id.replace(/\D/g, "") || 1), discordUserId: id, displayName: id.toUpperCase(), active: true, kind: "PLAYER", ...extra }) as never;
const slots = [slot(1, "2031-06-28T16:00:00Z"), slot(2, "2031-06-29T16:00:00Z")];
const afterADay = new Date(created.getTime() + VOTE_NUDGE_AFTER_MS);

const select = (over: Record<string, unknown> = {}) =>
  selectVoteNudgeRecipients({ poll, slots, votes: [], declines: [], roster: [player("a"), player("b"), player("c")], now: afterADay, ...over } as never);

describe("selectVoteNudgeRecipients", () => {
  it("waits a full day after the schedule was posted", () => {
    expect(select({ now: new Date(afterADay.getTime() - 1) }).recipients).toHaveLength(0);
    expect(select().recipients).toHaveLength(3);
  });

  it("skips anyone who voted for a slot or said they can't play any day", () => {
    const r = select({ votes: [{ slotId: 1, discordUserId: "a" }], declines: [{ discordUserId: "b" }] });
    expect(r.recipients.map((p: { discordUserId: string }) => p.discordUserId)).toEqual(["c"]);
  });

  it("never nudges server members, removed players, or anyone off the roster", () => {
    const r = select({ roster: [player("a"), player("m", { kind: "MEMBER" }), player("x", { active: false })] });
    expect(r.recipients.map((p: { discordUserId: string }) => p.discordUserId)).toEqual(["a"]);
  });

  it("only lists slots that are still ahead, and sends nothing once all have started", () => {
    const r = select({ now: new Date("2031-06-28T17:00:00Z") });
    expect(r.upcomingSlots.map((s: { id: number }) => s.id)).toEqual([2]);
    expect(select({ now: new Date("2031-06-30T00:00:00Z") }).recipients).toHaveLength(0);
  });

  it("uses the queue time, not the nominal time, to decide a slot has passed", () => {
    const early = [slot(1, "2031-06-28T16:00:00Z", { queueAt: new Date("2031-06-28T15:00:00Z") })];
    expect(select({ slots: early, now: new Date("2031-06-28T15:30:00Z") }).recipients).toHaveLength(0);
  });

  it("does nothing for a cancelled poll or one with no posted message", () => {
    expect(select({ poll: { ...(poll as object), status: "CANCELLED" } }).recipients).toHaveLength(0);
    expect(select({ poll: { ...(poll as object), messageId: null } }).recipients).toHaveLength(0);
  });
});

describe("buildVoteNudgeDm", () => {
  const dm = (s = slots, p = player("a")) => buildVoteNudgeDm({ player: p, poll, upcomingSlots: s });

  it("lists each open slot with the map, links the schedule message and says how many make a queue", () => {
    const text = buildVoteNudgeDm({ player: player("a"), poll, upcomingSlots: [slot(1, "2031-06-28T16:00:00Z", { map: "Ascent" }), slot(2, "2031-06-29T16:00:00Z")] });
    expect(text).toContain("Hey A");
    expect(text).toContain("SAT 28/06 · 19:00 · 🗺️ Ascent");
    expect(text).toContain("SUN 29/06 · 19:00");
    expect(text).not.toMatch(/SUN 29\/06 · 19:00 · 🗺️/); // no map set -> nothing invented
    expect(text).toContain("https://discord.com/channels/g1/c1/m1");
    expect(text).toContain("We need 5 to queue");
    expect(text).toContain("can't play any day");
  });

  it("shows the queue time when the admin set one", () => {
    expect(dm([slot(1, "2031-06-28T16:00:00Z", { queueAt: new Date("2031-06-28T15:30:00Z") })])).toContain("SAT 28/06 · 18:30");
  });

  it("is stable for a given player and poll, and varies in wording between players", () => {
    expect(dm()).toBe(dm());
    const openers = new Set(["a", "b", "c", "d", "e", "f", "g"].map((id) => dm(slots, player(id)).split("\n")[0]!.replace(/^Hey \w+, /, "")));
    expect(openers.size).toBeGreaterThan(1);
  });
});
