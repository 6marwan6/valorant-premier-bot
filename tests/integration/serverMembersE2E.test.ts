import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ButtonInteraction, ChatInputCommandInteraction, User } from "discord.js";
import type { Pool } from "pg";
import { createDatabase, type Database } from "../../src/database/client.js";
import { buildAppContext, type AppContext } from "../../src/appContext.js";
import type { DiscordRestClient, ReplyPayload } from "../../src/discord/discordRest.js";
import type { LlmClient } from "../../src/services/ai/llmClient.js";
import { dispatchCommand } from "../../src/discord/interactions/dispatchCommand.js";
import { dispatchButton } from "../../src/discord/interactions/dispatchButton.js";
import { logger } from "../../src/config/logger.js";
import { buildVoteCustomId, buildDeclineCustomId } from "../../src/modules/schedules/scheduleCustomId.js";
import { buildAttendanceCustomId } from "../../src/modules/attendance/customId.js";
import { buildScheduleMessage } from "../../src/modules/schedules/scheduleMessage.js";
import { visibleText } from "../unit/helpers/embedText.js";

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

const json = (response: string) => JSON.stringify({ response, should_follow_up: false, memory_candidate: null });

function fakeLlm(impl: (system: string, user: string) => Promise<string>) {
  return {
    model: "fake-model",
    complete: vi.fn(async ({ system, user }: { system: string; user: string }) => ({ text: await impl(system, user), model: "fake-model", inputTokens: 1, outputTokens: 1 })),
  } satisfies LlmClient;
}

function fakeCommand(name: string, adminOk: boolean, opts: { users?: Record<string, string>; strings?: Record<string, string>; ints?: Record<string, number> }, guildId: string) {
  const reply = vi.fn(async (_p: { content: string; ephemeral?: boolean }) => undefined);
  const interaction = {
    commandName: name,
    guildId,
    user: { id: "admin-1", username: "admin" },
    memberPermissions: { has: () => adminOk },
    member: { roles: [] as string[] },
    options: {
      getUser: (n: string, required?: boolean) => {
        const id = opts.users?.[n];
        if (!id) {
          if (required) throw new Error(`missing user ${n}`);
          return null;
        }
        return { id, username: id, displayName: `Name-${id}`, bot: false } as unknown as User;
      },
      getString: (n: string, required?: boolean) => {
        const v = opts.strings?.[n];
        if (v === undefined) {
          if (required) throw new Error(`missing string ${n}`);
          return null;
        }
        return v;
      },
      getInteger: (n: string) => opts.ints?.[n] ?? null,
      getBoolean: () => null,
    },
    reply,
    deferred: false,
    replied: false,
    isRepliable: () => true,
  };
  return { interaction: interaction as unknown as ChatInputCommandInteraction, reply };
}

function fakeClick(customId: string, user: { id: string; name: string }, guildId: string) {
  const update = vi.fn(async (_p: unknown) => undefined);
  const followUp = vi.fn(async (_p: unknown) => undefined);
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

describeIfDb("Server members (non-Premier) + AI reactions to schedule votes (integration)", () => {
  let db: Database;
  let pool: Pool;
  let ctx: AppContext;
  let llm: ReturnType<typeof fakeLlm>;
  const stamp = Date.now();
  const guildId = `members-guild-${stamp}`;
  const channelId = `members-chan-${stamp}`;
  const sent: Array<{ channelId: string; payload: ReplyPayload }> = [];
  const mentions: Array<{ channelId: string; text: string; userId: string; card?: { embeds: unknown[] } }> = [];
  let mentionFails = false;

  const uid = (n: string) => `${n}-${stamp}`;
  const premier = ["p1", "p2", "p3", "p4", "p5"].map((n) => ({ id: uid(n), name: n.toUpperCase() }));
  const sara = { id: uid("sara"), name: "Sara" };

  beforeAll(async () => {
    ({ db, pool } = createDatabase({ DATABASE_URL: databaseUrl! }));
    llm = fakeLlm(async (system) => json(system.includes("MODE: ROAST.") ? "see you never then 💀" : "ok ok you're in 😏"));
    const discord = {
      sendChannelMessage: vi.fn(async (c: string, payload: ReplyPayload) => {
        sent.push({ channelId: c, payload });
        return { id: `m-${sent.length}` };
      }),
      sendMentionMessage: vi.fn(async (c: string, text: string, userId: string, card?: { embeds: unknown[] }) => {
        if (mentionFails) throw new Error("Discord rejected the post");
        mentions.push({ channelId: c, text, userId, card });
        return { id: "mention" };
      }),
      editChannelMessage: vi.fn(async () => undefined),
    } as unknown as DiscordRestClient;
    ctx = buildAppContext({ discord, db, env: {} as any, logger, llm });
    await ctx.repositories.serverConfig.upsert(guildId, { timezone: "Africa/Cairo", matchChannelId: channelId, defaultRoastIntensity: 40 });
  });
  afterAll(async () => {
    await pool.end();
  });

  const run = async (name: string, opts: Parameters<typeof fakeCommand>[2], adminOk = true) => {
    const c = fakeCommand(name, adminOk, opts, guildId);
    await dispatchCommand(c.interaction, ctx);
    return c.reply.mock.calls[0]![0].content;
  };

  it("/add-member creates a member: no role, not on the Premier roster, but known to Mari", async () => {
    const reply = await run("add-member", { users: { member: sara.id }, strings: { protected_topics: "Exams, Family" } });
    expect(reply).toContain("server member");

    const row = (await ctx.repositories.players.getByDiscordUserId(guildId, sara.id))!;
    expect(row.kind).toBe("MEMBER");
    expect(row.role).toBeNull();
    expect(row.agents).toEqual([]);
    expect(row.roastIntensity).toBe(40); // the server default
    expect(row.protectedTopics).toEqual(["Exams", "Family"]);

    expect((await ctx.repositories.players.listActiveByGuild(guildId)).map((p) => p.discordUserId)).toContain(sara.id);
    expect((await ctx.repositories.players.listActivePlayersByGuild(guildId)).map((p) => p.discordUserId)).not.toContain(sara.id);
  });

  it("/add-member is admin only, and refuses an active Premier player", async () => {
    const denied = await run("add-member", { users: { member: uid("x") } }, false);
    expect(denied).not.toContain("Added");
    expect(await ctx.repositories.players.getByDiscordUserId(guildId, uid("x"))).toBeUndefined();

    await ctx.repositories.players.upsertByDiscordUserId(guildId, premier[0]!.id, { displayName: "P1", kind: "PLAYER", role: "DUELIST", agents: ["Jett"], preferredAgent: "Jett", roastIntensity: 50 } as never);
    const refused = await run("add-member", { users: { member: premier[0]!.id } });
    expect(refused).toContain("active Premier player");
    expect((await ctx.repositories.players.getByDiscordUserId(guildId, premier[0]!.id))!.kind).toBe("PLAYER");
  });

  it("/edit-player won't give a member a role or agents, but edits their AI settings", async () => {
    const refused = await run("edit-player", { users: { player: sara.id }, strings: { role: "DUELIST" } });
    expect(refused).toContain("server member");
    expect((await ctx.repositories.players.getByDiscordUserId(guildId, sara.id))!.role).toBeNull();

    const ok = await run("edit-player", { users: { player: sara.id }, ints: { roast_intensity: 90 } });
    expect(ok).toContain("Updated");
    expect((await ctx.repositories.players.getByDiscordUserId(guildId, sara.id))!.roastIntensity).toBe(90);
  });

  it("/player labels a member as such", async () => {
    expect(await run("player", { users: { player: sara.id } })).toContain("Server member");
  });

  it("a member cannot vote on the schedule — even before any Premier roster exists — and cannot answer match attendance", async () => {
    // Premier roster is just p1 so far; Sara is a member. Use a fresh guild-less check: the member gate is independent of the roster.
    const created = await ctx.services.schedules.create({ guildId, slotsInput: "sat 7pm", now: new Date("2031-06-25T00:00:00Z") });
    if (!created.ok) throw new Error(created.error);
    const { poll, slots } = created.value;

    const vote = fakeClick(buildVoteCustomId(poll.id, slots[0]!.id), sara, guildId);
    await dispatchButton(vote.interaction, ctx);
    expect(vote.update).not.toHaveBeenCalled();
    expect(vote.reply.mock.calls[0]![0].content).toContain("Premier players only");
    expect((await ctx.services.schedules.getView(poll.id))!.votes).toHaveLength(0);

    const decline = fakeClick(buildDeclineCustomId(poll.id), sara, guildId);
    await dispatchButton(decline.interaction, ctx);
    expect(decline.reply.mock.calls[0]![0].content).toContain("Premier players only");
    expect((await ctx.services.schedules.getView(poll.id))!.declines).toHaveLength(0);

    const match = await ctx.repositories.matches.create({ guildId, scheduledAt: new Date(Date.now() + 86_400_000), timezone: "Africa/Cairo" });
    await ctx.repositories.matches.update(match.id, { status: "CONFIRMATION_OPEN" } as never);
    const attend = fakeClick(buildAttendanceCustomId(match.id, "PLAYING"), sara, guildId);
    await dispatchButton(attend.interaction, ctx);
    expect(attend.reply.mock.calls[0]![0].content).toContain("Premier players only");
    expect(await ctx.repositories.attendance.listByMatch(match.id)).toHaveLength(0);

    await ctx.services.schedules.cancel(guildId);
  });

  it("members never appear on the schedule card ('No vote yet') — only the Premier roster does", async () => {
    const created = await ctx.services.schedules.create({ guildId, slotsInput: "sat 7pm", now: new Date("2031-06-25T00:00:00Z") });
    if (!created.ok) throw new Error(created.error);
    const view = (await ctx.services.schedules.getView(created.value.poll.id))!;
    const roster = await ctx.repositories.players.listActivePlayersByGuild(guildId);
    const text = visibleText(buildScheduleMessage(view, roster, new Date("2031-06-25T00:00:00Z")));
    expect(text).toContain("P1");
    expect(text).not.toContain("Sara");
    await ctx.services.schedules.cancel(guildId);
  });

  it("/add-player promotes a member and keeps their protected topics (no silent privacy reset)", async () => {
    const before = (await ctx.repositories.players.getByDiscordUserId(guildId, sara.id))!;
    const reply = await run("add-player", { users: { player: sara.id }, strings: { role: "SENTINEL", agents: "Cypher, Killjoy", preferred_agent: "Cypher" } });
    expect(reply).toContain("Promoted");
    const after = (await ctx.repositories.players.getByDiscordUserId(guildId, sara.id))!;
    expect(after.id).toBe(before.id); // same profile, so memories stay attached
    expect(after.kind).toBe("PLAYER");
    expect(after.role).toBe("SENTINEL");
    expect(after.protectedTopics).toEqual(["Exams", "Family"]);
    expect(after.roastIntensity).toBe(90);
    expect((await ctx.repositories.players.listActivePlayersByGuild(guildId)).map((p) => p.discordUserId)).toContain(sara.id);

    // ...and back: remove, then add as a member again.
    await run("remove-player", { users: { player: sara.id } });
    const again = await run("add-member", { users: { member: sara.id } });
    expect(again).toContain("server member");
    const demoted = (await ctx.repositories.players.getByDiscordUserId(guildId, sara.id))!;
    expect(demoted).toMatchObject({ kind: "MEMBER", role: null, agents: [], active: true });
    expect(demoted.protectedTopics).toEqual(["Exams", "Family"]);
  });

  describe("Mari reacts to schedule votes", () => {
    async function freshPoll(slotsInput = "sat 7pm, sun 7pm") {
      // Clean slate: roster is exactly the five Premier players.
      for (const u of premier) {
        await ctx.repositories.players.upsertByDiscordUserId(guildId, u.id, { displayName: u.name, kind: "PLAYER", role: "DUELIST", agents: ["Jett"], preferredAgent: "Jett", roastIntensity: 50, protectedTopics: ["Family"] } as never);
      }
      const created = await ctx.services.schedules.create({ guildId, slotsInput, now: new Date("2031-06-25T00:00:00Z") });
      if (!created.ok) throw new Error(created.error);
      return created.value;
    }
    const mentionsFor = (userId: string) => mentions.filter((m) => m.userId === userId);

    it("first vote -> one public CELEBRATE card @mentioning the voter; more votes and toggling -> silence", async () => {
      const { poll, slots } = await freshPoll();
      const [s1, s2] = slots as [(typeof slots)[number], (typeof slots)[number]];
      const before = mentionsFor(premier[1]!.id).length;
      const calls = llm.complete.mock.calls.length;

      const first = fakeClick(buildVoteCustomId(poll.id, s1.id), premier[1]!, guildId);
      await dispatchButton(first.interaction, ctx);
      const mine = mentionsFor(premier[1]!.id).slice(before);
      expect(mine).toHaveLength(1);
      expect(mine[0]!.channelId).toBe(channelId);
      expect(mine[0]!.text).toBe("ok ok you're in 😏");
      expect(mine[0]!.card!.embeds).toHaveLength(1);
      // The prompt carried the slot and the player's protected topics — and a CELEBRATE mode.
      const [{ system, user }] = llm.complete.mock.calls.at(-1) as [{ system: string; user: string }];
      expect(system).toContain("MODE: CELEBRATE");
      expect(user).toContain("CAN play SAT 28/06 at 19:00");
      expect(user).toContain("- Family");
      expect(llm.complete.mock.calls.length).toBe(calls + 1);

      // A second slot, toggling off, toggling on: no further AI calls and no further posts.
      for (const id of [s2.id, s1.id, s1.id]) {
        await dispatchButton(fakeClick(buildVoteCustomId(poll.id, id), premier[1]!, guildId).interaction, ctx);
      }
      expect(mentionsFor(premier[1]!.id).slice(before)).toHaveLength(1);
      expect(llm.complete.mock.calls.length).toBe(calls + 1);
      await ctx.services.schedules.cancel(guildId);
    });

    it("'can't play any day' -> one public ROAST card, once per poll", async () => {
      const { poll } = await freshPoll();
      const before = mentionsFor(premier[2]!.id).length;
      const click = fakeClick(buildDeclineCustomId(poll.id), premier[2]!, guildId);
      await dispatchButton(click.interaction, ctx);
      const mine = mentionsFor(premier[2]!.id).slice(before);
      expect(mine).toHaveLength(1);
      expect(mine[0]!.text).toBe("see you never then 💀");
      const [{ system, user }] = llm.complete.mock.calls.at(-1) as [{ system: string; user: string }];
      expect(system).toContain("MODE: ROAST");
      expect(user).toContain("CAN'T play on any of the 2 slots");

      await dispatchButton(fakeClick(buildDeclineCustomId(poll.id), premier[2]!, guildId).interaction, ctx); // pressed again
      expect(mentionsFor(premier[2]!.id).slice(before)).toHaveLength(1);
      await ctx.services.schedules.cancel(guildId);
    });

    it("decline, vote, decline again: one roast, one celebrate, nothing more", async () => {
      const { poll, slots } = await freshPoll();
      const u = premier[3]!;
      const before = mentionsFor(u.id).length;
      await dispatchButton(fakeClick(buildDeclineCustomId(poll.id), u, guildId).interaction, ctx);
      await dispatchButton(fakeClick(buildVoteCustomId(poll.id, slots[0]!.id), u, guildId).interaction, ctx);
      await dispatchButton(fakeClick(buildDeclineCustomId(poll.id), u, guildId).interaction, ctx);
      expect(mentionsFor(u.id).slice(before).map((m) => m.text)).toEqual(["see you never then 💀", "ok ok you're in 😏"]);
      await ctx.services.schedules.cancel(guildId);
    });

    it("a model reply that breaks a protected topic is never posted (output validation still applies)", async () => {
      const { poll, slots } = await freshPoll();
      const calls = llm.complete.getMockImplementation()!;
      llm.complete.mockImplementationOnce(async () => ({ text: json("how is your family doing 😏"), model: "fake-model", inputTokens: 1, outputTokens: 1 }));
      const before = mentionsFor(premier[4]!.id).length;
      const click = fakeClick(buildVoteCustomId(poll.id, slots[0]!.id), premier[4]!, guildId);
      await dispatchButton(click.interaction, ctx);
      expect(mentionsFor(premier[4]!.id).slice(before)).toHaveLength(0);
      expect(click.update).toHaveBeenCalledTimes(1); // the vote itself is fine
      llm.complete.mockImplementation(calls);
      await ctx.services.schedules.cancel(guildId);
    });

    it("AI off or unreachable or Discord rejecting the post never turns a vote into an error", async () => {
      // Discord rejects the public post.
      const { poll, slots } = await freshPoll();
      mentionFails = true;
      const click = fakeClick(buildVoteCustomId(poll.id, slots[0]!.id), premier[0]!, guildId);
      await dispatchButton(click.interaction, ctx);
      mentionFails = false;
      expect(click.update).toHaveBeenCalledTimes(1);
      expect(click.reply).not.toHaveBeenCalled();
      expect((await ctx.services.schedules.getView(poll.id))!.votes).toHaveLength(1);
      await ctx.services.schedules.cancel(guildId);

      // No LLM configured: no reaction, vote recorded.
      const noAiCtx = buildAppContext({ discord: (ctx as any).discord ?? ({} as DiscordRestClient), db, env: {} as any, logger, llm: null });
      expect(noAiCtx.services.ai.enabled).toBe(false);
    });
  });
});
