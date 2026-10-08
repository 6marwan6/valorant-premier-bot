import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { ButtonInteraction, ChatInputCommandInteraction } from "discord.js";
import { createDatabase, type Database } from "../../src/database/client.js";
import { buildAppContext, type AppContext } from "../../src/appContext.js";
import type { DiscordRestClient, ReplyPayload } from "../../src/discord/discordRest.js";
import { dispatchButton } from "../../src/discord/interactions/dispatchButton.js";
import setupCommand from "../../src/discord/commands/setup.js";
import { logger } from "../../src/config/logger.js";
import { buildVoteCustomId, buildDeclineCustomId } from "../../src/modules/schedules/scheduleCustomId.js";
import { agentPickId } from "../../src/modules/agents/agentCustomId.js";
import { agentByKey, agentIconUrl } from "../../src/modules/agents/agentData.js";

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const FAR = new Date("2031-06-25T00:00:00Z");

function click(customId: string, user: { id: string; name: string }, guildId: string) {
  const update = vi.fn(async (_p: ReplyPayload) => undefined);
  const followUp = vi.fn(async (_p: ReplyPayload) => undefined);
  const reply = vi.fn(async (_p: unknown) => undefined);
  const interaction = {
    customId,
    guildId,
    user: { id: user.id, username: user.name, globalName: user.name, avatar: null, displayAvatarURL: () => "https://cdn.example/avatar.png" },
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

describeIfDb("Mari's LOCKED IN card waits for the agent pick (integration)", () => {
  let db: Database;
  let pool: Pool;
  let ctx: AppContext;
  const stamp = Date.now();
  const guildId = `react-guild-${stamp}`;
  const channelId = `react-chan-${stamp}`;
  const reactionChannel = `react-out-${stamp}`;
  const mentions: Array<{ channelId: string; text: string; userId: string; card?: { embeds: Array<{ toJSON(): any }> } }> = [];
  const aiCalls: Array<{ mode: string; lines: string[] }> = [];
  let failMention = false;
  let aiSource: "ai" | "fallback" = "ai";
  let n = 0;

  const p1 = { id: `p1-${stamp}`, name: "P1" };
  const p2 = { id: `p2-${stamp}`, name: "P2" };

  beforeAll(async () => {
    ({ db, pool } = createDatabase({ DATABASE_URL: databaseUrl! }));
    const discord = {
      sendChannelMessage: vi.fn(async () => ({ id: `msg-${stamp}-${++n}` })),
      sendMentionMessage: vi.fn(async (c: string, text: string, userId: string, card?: never) => {
        if (failMention) throw new Error("simulated Discord outage");
        mentions.push({ channelId: c, text, userId, card });
        return { id: "mention" };
      }),
      editChannelMessage: vi.fn(async () => undefined),
    } as unknown as DiscordRestClient;
    ctx = buildAppContext({ discord, db, env: {} as any, logger, llm: null });
    // A stand-in for Mari: the real model call is not what is under test.
    (ctx.services as any).ai = {
      enabled: true,
      respondToScheduleVote: vi.fn(async (input: { mode: string; event: { lines: string[] } }) => {
        aiCalls.push({ mode: input.mode, lines: input.event.lines });
        return aiSource === "ai" ? { source: "ai", text: `Mari says (${input.mode})` } : { source: "fallback", text: "x" };
      }),
    };
    await ctx.repositories.serverConfig.upsert(guildId, { timezone: "Africa/Cairo", matchChannelId: channelId });
    for (const [i, u] of [p1, p2].entries()) {
      await ctx.repositories.players.upsertByDiscordUserId(guildId, u.id, {
        displayName: u.name,
        kind: "PLAYER",
        role: (["DUELIST", "CONTROLLER"] as const)[i]!,
        agents: ["Jett"],
        preferredAgent: "Raze", // the profile's preferred agent — must NOT be what the card shows
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
    mentions.length = 0;
    aiCalls.length = 0;
    return created.value;
  }
  const finish = () => ctx.services.schedules.cancel(guildId);
  const vote = (pollId: number, slotId: number, u = p1) => click(buildVoteCustomId(pollId, slotId), u, guildId);
  const pickAgent = (slotId: number, key: string, u = p1) => click(agentPickId(slotId, key), u, guildId);
  const fieldsOf = (card?: { embeds: Array<{ toJSON(): any }> }) => Object.fromEntries((card?.embeds[0]?.toJSON().fields ?? []).map((f: { name: string; value: string }) => [f.name, f.value]));

  it("a vote alone does not trigger the card — nothing is said, and the model isn't called", async () => {
    const { poll, slots } = await freshPoll();
    const c = vote(poll.id, slots[0]!.id);
    await dispatchButton(c.interaction, ctx);
    expect(c.update).toHaveBeenCalledTimes(1);
    expect(mentions).toHaveLength(0);
    expect(aiCalls).toHaveLength(0);
    await finish();
  });

  it("the first agent pick sends it: the AI is told the picked agent, and the card shows that agent (not the profile's preferred one) with its portrait", async () => {
    const { poll, slots } = await freshPoll();
    await dispatchButton(vote(poll.id, slots[0]!.id).interaction, ctx);
    await dispatchButton(pickAgent(slots[0]!.id, "jett").interaction, ctx);

    expect(mentions).toHaveLength(1);
    expect(mentions[0]!.channelId).toBe(channelId); // no reaction channel configured: the schedule's own
    expect(mentions[0]!.userId).toBe(p1.id);
    expect(aiCalls).toHaveLength(1);
    expect(aiCalls[0]!.mode).toBe("CELEBRATE");
    expect(aiCalls[0]!.lines.join("\n")).toContain("Agent they locked in for that slot: Jett (Duelist)");

    const card = mentions[0]!.card!.embeds[0]!.toJSON();
    expect(card.title).toContain("LOCKED IN");
    expect(fieldsOf(mentions[0]!.card).Agent).toContain("**Jett**");
    expect(JSON.stringify(card)).not.toContain("Raze");
    expect(fieldsOf(mentions[0]!.card).Role).toContain("Duelist");
    expect(fieldsOf(mentions[0]!.card).Slot).toBeTruthy();
    expect(card.thumbnail?.url).toBe(agentIconUrl(agentByKey("jett")!));
    await finish();
  });

  it("changing the pick afterwards, or picking in another slot, stays silent (once per player per poll)", async () => {
    const { poll, slots } = await freshPoll();
    await dispatchButton(vote(poll.id, slots[0]!.id).interaction, ctx);
    await dispatchButton(pickAgent(slots[0]!.id, "jett").interaction, ctx);
    await dispatchButton(pickAgent(slots[0]!.id, "raze").interaction, ctx);
    await dispatchButton(vote(poll.id, slots[1]!.id).interaction, ctx);
    await dispatchButton(pickAgent(slots[1]!.id, "neon").interaction, ctx);
    expect(mentions).toHaveLength(1);
    expect(aiCalls).toHaveLength(1);
    await finish();
  });

  it("each player gets their own card with their own agent", async () => {
    const { poll, slots } = await freshPoll();
    for (const [u, key] of [[p1, "jett"], [p2, "omen"]] as const) {
      await dispatchButton(vote(poll.id, slots[0]!.id, u).interaction, ctx);
      await dispatchButton(pickAgent(slots[0]!.id, key, u).interaction, ctx);
    }
    expect(mentions.map((m) => m.userId)).toEqual([p1.id, p2.id]);
    expect(fieldsOf(mentions[1]!.card).Agent).toContain("**Omen**");
    await finish();
  });

  it("goes to the configured reaction channel, and back to the schedule's channel after a reset", async () => {
    await ctx.repositories.serverConfig.upsert(guildId, { reactionChannelId: reactionChannel });
    let { poll, slots } = await freshPoll();
    await dispatchButton(vote(poll.id, slots[0]!.id).interaction, ctx);
    await dispatchButton(pickAgent(slots[0]!.id, "jett").interaction, ctx);
    expect(mentions.map((m) => m.channelId)).toEqual([reactionChannel]);
    await finish();

    await ctx.repositories.serverConfig.upsert(guildId, { reactionChannelId: null });
    ({ poll, slots } = await freshPoll());
    await dispatchButton(vote(poll.id, slots[0]!.id).interaction, ctx);
    await dispatchButton(pickAgent(slots[0]!.id, "jett").interaction, ctx);
    expect(mentions.map((m) => m.channelId)).toEqual([channelId]);
    await finish();
  });

  it("'can't play any day' still reacts at once, in the same configured channel", async () => {
    await ctx.repositories.serverConfig.upsert(guildId, { reactionChannelId: reactionChannel });
    const { poll } = await freshPoll();
    await dispatchButton(click(buildDeclineCustomId(poll.id), p1, guildId).interaction, ctx);
    expect(aiCalls.map((c) => c.mode)).toEqual(["ROAST"]);
    expect(mentions.map((m) => m.channelId)).toEqual([reactionChannel]);
    expect(mentions[0]!.card!.embeds[0]!.toJSON().title).toContain("OUT THIS WEEK");
    await ctx.repositories.serverConfig.upsert(guildId, { reactionChannelId: null });
    await finish();
  });

  it("a model fallback posts nothing public, and a Discord failure never breaks the pick", async () => {
    let { poll, slots } = await freshPoll();
    aiSource = "fallback";
    await dispatchButton(vote(poll.id, slots[0]!.id).interaction, ctx);
    await dispatchButton(pickAgent(slots[0]!.id, "jett").interaction, ctx);
    expect(mentions).toHaveLength(0);
    aiSource = "ai";
    await finish();

    ({ poll, slots } = await freshPoll());
    failMention = true;
    await dispatchButton(vote(poll.id, slots[0]!.id).interaction, ctx);
    const pick = pickAgent(slots[0]!.id, "jett");
    await dispatchButton(pick.interaction, ctx);
    failMention = false;
    expect(pick.update).toHaveBeenCalledTimes(1); // the panel updated normally
    expect(pick.reply).not.toHaveBeenCalled();
    const view = (await ctx.services.schedules.getView(poll.id))!;
    expect(view.picks.map((p) => p.agentKey)).toEqual(["jett"]); // and the pick is recorded
    await finish();
  });

  it("/setup reaction_channel sets it, reaction_channel_reset clears it, and asking for both changes nothing", async () => {
    const run = async (opts: { channel?: string | null; reset?: boolean | null }) => {
      const reply = vi.fn(async (_p: { content: string }) => undefined);
      const interaction = {
        guildId,
        memberPermissions: { has: () => true },
        member: { roles: [] as string[] },
        user: { id: p1.id },
        options: {
          getChannel: (name: string) => (name === "reaction_channel" && opts.channel ? { id: opts.channel } : null),
          getBoolean: (name: string) => (name === "reaction_channel_reset" ? (opts.reset ?? null) : null),
          getRole: () => null,
          getString: () => null,
          getInteger: () => null,
        },
        reply,
      } as unknown as ChatInputCommandInteraction;
      await setupCommand.execute(interaction, ctx);
      return reply.mock.calls[0]![0].content;
    };
    const current = async () => (await ctx.repositories.serverConfig.getByGuildId(guildId))!.reactionChannelId;

    expect(await run({ channel: reactionChannel })).toContain(`<#${reactionChannel}>`);
    expect(await current()).toBe(reactionChannel);
    expect(await run({ channel: "other", reset: true })).toContain("Nothing was changed");
    expect(await current()).toBe(reactionChannel);
    expect(await run({ reset: true })).toContain("schedule's own channel");
    expect(await current()).toBeNull();
  });
});
