import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { ButtonInteraction } from "discord.js";
import { createDatabase, type Database } from "../../src/database/client.js";
import { buildAppContext, type AppContext } from "../../src/appContext.js";
import type { DiscordRestClient, ReplyPayload } from "../../src/discord/discordRest.js";
import { dispatchButton } from "../../src/discord/interactions/dispatchButton.js";
import { syncAgentBoard } from "../../src/discord/agentBoardSync.js";
import { syncScheduleMessage } from "../../src/discord/scheduleSync.js";
import { logger } from "../../src/config/logger.js";
import { buildVoteCustomId, buildDeclineCustomId } from "../../src/modules/schedules/scheduleCustomId.js";
import { agentPickId } from "../../src/modules/agents/agentCustomId.js";
import { visibleText } from "../unit/helpers/embedText.js";
import createScheduleCommand from "../../src/discord/commands/createSchedule.js";
import type { ChatInputCommandInteraction } from "discord.js";

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const FAR = new Date("2031-06-25T00:00:00Z");

function click(customId: string, user: { id: string; name: string }, guildId: string) {
  const update = vi.fn(async (_p: ReplyPayload) => undefined);
  const followUp = vi.fn(async (_p: ReplyPayload) => undefined);
  const reply = vi.fn(async (_p: { content: string }) => undefined);
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

describeIfDb("AGENT SELECT lineup message (integration)", () => {
  let db: Database;
  let pool: Pool;
  let ctx: AppContext;
  const stamp = Date.now();
  const guildId = `board-guild-${stamp}`;
  const channelId = `board-chan-${stamp}`;
  let n = 0;
  const sends: Array<{ channelId: string; id: string; payload: ReplyPayload }> = [];
  const edits: Array<{ channelId: string; messageId: string; payload: ReplyPayload }> = [];
  let failSend = false;
  let editError: unknown = null;

  const uid = (x: string) => `${x}-${stamp}`;
  const team = ["p1", "p2", "p3"].map((x) => ({ id: uid(x), name: x.toUpperCase() }));
  const [p1, p2] = team as [(typeof team)[number], (typeof team)[number], (typeof team)[number]];

  beforeAll(async () => {
    ({ db, pool } = createDatabase({ DATABASE_URL: databaseUrl! }));
    const discord = {
      sendChannelMessage: vi.fn(async (c: string, payload: ReplyPayload) => {
        if (failSend) {
          failSend = false;
          throw new Error("simulated Discord outage");
        }
        const id = `board-msg-${stamp}-${++n}`;
        sends.push({ channelId: c, id, payload });
        return { id };
      }),
      sendMentionMessage: vi.fn(async () => ({ id: "mention" })),
      editChannelMessage: vi.fn(async (c: string, m: string, payload: ReplyPayload) => {
        if (editError) {
          const e = editError;
          editError = null;
          throw e;
        }
        edits.push({ channelId: c, messageId: m, payload });
      }),
    } as unknown as DiscordRestClient;
    ctx = buildAppContext({ discord, db, env: {} as any, logger, llm: null });
    await ctx.repositories.serverConfig.upsert(guildId, { timezone: "Africa/Cairo", matchChannelId: channelId });
    for (const [i, u] of team.entries()) {
      await ctx.repositories.players.upsertByDiscordUserId(guildId, u.id, {
        displayName: u.name,
        kind: "PLAYER",
        role: (["DUELIST", "CONTROLLER", "SENTINEL"] as const)[i]!,
        agents: ["Jett"],
        preferredAgent: null,
        roastIntensity: 50,
      } as never);
    }
  });
  afterAll(async () => {
    await pool.end();
  });

  async function freshPoll() {
    const created = await ctx.services.schedules.create({ guildId, slotsInput: "sat 7pm, sun 7pm", now: FAR });
    if (!created.ok) throw new Error(created.error);
    await ctx.services.schedules.recordMessage(created.value.poll.id, `card-${created.value.poll.id}`);
    sends.length = 0;
    edits.length = 0;
    return created.value;
  }
  const view = async (pollId: number) => (await ctx.services.schedules.getView(pollId))!;
  const finish = () => ctx.services.schedules.cancel(guildId);
  const vote = (pollId: number, slotId: number, u: { id: string; name: string }) => dispatchButton(click(buildVoteCustomId(pollId, slotId), u, guildId).interaction, ctx);
  const boardId = async (pollId: number) => (await ctx.repositories.schedules.getPoll(pollId))!.agentBoardMessageId;
  const lineupFields = (p: ReplyPayload) => (p.embeds?.[0]?.toJSON().fields ?? []).filter((f) => f.inline).map((f) => `${f.name.replace(/^\S+ /, "")}=${f.value}`);

  it("is posted once under the schedule, then edited in place — never reposted — with mentions suppressed", async () => {
    const { poll } = await freshPoll();
    await syncAgentBoard(ctx, await view(poll.id));
    expect(sends).toHaveLength(1);
    expect(sends[0]!.channelId).toBe(channelId);
    expect(sends[0]!.payload.content).toContain("AGENT SELECT");
    expect(sends[0]!.payload.suppressMentions).toBe(true);
    expect(await boardId(poll.id)).toBe(sends[0]!.id);

    await syncAgentBoard(ctx, await view(poll.id));
    expect(sends).toHaveLength(1);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.messageId).toBe(sends[0]!.id);
    expect(edits[0]!.payload.suppressMentions).toBe(true);
    await finish();
  });

  it("follows votes and picks: voters appear as 'still choosing', picks as agent-over-player, and a removed vote drops the pick", async () => {
    const { poll, slots } = await freshPoll();
    const slotId = slots[0]!.id;
    await syncAgentBoard(ctx, await view(poll.id));
    const id = (await boardId(poll.id))!;

    await vote(poll.id, slotId, p1);
    await vote(poll.id, slotId, p2);
    let last = edits.filter((e) => e.messageId === id).at(-1)!.payload;
    expect(visibleText(last)).toContain("STILL CHOOSING");
    expect(visibleText(last)).toContain(`<@${p1.id}>`);
    expect(lineupFields(last)).toEqual([]);

    await dispatchButton(click(agentPickId(slotId, "jett"), p1, guildId).interaction, ctx);
    await dispatchButton(click(agentPickId(slotId, "omen"), p2, guildId).interaction, ctx);
    last = edits.filter((e) => e.messageId === id).at(-1)!.payload;
    expect(lineupFields(last)).toEqual([`JETT=<@${p1.id}>`, `OMEN=<@${p2.id}>`]);
    expect(visibleText(last)).not.toContain("STILL CHOOSING");
    expect(last.embeds![0]!.toJSON().description).toContain("2/2");

    await vote(poll.id, slotId, p1); // toggle off: the pick goes with the vote
    last = edits.filter((e) => e.messageId === id).at(-1)!.payload;
    expect(lineupFields(last)).toEqual([`OMEN=<@${p2.id}>`]);
    expect(sends).toHaveLength(1); // only ever the one lineup message

    await dispatchButton(click(buildDeclineCustomId(poll.id), p2, guildId).interaction, ctx); // "can't play any day" frees their agent too
    last = edits.filter((e) => e.messageId === id).at(-1)!.payload;
    expect(last.embeds).toHaveLength(0);
    expect(last.content).toContain("Nobody has locked in");
    await finish();
  });

  it("a schedule posted before this feature gets its lineup on the first vote", async () => {
    const { poll, slots } = await freshPoll();
    expect(await boardId(poll.id)).toBeNull();
    await vote(poll.id, slots[0]!.id, p1);
    expect(sends.filter((s) => s.payload.content?.includes("AGENT SELECT"))).toHaveLength(1);
    expect(await boardId(poll.id)).toBe(sends[0]!.id);
    await finish();
  });

  it("two simultaneous clicks on a poll with no lineup post exactly one", async () => {
    const { poll } = await freshPoll();
    const v = await view(poll.id);
    await Promise.all([syncAgentBoard(ctx, v), syncAgentBoard(ctx, v), syncAgentBoard(ctx, v)]);
    expect(sends).toHaveLength(1);
    expect(await boardId(poll.id)).toBe(sends[0]!.id);
    await finish();
  });

  it("if someone deletes the lineup message, the next change posts a fresh one and remembers it", async () => {
    const { poll } = await freshPoll();
    await syncAgentBoard(ctx, await view(poll.id));
    const first = (await boardId(poll.id))!;
    editError = Object.assign(new Error("Unknown Message"), { code: 10008 });
    await syncAgentBoard(ctx, await view(poll.id));
    expect(sends).toHaveLength(2);
    const second = (await boardId(poll.id))!;
    expect(second).not.toBe(first);
    expect(second).toBe(sends[1]!.id);
    await finish();
  });

  it("a Discord failure never breaks a vote, releases the claim, and the next change retries at once", async () => {
    const { poll, slots } = await freshPoll();
    failSend = true;
    const c = click(buildVoteCustomId(poll.id, slots[0]!.id), p1, guildId);
    await dispatchButton(c.interaction, ctx);
    expect(c.update).toHaveBeenCalledTimes(1); // the vote and the card were fine
    expect(c.reply).not.toHaveBeenCalled();
    expect((await view(poll.id)).votes).toHaveLength(1);
    expect(await boardId(poll.id)).toBeNull();

    await vote(poll.id, slots[0]!.id, p2); // no waiting out the claim
    expect(await boardId(poll.id)).not.toBeNull();
    await finish();

    // a non-"deleted" edit failure is swallowed too
    const next = await freshPoll();
    await syncAgentBoard(ctx, await view(next.poll.id));
    editError = new Error("Discord 500");
    await expect(syncAgentBoard(ctx, await view(next.poll.id))).resolves.toBeUndefined();
    await finish();
  });

  it("an admin-side change (map, queue time, cancel) refreshes the lineup through syncScheduleMessage; cancelling retires its button", async () => {
    const { poll, slots } = await freshPoll();
    await vote(poll.id, slots[0]!.id, p1);
    const id = (await boardId(poll.id))!;
    edits.length = 0;

    await ctx.services.schedules.editSlot({ guildId, position: 1, mapInput: "ascent", now: FAR });
    await syncScheduleMessage(ctx, await view(poll.id));
    const withMap = edits.find((e) => e.messageId === id)!.payload;
    expect(visibleText(withMap)).toContain("ASCENT");
    expect(edits.some((e) => e.messageId === `card-${poll.id}`)).toBe(true); // the card refreshed as before

    edits.length = 0;
    await finish();
    await syncScheduleMessage(ctx, await view(poll.id));
    const cancelled = edits.find((e) => e.messageId === id)!.payload;
    expect(cancelled.content).toContain("cancelled");
    expect(cancelled.components ?? []).toHaveLength(0);
  });

  it("a cancelled schedule that never had a lineup doesn't get one", async () => {
    const { poll } = await freshPoll();
    await finish();
    await syncAgentBoard(ctx, await view(poll.id));
    expect(sends).toHaveLength(0);
    expect(await boardId(poll.id)).toBeNull();
  });

  it("a stale claim (a poster that crashed) is retaken, a fresh one is respected", async () => {
    const { poll } = await freshPoll();
    const repo = ctx.repositories.schedules;
    const t = new Date("2031-06-25T00:00:00Z");
    expect(await repo.claimAgentBoardPost(poll.id, t)).toBe(true);
    expect(await repo.claimAgentBoardPost(poll.id, new Date(t.getTime() + 30_000))).toBe(false);
    expect(await repo.claimAgentBoardPost(poll.id, new Date(t.getTime() + 61_000))).toBe(true);
    await repo.setAgentBoardMessageId(poll.id, "x");
    expect(await repo.claimAgentBoardPost(poll.id, new Date(t.getTime() + 999_000))).toBe(false); // never once posted
    await finish();
  });
  it("/create-schedule posts the card, then the lineup right under it, and records both", async () => {
    await finish();
    sends.length = 0;
    const reply = vi.fn(async (_p: unknown) => undefined);
    const interaction = {
      guildId,
      memberPermissions: { has: () => true },
      member: { roles: [] as string[] },
      user: { id: p1.id },
      options: { getString: () => "sat 7pm, sun 7pm" },
      reply,
    } as unknown as ChatInputCommandInteraction;
    await createScheduleCommand.execute(interaction, ctx);
    expect(reply.mock.calls[0]![0]).toMatchObject({ ephemeral: true });
    expect(sends).toHaveLength(2);
    expect(sends[0]!.payload.content).toContain("VALORANT PREMIER"); // the schedule card first, which is what pings the roster
    expect(sends[1]!.payload.content).toContain("AGENT SELECT");
    expect(sends[1]!.payload.mentionUserIds ?? []).toHaveLength(0); // the lineup never pings
    const poll = (await ctx.repositories.schedules.getLatestOpenPoll(guildId))!;
    expect(poll.messageId).toBe(sends[0]!.id);
    expect(poll.agentBoardMessageId).toBe(sends[1]!.id);
    await finish();
  });
});
