import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { createDatabase, type Database } from "../../src/database/client.js";
import { buildAppContext, type AppContext } from "../../src/appContext.js";
import type { DiscordRestClient, ReplyPayload } from "../../src/discord/discordRest.js";
import { runReminderCronJob } from "../../src/services/scheduling/reminderCronJob.js";
import { logger } from "../../src/config/logger.js";
import { syncAgentBoard } from "../../src/discord/agentBoardSync.js";

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const HOUR = 60 * 60 * 1000;

/** A Discord double that records DMs and can be told to fail the next DM for a user. */
function fakeDiscord() {
  let n = 1;
  const dms: Array<{ userId: string; content: string }> = [];
  const failures = new Map<string, { code?: number; times: number }>();
  const discord = {
    sendChannelMessage: vi.fn(async (_c: string, _p: ReplyPayload) => ({ id: `msg-${n++}` })),
    editChannelMessage: vi.fn(async () => undefined),
    createDmChannel: vi.fn(async (userId: string) => {
      const f = failures.get(userId);
      if (f && f.times > 0) {
        f.times--;
        throw Object.assign(new Error("dm failed"), f.code ? { code: f.code } : {});
      }
      return { id: `dm-${userId}` };
    }),
    sendDirectMessage: vi.fn(async (channelId: string, p: ReplyPayload) => {
      dms.push({ userId: channelId.replace(/^dm-/, ""), content: p.content ?? "" });
      return { id: `dmmsg-${n++}` };
    }),
  } as unknown as DiscordRestClient;
  return { discord, dms, failNext: (userId: string, code?: number, times = 1) => failures.set(userId, { code, times }) };
}

describeIfDb("Mari's day-old 'you haven't voted' DM (integration)", () => {
  let db: Database;
  let pool: Pool;
  let ctx: AppContext;
  let fd: ReturnType<typeof fakeDiscord>;
  const stamp = Date.now();
  const guildId = `nudge-guild-${stamp}`;
  const channelId = `nudge-chan-${stamp}`;
  const ids = ["a", "b", "c", "d"].map((x) => `${x}-${stamp}`);
  const member = `member-${stamp}`;

  beforeAll(async () => {
    ({ db, pool } = createDatabase({ DATABASE_URL: databaseUrl! }));
    fd = fakeDiscord();
    ctx = buildAppContext({ discord: fd.discord, db, env: {} as any, logger, llm: null });
    await ctx.repositories.serverConfig.upsert(guildId, { timezone: "Africa/Cairo", matchChannelId: channelId, reminderScheduleMinutes: [300, 15] });
    for (const id of ids) {
      await ctx.repositories.players.upsertByDiscordUserId(guildId, id, { displayName: id.slice(0, 1).toUpperCase(), role: "DUELIST", agents: ["Jett"], preferredAgent: "Jett", roastIntensity: 50 } as never);
    }
    await ctx.repositories.players.createMember(guildId, member, { displayName: "Mem", roastIntensity: 50 });
  });
  afterAll(async () => {
    await pool.end();
  });

  /** Same steps as /create-schedule: create, post the card and record its message id, then the lineup. */
  async function postSchedule(slotsInput: string, mapInput?: string) {
    const created = await ctx.services.schedules.create({ guildId, slotsInput, mapInput, now: new Date("2031-06-25T00:00:00Z") });
    if (!created.ok) throw new Error(created.error);
    const sent = await fd.discord.sendChannelMessage(channelId, { content: "card" });
    await ctx.services.schedules.recordMessage(created.value.poll.id, sent.id);
    await syncAgentBoard(ctx, (await ctx.services.schedules.getView(created.value.poll.id))!);
    return created.value;
  }

  // The cron tick loops over every guild in the shared test database, so assertions look only at this test's own players.
  const mine = () => fd.dms.filter((d) => ids.includes(d.userId) || d.userId === member);
  const tick = (hoursAfterPost: number) => runReminderCronJob(ctx, new Date(Date.now() + hoursAfterPost * HOUR));

  it("sends nothing before the schedule is a day old", async () => {
    await postSchedule("sat 7pm, sun 7pm", "Ascent");
    await tick(23);
    expect(mine()).toHaveLength(0);
  });

  it("after a day DMs only players who haven't answered — not voters, decliners or server members", async () => {
    const poll = (await ctx.repositories.schedules.getLatestOpenPoll(guildId))!;
    const view = (await ctx.services.schedules.getView(poll.id))!;
    // a votes, b says "can't play any day"; c and d stay silent.
    expect((await ctx.services.schedules.vote({ guildId, pollId: poll.id, slotId: view.slots[0]!.id, discordUserId: ids[0]!, displayName: "A", now: new Date("2031-06-26T00:00:00Z") })).ok).toBe(true);
    expect((await ctx.services.schedules.decline({ guildId, pollId: poll.id, discordUserId: ids[1]!, displayName: "B" })).ok).toBe(true);

    await tick(25);
    expect(mine().map((d) => d.userId).sort()).toEqual([ids[2], ids[3]].sort());
    const text = mine()[0]!.content;
    expect(text).toContain("Ascent"); // the map set at creation
    expect(text).toContain(`https://discord.com/channels/${guildId}/${channelId}/${poll.messageId}`);
    expect(text).toContain("SAT 28/06");
    // DMs never carry buttons or pings, and nothing was posted publicly.
    expect((fd.discord.sendDirectMessage as any).mock.calls.every(([, p]: [string, ReplyPayload]) => !p.components)).toBe(true);
  });

  it("is idempotent: a later tick (or an overlapping one) never sends a second DM", async () => {
    await Promise.all([tick(26), tick(26), tick(30)]);
    expect(mine()).toHaveLength(2);
  });

  it("a player who votes after being nudged is simply done; nothing else changes", async () => {
    const poll = (await ctx.repositories.schedules.getLatestOpenPoll(guildId))!;
    const view = (await ctx.services.schedules.getView(poll.id))!;
    await ctx.services.schedules.vote({ guildId, pollId: poll.id, slotId: view.slots[0]!.id, discordUserId: ids[2]!, displayName: "C", now: new Date("2031-06-26T00:00:00Z") });
    await tick(48);
    expect(mine()).toHaveLength(2);
    const after = (await ctx.services.schedules.getView(poll.id))!;
    expect(after.votes.map((v) => v.discordUserId).sort()).toEqual([ids[0], ids[2]].sort());
  });

  it("closed DMs are tried once and never retried; a transient failure is retried next tick; neither touches votes", async () => {
    await ctx.services.schedules.cancel(guildId);
    const created = await postSchedule("sat 7pm");
    const before = mine().length;

    fd.failNext(ids[0]!, 50007, 5); // DMs closed
    fd.failNext(ids[1]!, undefined, 1); // one transient outage
    await tick(25);
    const sentFirstTick = mine().slice(before).map((d) => d.userId);
    expect(sentFirstTick).not.toContain(ids[0]); // unreachable
    expect(sentFirstTick).not.toContain(ids[1]); // failed, released
    expect(sentFirstTick.sort()).toEqual([ids[2], ids[3]].sort());

    await tick(26);
    const sentSecondTick = mine().slice(before + 2).map((d) => d.userId);
    expect(sentSecondTick).toEqual([ids[1]]); // the transient failure was retried...
    expect(sentSecondTick).not.toContain(ids[0]); // ...the closed DM was not

    await tick(27);
    expect(mine().slice(before)).toHaveLength(3); // and now everyone reachable has exactly one
    const view = (await ctx.services.schedules.getView(created.poll.id))!;
    expect(view.votes).toHaveLength(0); // a nudge never changes anyone's answer
  });

  it("never nudges for a schedule that has no posted card to link to, or a cancelled one", async () => {
    await ctx.services.schedules.cancel(guildId);
    const before = mine().length;
    const created = await ctx.services.schedules.create({ guildId, slotsInput: "sat 7pm", now: new Date("2031-06-25T00:00:00Z") }); // card never posted
    if (!created.ok) throw new Error(created.error);
    await tick(48);
    expect(mine()).toHaveLength(before);
    await ctx.services.schedules.cancel(guildId);
    await tick(72);
    expect(mine()).toHaveLength(before);
  });

  it("stays quiet once every slot has started", async () => {
    const before = mine().length;
    await runReminderCronJob(ctx, new Date("2031-07-30T00:00:00Z"));
    expect(mine()).toHaveLength(before);
  });
});
