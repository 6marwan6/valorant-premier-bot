import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { ButtonInteraction } from "discord.js";
import { createDatabase, type Database } from "../../src/database/client.js";
import { buildAppContext, type AppContext } from "../../src/appContext.js";
import type { DiscordRestClient, ReplyPayload } from "../../src/discord/discordRest.js";
import { runScheduleReminders } from "../../src/services/scheduling/scheduleReminderJob.js";
import { dispatchButton } from "../../src/discord/interactions/dispatchButton.js";
import { logger } from "../../src/config/logger.js";
import { buildVoteCustomId, buildDeclineCustomId } from "../../src/modules/schedules/scheduleCustomId.js";
import { visibleText } from "../unit/helpers/embedText.js";

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function fakeDiscord() {
  let n = 1;
  const sendChannelMessage = vi.fn(async (_channelId: string, _payload: ReplyPayload) => ({ id: `sched-msg-${n++}` }));
  const editChannelMessage = vi.fn(async () => undefined);
  let failNext = false;
  const failing = vi.fn(async (c: string, p: ReplyPayload) => {
    if (failNext) {
      failNext = false;
      throw new Error("simulated Discord outage");
    }
    return sendChannelMessage(c, p);
  });
  return {
    discord: { sendChannelMessage: failing, editChannelMessage } as unknown as DiscordRestClient,
    sendChannelMessage,
    editChannelMessage,
    failNextSend() {
      failNext = true;
    },
    sentTo(channelId: string) {
      return sendChannelMessage.mock.calls.filter(([c]) => c === channelId).map(([, p]) => p);
    },
  };
}

function fakeClick(customId: string, user: { id: string; name: string }, guildId: string) {
  const update = vi.fn(async (_p: unknown) => undefined);
  const followUp = vi.fn(async (_p: unknown) => undefined);
  const reply = vi.fn(async (_p: unknown) => undefined);
  const interaction = {
    customId,
    guildId,
    user: { id: user.id, username: user.name, globalName: user.name, avatar: null },
    member: null,
    deferred: true,
    replied: false,
    isRepliable: () => true,
    update,
    followUp,
    reply,
  } as unknown as ButtonInteraction;
  return { interaction, update, followUp, reply };
}

describeIfDb("Weekly schedule voting + reminders (integration)", () => {
  let db: Database;
  let pool: Pool;
  let ctx: AppContext;
  let fd: ReturnType<typeof fakeDiscord>;
  const stamp = Date.now();
  const guildId = `sched-guild-${stamp}`;
  const channelId = `sched-chan-${stamp}`;

  // Everything is placed far in the future and the job is driven with an explicit `now`, so the test controls "time".
  const base = new Date("2031-06-25T00:00:00Z");
  const at = (h: number, m = 0) => new Date(base.getTime() + h * HOUR + m * MINUTE);
  const users = ["u1", "u2", "u3", "u4", "u5", "u6"].map((id) => ({ id: `${id}-${stamp}`, name: id.toUpperCase() }));

  beforeAll(async () => {
    ({ db, pool } = createDatabase({ DATABASE_URL: databaseUrl! }));
    fd = fakeDiscord();
    ctx = buildAppContext({ discord: fd.discord, db, env: {} as any, logger, llm: null });
    await ctx.repositories.serverConfig.upsert(guildId, { timezone: "Africa/Cairo", matchChannelId: channelId, reminderScheduleMinutes: [300, 15] });
  });
  afterAll(async () => {
    await pool.end();
  });

  async function newPoll(slotsInput: string, now: Date = new Date("2031-06-25T00:00:00Z")) {
    const r = await ctx.services.schedules.create({ guildId, slotsInput, now });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  }
  const vote = (pollId: number, slotId: number, u: (typeof users)[number], now?: Date) =>
    ctx.services.schedules.vote({ guildId, pollId, slotId, discordUserId: u.id, displayName: u.name, now: now ?? new Date("2031-06-26T00:00:00Z") });

  it("creates a poll with sorted slots in the team timezone, and refuses a second open poll", async () => {
    const { poll, slots } = await newPoll("sun 8pm, sat 7pm");
    // 25 Jun 2031 is a Wednesday; sat = 28 Jun (19:00 Cairo = 16:00Z), sun = 29 Jun.
    expect(slots.map((s) => s.position)).toEqual([1, 2]);
    expect(slots[0]!.scheduledAt.toISOString()).toBe("2031-06-28T16:00:00.000Z");
    expect(slots[1]!.scheduledAt.toISOString()).toBe("2031-06-29T17:00:00.000Z");

    const again = await ctx.services.schedules.create({ guildId, slotsInput: "mon 7pm", now: new Date("2031-06-25T00:00:00Z") });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toContain(`#${poll.id}`);

    await ctx.services.schedules.cancel(guildId);
  });

  it("votes toggle, one row per player and slot, and 'can't play any day' replaces votes (and voting undoes it)", async () => {
    const { poll, slots } = await newPoll("sat 7pm, sun 7pm");
    const [s1, s2] = slots as [(typeof slots)[number], (typeof slots)[number]];

    const a = await vote(poll.id, s1.id, users[0]!);
    expect(a.ok && a.value.action).toBe("added");
    const b = await vote(poll.id, s2.id, users[0]!);
    expect(b.ok && b.value.yourPositions).toEqual([1, 2]);
    const c = await vote(poll.id, s1.id, users[0]!);
    expect(c.ok && c.value.action).toBe("removed");
    expect(c.ok && c.value.yourPositions).toEqual([2]);

    const d = await ctx.services.schedules.decline({ guildId, pollId: poll.id, discordUserId: users[0]!.id, displayName: "U1" });
    expect(d.ok && d.value.changed).toBe(true);
    expect(d.ok && d.value.view.votes.filter((v) => v.discordUserId === users[0]!.id)).toHaveLength(0);
    expect(d.ok && d.value.view.declines).toHaveLength(1);
    const d2 = await ctx.services.schedules.decline({ guildId, pollId: poll.id, discordUserId: users[0]!.id, displayName: "U1" });
    expect(d2.ok && d2.value.changed).toBe(false); // pressing it twice changes nothing
    expect(d2.ok && d2.value.view.declines).toHaveLength(1);

    const back = await vote(poll.id, s1.id, users[0]!);
    expect(back.ok && back.value.view.declines).toHaveLength(0); // voting takes the decline back

    await ctx.services.schedules.cancel(guildId);
  });

  it("rejects votes for a slot that started, a foreign slot, and (with a roster) unregistered users", async () => {
    const { poll, slots } = await newPoll("sat 7pm");
    const late = await vote(poll.id, slots[0]!.id, users[0]!, new Date("2031-06-29T00:00:00Z"));
    expect(late.ok).toBe(false);
    const foreign = await vote(poll.id, 999999999, users[0]!);
    expect(foreign.ok).toBe(false);

    await ctx.repositories.players.upsertByDiscordUserId(guildId, users[1]!.id, {
      displayName: "U2",
      role: "DUELIST",
      agents: ["Jett"],
      preferredAgent: "Jett",
    } as never);
    const stranger = await vote(poll.id, slots[0]!.id, users[0]!);
    expect(stranger.ok).toBe(false);
    if (!stranger.ok) expect(stranger.error).toContain("Premier players");
    const member = await vote(poll.id, slots[0]!.id, users[1]!);
    expect(member.ok).toBe(true);

    await ctx.services.schedules.cancel(guildId);
    await ctx.repositories.players.deactivate(guildId, users[1]!.id);
  });

  it("button flow: update() gets the card, a private confirmation follows, and the 5th vote posts SQUAD LOCKED exactly once", async () => {
    const { poll, slots } = await newPoll("sat 7pm, sun 7pm");
    const slotId = slots[0]!.id;
    const before = fd.sentTo(channelId).length;

    for (const u of users.slice(0, 4)) {
      const click = fakeClick(buildVoteCustomId(poll.id, slotId), u, guildId);
      await dispatchButton(click.interaction, ctx);
      expect(click.update).toHaveBeenCalledTimes(1);
      expect(click.followUp).toHaveBeenCalledTimes(1);
    }
    expect(fd.sentTo(channelId).length).toBe(before); // 4/5 — no squad yet

    const fifth = fakeClick(buildVoteCustomId(poll.id, slotId), users[4]!, guildId);
    await dispatchButton(fifth.interaction, ctx);
    const posted = fd.sentTo(channelId).slice(before);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.content).toContain("WE HAVE A SQUAD");
    expect(posted[0]!.content).toContain(`<@${users[0]!.id}>`);
    expect(visibleText(posted[0]!)).toContain("SQUAD LOCKED");
    const card = fifth.update.mock.calls[0]![0] as { embeds: unknown[]; components: unknown[] };
    expect(card.embeds).toHaveLength(1);
    expect(card.components.length).toBeGreaterThan(0);

    // A 6th vote and a toggle-off/on of the 5th never re-announce.
    await dispatchButton(fakeClick(buildVoteCustomId(poll.id, slotId), users[5]!, guildId).interaction, ctx);
    await dispatchButton(fakeClick(buildVoteCustomId(poll.id, slotId), users[4]!, guildId).interaction, ctx);
    await dispatchButton(fakeClick(buildVoteCustomId(poll.id, slotId), users[4]!, guildId).interaction, ctx);
    expect(fd.sentTo(channelId).slice(before)).toHaveLength(1);

    // Decline button works and answers privately.
    const decline = fakeClick(buildDeclineCustomId(poll.id), users[0]!, guildId);
    await dispatchButton(decline.interaction, ctx);
    expect(decline.update).toHaveBeenCalledTimes(1);
    expect(decline.followUp).toHaveBeenCalledTimes(1);

    await ctx.services.schedules.cancel(guildId);
  });

  it("a Discord failure posting SQUAD LOCKED never undoes the vote", async () => {
    const { poll, slots } = await newPoll("sat 7pm");
    for (const u of users.slice(0, 4)) await vote(poll.id, slots[0]!.id, u);
    fd.failNextSend();
    const click = fakeClick(buildVoteCustomId(poll.id, slots[0]!.id), users[4]!, guildId);
    await dispatchButton(click.interaction, ctx);
    expect(click.update).toHaveBeenCalledTimes(1);
    const view = await ctx.services.schedules.getView(poll.id);
    expect(view!.votes).toHaveLength(5);
    await ctx.services.schedules.cancel(guildId);
  });

  describe("reminders: 5 hours and 15 minutes, highest-voted slot with 5+ votes", () => {
    async function config() {
      return [(await ctx.repositories.serverConfig.getByGuildId(guildId))!];
    }
    const run = async (now: Date) => runScheduleReminders(ctx, await config(), now);
    const mine = () => fd.sentTo(channelId);

    it("sends 5h then 15min for the leading slot, once each, pinging its voters", async () => {
      const { poll, slots } = await newPoll("sat 7pm, sun 7pm"); // sat = 2031-06-28 16:00Z
      const [sat, sun] = slots as [(typeof slots)[number], (typeof slots)[number]];
      for (const u of users.slice(0, 5)) await vote(poll.id, sat.id, u);
      for (const u of users.slice(0, 3)) await vote(poll.id, sun.id, u);
      const sent0 = mine().length;

      const reminders = async () => (await ctx.repositories.schedules.listRemindersBySlot(sat.id)).map((r) => [r.offsetMinutes, r.status]);

      // Before 5h: nothing is due, but the rows exist.
      await run(new Date("2031-06-28T10:00:00Z"));
      expect(mine().length).toBe(sent0);
      expect(await reminders()).toEqual([[300, "PENDING"], [15, "PENDING"]]);

      // 5h before 19:00 Cairo (16:00Z) = 11:00Z.
      const s5 = await run(new Date("2031-06-28T11:01:00Z"));
      expect(s5.slotRemindersSent).toBeGreaterThanOrEqual(1);
      const five = mine().slice(sent0);
      expect(five).toHaveLength(1);
      expect(visibleText(five[0]!)).toContain("5 HOURS");
      expect(five[0]!.content).toContain(`<@${users[0]!.id}>`);
      expect(five[0]!.content).not.toContain(`<@${users[5]!.id}>`);

      // Re-running the same tick (overlapping cron) never re-sends (plan section 50).
      await run(new Date("2031-06-28T11:02:00Z"));
      expect(mine().slice(sent0)).toHaveLength(1);

      // 15 minutes before = 15:45Z.
      await run(new Date("2031-06-28T15:46:00Z"));
      const all = mine().slice(sent0);
      expect(all).toHaveLength(2);
      expect(visibleText(all[1]!)).toContain("15 MINUTES");
      expect(await reminders()).toEqual([[300, "SENT"], [15, "SENT"]]);

      // The non-leading Sunday slot (3 votes) was skipped, never sent.
      await run(new Date("2031-06-29T16:46:00Z"));
      expect(mine().slice(sent0)).toHaveLength(2);
      expect((await ctx.repositories.schedules.listRemindersBySlot(sun.id)).every((r) => r.status === "SKIPPED" || r.status === "PENDING")).toBe(true);

      await ctx.services.schedules.cancel(guildId);
    });

    it("no slot with 5 votes means no reminder at all", async () => {
      const { poll, slots } = await newPoll("sat 7pm");
      for (const u of users.slice(0, 4)) await vote(poll.id, slots[0]!.id, u);
      const before = mine().length;
      await run(new Date("2031-06-28T11:01:00Z"));
      await run(new Date("2031-06-28T15:46:00Z"));
      expect(mine().length).toBe(before);
      const rows = await ctx.repositories.schedules.listRemindersBySlot(slots[0]!.id);
      expect(rows.every((r) => r.status === "SKIPPED")).toBe(true);
      await ctx.services.schedules.cancel(guildId);
    });

    it("the queue-time edit moves the reminders and the message says 'queue at 19:30'", async () => {
      const { poll, slots } = await newPoll("sat 7pm");
      for (const u of users.slice(0, 5)) await vote(poll.id, slots[0]!.id, u);
      await run(new Date("2031-06-28T08:00:00Z")); // create the reminder rows at the slot time
      const edit = await ctx.services.schedules.editSlot({ guildId, position: 1, queueInput: "19:30", now: new Date("2031-06-26T00:00:00Z") });
      expect(edit.ok).toBe(true);
      const rows = await ctx.repositories.schedules.listRemindersBySlot(slots[0]!.id);
      // 19:30 Cairo = 16:30Z; minus 5h = 11:30Z, minus 15min = 16:15Z.
      expect(rows.map((r) => r.scheduledAt.toISOString())).toEqual(["2031-06-28T11:30:00.000Z", "2031-06-28T16:15:00.000Z"]);

      const before = mine().length;
      await run(new Date("2031-06-28T11:05:00Z")); // the old 5h time has passed, the new one hasn't
      expect(mine().length).toBe(before);
      await run(new Date("2031-06-28T11:31:00Z"));
      const sent = mine().slice(before);
      expect(sent).toHaveLength(1);
      expect(visibleText(sent[0]!)).toContain("QUEUE AT 19:30");

      // Clearing goes back to the slot time.
      const cleared = await ctx.services.schedules.editSlot({ guildId, position: 1, queueInput: "clear", now: new Date("2031-06-26T00:00:00Z") });
      expect(cleared.ok && cleared.value.slot.queueAt).toBeNull();
      await ctx.services.schedules.cancel(guildId);
    });

    it("if the poll is made late, only the closest due reminder is sent (no stale '5 HOURS')", async () => {
      const { poll, slots } = await newPoll("sat 7pm");
      for (const u of users.slice(0, 5)) await vote(poll.id, slots[0]!.id, u);
      const before = mine().length;
      await run(new Date("2031-06-28T15:50:00Z")); // 10 minutes before queue: both offsets are due
      const sent = mine().slice(before);
      expect(sent).toHaveLength(1);
      expect(visibleText(sent[0]!)).toContain("15 MINUTES");
      const rows = await ctx.repositories.schedules.listRemindersBySlot(slots[0]!.id);
      expect(rows.map((r) => [r.offsetMinutes, r.status])).toEqual([[300, "SKIPPED"], [15, "SENT"]]);
      await ctx.services.schedules.cancel(guildId);
    });

    it("reminders=always reminds a non-leading slot; never silences the leader; a cancelled poll sends nothing", async () => {
      const { poll, slots } = await newPoll("sat 7pm, sun 7pm");
      const [sat, sun] = slots as [(typeof slots)[number], (typeof slots)[number]];
      for (const u of users.slice(0, 5)) await vote(poll.id, sat.id, u);
      for (const u of users.slice(0, 2)) await vote(poll.id, sun.id, u);
      await ctx.services.schedules.editSlot({ guildId, position: 2, remindMode: "ALWAYS", now: new Date("2031-06-26T00:00:00Z") });

      const before = mine().length;
      await run(new Date("2031-06-29T14:01:00Z")); // sun 5h reminder (slot 17:00Z -> 12:00Z) and sat (already past) 
      const sunSent = mine().slice(before);
      expect(sunSent.some((p) => visibleText(p).includes("SUN 29/06"))).toBe(true);

      await ctx.services.schedules.editSlot({ guildId, position: 1, remindMode: "NEVER", now: new Date("2031-06-26T00:00:00Z") });
      await ctx.services.schedules.cancel(guildId);
      const afterCancel = mine().length;
      await run(new Date("2031-06-29T16:50:00Z"));
      expect(mine().length).toBe(afterCancel);
    });

    it("a failed send is reverted to PENDING and retried on the next tick", async () => {
      const { poll, slots } = await newPoll("sat 7pm");
      for (const u of users.slice(0, 5)) await vote(poll.id, slots[0]!.id, u);
      const before = mine().length;
      fd.failNextSend();
      const first = await run(new Date("2031-06-28T11:01:00Z"));
      expect(first.slotRemindersFailed).toBeGreaterThanOrEqual(1);
      expect((await ctx.repositories.schedules.listRemindersBySlot(slots[0]!.id))[0]!.status).toBe("PENDING");
      await run(new Date("2031-06-28T11:02:00Z"));
      expect(mine().slice(before)).toHaveLength(1);
      await ctx.services.schedules.cancel(guildId);
    });
  });
});
