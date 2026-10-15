import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { ButtonInteraction } from "discord.js";
import { ComponentType, type APIModalSubmitInteraction } from "discord-api-types/v10";
import { createDatabase, type Database } from "../../src/database/client.js";
import { buildAppContext, type AppContext } from "../../src/appContext.js";
import type { DiscordRestClient, ReplyPayload } from "../../src/discord/discordRest.js";
import { dispatchButton } from "../../src/discord/interactions/dispatchButton.js";
import { handleAgentAddModal } from "../../src/discord/interactions/dispatchAgentPick.js";
import { logger } from "../../src/config/logger.js";
import { buildVoteCustomId, buildDeclineCustomId, buildAgentsCustomId } from "../../src/modules/schedules/scheduleCustomId.js";
import { agentPickId, agentClearId, agentRoleId, agentTargetId } from "../../src/modules/agents/agentCustomId.js";
import { MAX_SUGGESTIONS_PER_PLAYER } from "../../src/modules/agents/agentPickService.js";
import { visibleText } from "../unit/helpers/embedText.js";

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const FAR = new Date("2031-06-25T00:00:00Z");

function click(customId: string, user: { id: string; name: string }, guildId: string) {
  const update = vi.fn(async (_p: ReplyPayload) => undefined);
  const followUp = vi.fn(async (_p: ReplyPayload & { ephemeral?: boolean }) => undefined);
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

describeIfDb("Agent pick panel (integration)", () => {
  let db: Database;
  let pool: Pool;
  let ctx: AppContext;
  const stamp = Date.now();
  const guildId = `agent-guild-${stamp}`;
  const channelId = `agent-chan-${stamp}`;
  let posted = 0;
  const edits: Array<{ channelId: string; messageId: string; payload: ReplyPayload }> = [];
  const interactionEdits: Array<{ token: string; payload: ReplyPayload }> = [];
  const followups: Array<{ token: string; payload: ReplyPayload }> = [];

  const uid = (n: string) => `${n}-${stamp}`;
  const team = ["p1", "p2", "p3"].map((n) => ({ id: uid(n), name: n.toUpperCase() }));
  const [p1, p2, p3] = team as [(typeof team)[number], (typeof team)[number], (typeof team)[number]];
  const member = { id: uid("m1"), name: "Sara" };
  const outsider = { id: uid("x1"), name: "Outsider" };

  beforeAll(async () => {
    ({ db, pool } = createDatabase({ DATABASE_URL: databaseUrl! }));
    const discord = {
      sendChannelMessage: vi.fn(async () => ({ id: `posted-${++posted}` })),
      sendMentionMessage: vi.fn(async () => ({ id: "mention" })),
      editChannelMessage: vi.fn(async (c: string, m: string, payload: ReplyPayload) => {
        edits.push({ channelId: c, messageId: m, payload });
      }),
      editOriginalInteractionResponse: vi.fn(async (token: string, payload: ReplyPayload) => {
        interactionEdits.push({ token, payload });
      }),
      sendInteractionFollowup: vi.fn(async (token: string, payload: ReplyPayload) => {
        followups.push({ token, payload });
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
    await ctx.repositories.players.createMember(guildId, member.id, { displayName: member.name, roastIntensity: 50 });
  });
  afterAll(async () => {
    await pool.end();
  });

  async function freshPoll(slotsInput = "sat 7pm, sun 7pm") {
    const created = await ctx.services.schedules.create({ guildId, slotsInput, now: FAR });
    if (!created.ok) throw new Error(created.error);
    await ctx.services.schedules.recordMessage(created.value.poll.id, `msg-${created.value.poll.id}`);
    return created.value;
  }
  const finish = () => ctx.services.schedules.cancel(guildId);
  /** One agent's cell in the panel's agents grid (the second embed): its name over its status. */
  const cell = (panel: ReplyPayload, agent: string) => (panel.embeds?.at(1)?.toJSON().fields ?? []).find((f) => f.name.includes(agent.toUpperCase()));
  /** Edits of the schedule card itself (the lineup message is a different message). */
  const cardEdits = (pollId: number) => edits.filter((e) => e.messageId === `msg-${pollId}`);
  const voteVia = (pollId: number, slotId: number, u: { id: string; name: string }) => {
    const c = click(buildVoteCustomId(pollId, slotId), u, guildId);
    return dispatchButton(c.interaction, ctx).then(() => c);
  };
  /** A press of one of the panel's agent buttons: main by default, or the optional second. */
  const pickVia = (pollId: number, key: string, u: { id: string; name: string }, target: "MAIN" | "SECOND" = "MAIN") => {
    const c = click(agentPickId(pollId, key, target), u, guildId);
    return dispatchButton(c.interaction, ctx).then(() => c);
  };
  const picksOf = async (pollId: number) => (await ctx.repositories.schedules.listPicksByPoll(pollId)).map((p) => [p.discordUserId, p.kind, p.agentKey] as const);
  const lastPanel = (c: ReturnType<typeof click>) => (c.update.mock.calls.at(-1)?.[0] ?? c.followUp.mock.calls.at(-1)![0]) as ReplyPayload;

  it("choosing a date opens the AGENT PICK panel (private) for the whole schedule, not a bare confirmation", async () => {
    const { poll, slots } = await freshPoll();
    const c = await voteVia(poll.id, slots[0]!.id, p1);
    expect(c.update).toHaveBeenCalledTimes(1); // the public card
    expect(c.followUp).toHaveBeenCalledTimes(1);
    const panel = c.followUp.mock.calls[0]![0];
    expect(panel.ephemeral).toBe(true);
    expect(panel.embeds).toHaveLength(2); // the header and one grid of agents — not a tall card per agent
    expect(panel.components!.length).toBeGreaterThanOrEqual(3);
    const text = visibleText(panel);
    expect(text).toContain("AGENT PICK");
    expect(text).toContain("ONE SQUAD FOR EVERY SLOT");
    expect(text).toContain("SAT 28/06");
    expect(text).toContain("SUN 29/06"); // the whole week, not just the slot just voted for
    expect(text).toContain("COMP A");
    expect(text).toContain("MAP: TBD");
    expect(text).toContain("choosing your MAIN");
    expect(panel.content).toContain("You're **in**");
    expect(panel.content).toContain("counts for every slot");
    expect(cell(panel, "Jett")).toBeTruthy(); // p1 is a Duelist: the panel opens on the Duelists tab
    const tabs = panel.components![0]!.toJSON().components as Array<{ label: string; disabled?: boolean }>;
    expect(tabs.map((t) => t.label)).toEqual(["Duelists", "Initiators", "Controllers", "Sentinels"]);
    expect(tabs[0]!.disabled).toBe(true);
    await finish();
  });

  it("the panel shows the schedule's map and its comps (set when the schedule was created)", async () => {
    const created = await ctx.services.schedules.create({ guildId, slotsInput: "sat 7pm, sun 7pm", mapInput: "Ascent", now: FAR });
    if (!created.ok) throw new Error(created.error);
    await ctx.services.schedules.recordMessage(created.value.poll.id, `msg-${created.value.poll.id}`);
    const c = await voteVia(created.value.poll.id, created.value.slots[0]!.id, p1);
    const text = visibleText(c.followUp.mock.calls[0]![0]);
    expect(text).toContain("MAP: ASCENT");
    expect(text).not.toContain("(general)");
    await finish();
    // an admin can still change a single slot's map afterwards; the panel then says the slots differ
    const { poll, slots } = await freshPoll();
    await ctx.services.schedules.editSlot({ guildId, position: 1, mapInput: "ascent", now: FAR });
    await ctx.services.schedules.editSlot({ guildId, position: 2, mapInput: "bind", now: FAR });
    const mixed = await voteVia(poll.id, slots[0]!.id, p1);
    expect(visibleText(mixed.followUp.mock.calls[0]![0])).toContain("some slots use another map");
    await finish();
  });

  it("picking a main: saved, panel redrawn with 'YOUR MAIN', and the public card shows it without re-pinging anyone", async () => {
    const { poll, slots } = await freshPoll();
    await voteVia(poll.id, slots[0]!.id, p1);
    edits.length = 0;

    const c = await pickVia(poll.id, "jett", p1);
    const panel = lastPanel(c);
    expect(panel.content).toContain("**Jett** is your main");
    expect(panel.content).toContain("every slot this week");
    expect(visibleText(panel)).toContain("YOUR MAIN");
    expect(await picksOf(poll.id)).toEqual([[p1.id, "MAIN", "jett"]]);

    // the public schedule card was refreshed with the pick, and that edit cannot notify anyone
    expect(cardEdits(poll.id)).toHaveLength(1);
    expect(visibleText(cardEdits(poll.id)[0]!.payload)).toContain(`<@${p1.id}> · **Jett**`);
    expect(cardEdits(poll.id)[0]!.payload.suppressMentions).toBe(true);
    expect(cardEdits(poll.id)[0]!.payload.mentionUserIds ?? []).toHaveLength(0);

    // picking the same agent again changes nothing and doesn't refresh the card
    edits.length = 0;
    expect(lastPanel(await pickVia(poll.id, "jett", p1)).content).toContain("already your main");
    expect(edits).toHaveLength(0);
    await finish();
  });

  it("a main agent has one holder: the second player is told who has it; the first can change and free it", async () => {
    const { poll, slots } = await freshPoll();
    await voteVia(poll.id, slots[0]!.id, p1);
    await voteVia(poll.id, slots[0]!.id, p2);
    await pickVia(poll.id, "jett", p1);

    const taken = await pickVia(poll.id, "jett", p2);
    expect(lastPanel(taken).content).toContain(`already <@${p1.id}>'s main`);
    expect(lastPanel(taken).content).toContain("take it as your second");
    expect(await picksOf(poll.id)).toEqual([[p1.id, "MAIN", "jett"]]);
    expect(cell(lastPanel(taken), "Jett")!.value).toContain(`🔒 <@${p1.id}>`);
    const jettButton = (lastPanel(taken).components!.flatMap((r) => r.toJSON().components) as Array<{ label: string; disabled?: boolean }>).find((b) => b.label.startsWith("Jett"))!;
    expect(jettButton.disabled).toBe(true);

    // p1 switches to Raze: Jett is free again for p2
    await pickVia(poll.id, "raze", p1);
    expect((await picksOf(poll.id)).map((p) => p[2])).toEqual(["raze"]);
    expect(lastPanel(await pickVia(poll.id, "jett", p2)).content).toContain("**Jett** is your main");
    await finish();
  });

  it("two players grabbing the same main at once: exactly one wins (unique index, not luck)", async () => {
    const { poll, slots } = await freshPoll();
    await voteVia(poll.id, slots[0]!.id, p1);
    await voteVia(poll.id, slots[0]!.id, p2);
    const results = await Promise.all([
      ctx.services.agentPicks.pick({ guildId, pollId: poll.id, discordUserId: p1.id, agentKey: "omen", target: "MAIN" }),
      ctx.services.agentPicks.pick({ guildId, pollId: poll.id, discordUserId: p2.id, agentKey: "omen", target: "MAIN" }),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect((await picksOf(poll.id)).filter((p) => p[2] === "omen")).toHaveLength(1);
    await finish();
  });

  describe("the optional second agent", () => {
    it("needs a main first, can't be the same agent as the main, and replaces the previous second", async () => {
      const { poll, slots } = await freshPoll();
      await voteVia(poll.id, slots[0]!.id, p1);

      const early = await pickVia(poll.id, "reyna", p1, "SECOND");
      expect(lastPanel(early).content).toContain("Pick your **main** agent first");
      expect(await picksOf(poll.id)).toEqual([]);

      await pickVia(poll.id, "jett", p1);
      const same = await pickVia(poll.id, "jett", p1, "SECOND");
      expect(lastPanel(same).content).toContain("already your main");

      const first = await pickVia(poll.id, "reyna", p1, "SECOND");
      expect(lastPanel(first).content).toContain("**Reyna** is your second agent");
      expect(await picksOf(poll.id)).toEqual([[p1.id, "MAIN", "jett"], [p1.id, "SECOND", "reyna"]]);
      expect(visibleText(lastPanel(first))).toContain("YOUR SECOND");

      await pickVia(poll.id, "raze", p1, "SECOND"); // replaces Reyna
      expect((await picksOf(poll.id)).filter((p) => p[1] === "SECOND").map((p) => p[2])).toEqual(["raze"]);
      expect(lastPanel(await pickVia(poll.id, "raze", p1, "SECOND")).content).toContain("already your second");
      await finish();
    });

    it("is a backup, so it may be an agent someone else plays as their main — and then two players may share a second", async () => {
      const { poll, slots } = await freshPoll();
      await voteVia(poll.id, slots[0]!.id, p1);
      await voteVia(poll.id, slots[0]!.id, p2);
      await voteVia(poll.id, slots[0]!.id, p3);
      await pickVia(poll.id, "jett", p1);
      await pickVia(poll.id, "omen", p2);
      await pickVia(poll.id, "sova", p3);
      await pickVia(poll.id, "jett", p2, "SECOND"); // p1's main
      await pickVia(poll.id, "jett", p3, "SECOND"); // and the same backup as p2
      expect((await picksOf(poll.id)).filter((p) => p[1] === "SECOND").map((p) => [p[0], p[2]])).toEqual([[p2.id, "jett"], [p3.id, "jett"]]);
      // ...but it can never become a *main* while p1 holds it
      expect((await picksOf(poll.id)).filter((p) => p[1] === "MAIN" && p[2] === "jett")).toHaveLength(1);
      await finish();
    });

    it("the 'Pick a second agent' button switches the panel to the second, and 'Back to my main' switches back", async () => {
      const { poll, slots } = await freshPoll();
      await voteVia(poll.id, slots[0]!.id, p1);
      await pickVia(poll.id, "jett", p1);
      const toSecond = click(agentTargetId(poll.id, "DUELIST", "SECOND"), p1, guildId);
      await dispatchButton(toSecond.interaction, ctx);
      expect(visibleText(lastPanel(toSecond))).toContain("choosing your SECOND");
      expect(cell(lastPanel(toSecond), "Jett")!.value).toContain("⭐ your main");
      // role tabs keep choosing the second
      const tab = click(agentRoleId(poll.id, "SENTINEL", "SECOND"), p1, guildId);
      await dispatchButton(tab.interaction, ctx);
      expect(visibleText(lastPanel(tab))).toContain("choosing your SECOND");
      const back = click(agentTargetId(poll.id, "SENTINEL", "MAIN"), p1, guildId);
      await dispatchButton(back.interaction, ctx);
      expect(visibleText(lastPanel(back))).toContain("choosing your MAIN");
      await finish();
    });

    it("choosing your own second as your main swaps them", async () => {
      const { poll, slots } = await freshPoll();
      await voteVia(poll.id, slots[0]!.id, p1);
      await pickVia(poll.id, "jett", p1);
      await pickVia(poll.id, "reyna", p1, "SECOND");
      const swap = await pickVia(poll.id, "reyna", p1);
      expect(lastPanel(swap).content).toContain("**Reyna** is your main");
      expect(lastPanel(swap).content).toContain("**Jett** moved to your second");
      expect(await picksOf(poll.id)).toEqual([[p1.id, "MAIN", "reyna"], [p1.id, "SECOND", "jett"]]);
      // changing the main to something else keeps the backup
      await pickVia(poll.id, "raze", p1);
      expect(await picksOf(poll.id)).toEqual([[p1.id, "MAIN", "raze"], [p1.id, "SECOND", "jett"]]);
      await finish();
    });

    it("the public card and the lineup show both, and Clear second / Clear my picks remove them", async () => {
      const { poll, slots } = await freshPoll();
      await voteVia(poll.id, slots[0]!.id, p1);
      await pickVia(poll.id, "jett", p1);
      edits.length = 0;
      await pickVia(poll.id, "reyna", p1, "SECOND");
      expect(visibleText(cardEdits(poll.id).at(-1)!.payload)).toContain(`<@${p1.id}> · **Jett** / Reyna`);

      const clearSecond = click(agentClearId(poll.id, "DUELIST", "SECOND"), p1, guildId);
      await dispatchButton(clearSecond.interaction, ctx);
      expect(lastPanel(clearSecond).content).toContain("Second agent cleared");
      expect(visibleText(lastPanel(clearSecond))).toContain("choosing your SECOND");
      expect(await picksOf(poll.id)).toEqual([[p1.id, "MAIN", "jett"]]);

      await pickVia(poll.id, "reyna", p1, "SECOND");
      const clearAll = click(agentClearId(poll.id, "DUELIST", "ALL"), p1, guildId);
      await dispatchButton(clearAll.interaction, ctx);
      expect(lastPanel(clearAll).content).toContain("Picks cleared");
      expect(visibleText(lastPanel(clearAll))).toContain("choosing your MAIN"); // a second can't outlive its main
      expect(await picksOf(poll.id)).toEqual([]);

      const twice = click(agentClearId(poll.id, "DUELIST", "ALL"), p1, guildId);
      await dispatchButton(twice.interaction, ctx);
      expect(lastPanel(twice).content).toContain("hadn't picked");
      await finish();
    });
  });

  describe("one squad for the whole schedule", () => {
    it("one pick covers every slot: it shows on each slot the player is in, and survives dropping one of them", async () => {
      const { poll, slots } = await freshPoll();
      const [s1, s2] = slots as [(typeof slots)[number], (typeof slots)[number]];
      await voteVia(poll.id, s1.id, p1);
      await voteVia(poll.id, s2.id, p1);
      await pickVia(poll.id, "jett", p1);
      await pickVia(poll.id, "reyna", p1, "SECOND");
      expect(await picksOf(poll.id)).toHaveLength(2); // two rows for the player — not one per slot

      const view = (await ctx.services.schedules.getView(poll.id))!;
      expect(view.picks.map((p) => p.agentKey).sort()).toEqual(["jett", "reyna"]);
      const card = visibleText(cardEdits(poll.id).at(-1)!.payload);
      expect(card.match(/<@[^>]+> · \*\*Jett\*\* \/ Reyna/g)).toHaveLength(2); // once under each slot

      await voteVia(poll.id, s1.id, p1); // toggles the first slot off — they are still in the second
      expect(await picksOf(poll.id)).toHaveLength(2);
      await finish();
    });

    it("picks go when the player's LAST vote does, and when they say they can't play any day", async () => {
      const { poll, slots } = await freshPoll();
      const [s1, s2] = slots as [(typeof slots)[number], (typeof slots)[number]];
      await voteVia(poll.id, s1.id, p1);
      await voteVia(poll.id, s2.id, p1);
      await pickVia(poll.id, "jett", p1);
      await pickVia(poll.id, "reyna", p1, "SECOND");
      await voteVia(poll.id, s1.id, p1);
      expect(await picksOf(poll.id)).toHaveLength(2);
      await voteVia(poll.id, s2.id, p1); // the last one
      expect(await picksOf(poll.id)).toEqual([]);

      await voteVia(poll.id, s1.id, p1);
      await pickVia(poll.id, "jett", p1);
      await dispatchButton(click(buildDeclineCustomId(poll.id), p1, guildId).interaction, ctx);
      expect(await picksOf(poll.id)).toEqual([]);
      // and now the panel is refused: they're out
      const refused = await pickVia(poll.id, "raze", p1);
      expect(refused.reply.mock.calls[0]![0].content).toContain("Vote for a slot first");
      await finish();
    });

    it("the AGENT SELECT lineup is one squad card with the second under the main", async () => {
      const { poll, slots } = await freshPoll();
      await voteVia(poll.id, slots[0]!.id, p1);
      await voteVia(poll.id, slots[1]!.id, p1);
      await voteVia(poll.id, slots[1]!.id, p2);
      await pickVia(poll.id, "jett", p1);
      await pickVia(poll.id, "reyna", p1, "SECOND");
      const lineup = edits.filter((e) => e.messageId.startsWith("posted-")).at(-1)!.payload;
      expect(lineup.embeds).toHaveLength(1);
      const embed = lineup.embeds![0]!.toJSON();
      expect(embed.title).toContain("THE SQUAD");
      expect(embed.description).toContain("1/2"); // p1 locked in, p2 still choosing
      expect(embed.fields!.find((f) => f.name.includes("JETT"))!.value).toContain("2nd:");
      expect(embed.fields!.find((f) => f.name.includes("STILL CHOOSING"))!.value).toBe(`<@${p2.id}>`);
      await finish();
    });
  });

  it("the card's 🎯 PICK AGENT button opens the panel; refuses someone with no vote", async () => {
    const { poll, slots } = await freshPoll();
    const none = click(buildAgentsCustomId(poll.id), p1, guildId);
    await dispatchButton(none.interaction, ctx);
    expect(none.reply.mock.calls[0]![0].content).toContain("Vote for a slot first");
    expect(none.followUp).not.toHaveBeenCalled();

    await voteVia(poll.id, slots[1]!.id, p1); // only the Sunday slot
    const open = click(buildAgentsCustomId(poll.id), p1, guildId);
    await dispatchButton(open.interaction, ctx);
    expect(open.update).not.toHaveBeenCalled(); // the public card is left alone
    expect(visibleText(open.followUp.mock.calls[0]![0])).toContain("ONE SQUAD FOR EVERY SLOT");
    await finish();
  });

  it("only voters who are Premier players can open or use the panel", async () => {
    const { poll, slots } = await freshPoll();
    await voteVia(poll.id, slots[0]!.id, p1);

    for (const [who, msg] of [[member, "Premier players only"], [outsider, "Only Premier players"], [p2, "Vote for a slot first"]] as const) {
      const c = await pickVia(poll.id, "jett", who);
      expect(c.reply.mock.calls[0]![0].content, who.name).toContain(msg);
    }
    expect(await picksOf(poll.id)).toEqual([]);
    // an agent that doesn't exist, and a schedule that doesn't exist
    const ghost = await pickVia(poll.id, "notanagent", p1);
    expect(ghost.reply.mock.calls[0]![0].content).toContain("isn't in the list");
    const gone = await pickVia(999999999, "jett", p1);
    expect(gone.reply.mock.calls[0]![0].content).toContain("no longer exists");
    await finish();
  });

  it("a button from a panel posted before the squad was per schedule is refused with a pointer, and touches nothing", async () => {
    const { poll, slots } = await freshPoll();
    await voteVia(poll.id, slots[0]!.id, p1);
    // `agent:<slotId>:p:jett` — the slot's id happens to equal some poll's id in a fresh database; it must never be read as one.
    const legacy = click(`agent:${slots[0]!.id}:p:jett`, p1, guildId);
    await dispatchButton(legacy.interaction, ctx);
    expect(legacy.reply.mock.calls[0]![0].content).toContain("PICK AGENT");
    expect(await picksOf(poll.id)).toEqual([]);
    await finish();
  });

  describe("adding an agent that isn't listed", () => {
    const submit = async (pollId: number, role: "DUELIST" | "INITIATOR" | "CONTROLLER" | "SENTINEL", who: { id: string; name: string }, name: string, target: "MAIN" | "SECOND" = "MAIN", token = "tok") => {
      const code = { DUELIST: "D", INITIATOR: "I", CONTROLLER: "C", SENTINEL: "S" }[role];
      const raw = {
        id: "i-modal",
        token,
        guild_id: guildId,
        user: { id: who.id, username: who.name, global_name: who.name },
        member: { user: { id: who.id, username: who.name, global_name: who.name }, nick: null, roles: [] },
        data: { custom_id: `squadadd:${pollId}:${code}${target === "MAIN" ? 1 : 2}`, components: [{ type: ComponentType.Label, component: { type: ComponentType.TextInput, custom_id: "agent_name", value: name } }] },
      } as unknown as APIModalSubmitInteraction;
      interactionEdits.length = 0;
      followups.length = 0;
      await handleAgentAddModal(raw, ctx);
      return { edit: interactionEdits.at(-1)?.payload, followup: followups.at(-1)?.payload };
    };

    it("adds it to the role, says who suggested it, shows it to everyone, and lets people pick it", async () => {
      const { poll, slots } = await freshPoll();
      await voteVia(poll.id, slots[0]!.id, p1);
      await voteVia(poll.id, slots[0]!.id, p2);

      const r = await submit(poll.id, "DUELIST", p1, "Zephyr");
      expect(r.edit!.content).toContain("**Zephyr** added to Duelists");
      expect(r.edit!.content).toContain(`suggested by <@${p1.id}>`);
      const card = cell(r.edit!, "Zephyr")!;
      expect(card.value).toContain(`➕ by <@${p1.id}>`);
      expect(card.value).toContain("Open");
      const stored = (await ctx.repositories.schedules.listCustomAgents(guildId)).find((c) => c.key === "zephyr")!;
      expect(stored).toMatchObject({ displayName: "Zephyr", role: "DUELIST", suggestedByUserId: p1.id });

      // another player sees it on the Duelists tab, credited to p1
      const tab = click(agentRoleId(poll.id, "DUELIST", "MAIN"), p2, guildId);
      await dispatchButton(tab.interaction, ctx);
      expect(cell(lastPanel(tab), "Zephyr")!.value).toContain(`➕ by <@${p1.id}>`);

      // ...and can pick it; the public card then shows the name
      edits.length = 0;
      const pickIt = await pickVia(poll.id, "zephyr", p2);
      expect(lastPanel(pickIt).content).toContain("**Zephyr** is your main");
      expect(visibleText(cardEdits(poll.id).at(-1)!.payload)).toContain(`<@${p2.id}> · **Zephyr**`);
      await finish();
    });

    it("the popup returns to the same pick it was opened from (a second stays a second)", async () => {
      const { poll, slots } = await freshPoll();
      await voteVia(poll.id, slots[0]!.id, p1);
      await pickVia(poll.id, "jett", p1);
      const r = await submit(poll.id, "SENTINEL", p1, "Bastion", "SECOND");
      expect(visibleText(r.edit!)).toContain("choosing your SECOND");
      await finish();
    });

    it("a second submit of the same name doesn't add a duplicate; it says who added it", async () => {
      const { poll, slots } = await freshPoll();
      await voteVia(poll.id, slots[0]!.id, p1);
      await voteVia(poll.id, slots[0]!.id, p2);
      await submit(poll.id, "SENTINEL", p1, "Bastion");
      const dup = await submit(poll.id, "SENTINEL", p2, " bastion ");
      expect(dup.edit!.content).toContain(`already added by <@${p1.id}>`);
      expect((await ctx.repositories.schedules.listCustomAgents(guildId)).filter((c) => c.key === "bastion")).toHaveLength(1);
      await finish();
    });

    it("a built-in agent can't be 'added' again, however it's spelled — and it jumps to the right tab", async () => {
      const { poll, slots } = await freshPoll();
      await voteVia(poll.id, slots[0]!.id, p1);
      const r = await submit(poll.id, "DUELIST", p1, "kay-o");
      expect(r.edit!.content).toContain("**KAY/O** is already in the list under Initiators");
      expect(cell(r.edit!, "KAY/O")).toBeTruthy(); // now on the Initiators tab
      await finish();
    });

    it.each(["x", "", "a".repeat(21), "bad<script>", "@everyone", "🔥🔥"])("rejects the name %j", async (name) => {
      const { poll, slots } = await freshPoll();
      await voteVia(poll.id, slots[0]!.id, p1);
      const before = (await ctx.repositories.schedules.listCustomAgents(guildId)).length;
      const r = await submit(poll.id, "DUELIST", p1, name);
      expect(r.edit!.content).toMatch(/Agent names are 2–20 characters|isn't usable/);
      expect((await ctx.repositories.schedules.listCustomAgents(guildId)).length).toBe(before);
      await finish();
    });

    it("limits how many agents one player can add", async () => {
      const { poll, slots } = await freshPoll();
      await voteVia(poll.id, slots[0]!.id, p3);
      const mine = (await ctx.repositories.schedules.listCustomAgents(guildId)).filter((c) => c.suggestedByUserId === p3.id).length;
      for (let i = mine; i < MAX_SUGGESTIONS_PER_PLAYER; i++) await submit(poll.id, "CONTROLLER", p3, `Capagent${i}x`);
      const over = await submit(poll.id, "CONTROLLER", p3, "Onetoomany");
      expect(over.edit!.content).toContain(`already added ${MAX_SUGGESTIONS_PER_PLAYER} agents`);
      await finish();
    });

    it("members, non-voters and unregistered users get a private refusal and nothing is stored", async () => {
      const { poll, slots } = await freshPoll();
      await voteVia(poll.id, slots[0]!.id, p1);
      const before = (await ctx.repositories.schedules.listCustomAgents(guildId)).length;
      for (const who of [member, outsider, p2]) {
        const r = await submit(poll.id, "DUELIST", who, "Sneaky");
        expect(r.followup!.content, who.name).toMatch(/Premier players|Vote for a slot first/);
        expect(r.edit).toBeUndefined();
      }
      expect((await ctx.repositories.schedules.listCustomAgents(guildId)).length).toBe(before);
      await finish();
    });
  });
});
