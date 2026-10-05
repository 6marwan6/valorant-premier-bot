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
import { agentPickId, agentClearId, agentRoleId, agentSwitchId } from "../../src/modules/agents/agentCustomId.js";
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
      sendChannelMessage: vi.fn(async () => ({ id: "m" })),
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
  const voteVia = (pollId: number, slotId: number, u: { id: string; name: string }) => {
    const c = click(buildVoteCustomId(pollId, slotId), u, guildId);
    return dispatchButton(c.interaction, ctx).then(() => c);
  };
  const lastPanel = (c: ReturnType<typeof click>) => (c.update.mock.calls.at(-1)?.[0] ?? c.followUp.mock.calls.at(-1)![0]) as ReplyPayload;

  it("choosing a date opens the AGENT PICK panel (private), not a bare confirmation", async () => {
    const { poll, slots } = await freshPoll();
    const c = await voteVia(poll.id, slots[0]!.id, p1);
    expect(c.update).toHaveBeenCalledTimes(1); // the public card
    expect(c.followUp).toHaveBeenCalledTimes(1);
    const panel = c.followUp.mock.calls[0]![0];
    expect(panel.ephemeral).toBe(true);
    expect(panel.embeds!.length).toBeGreaterThan(1);
    expect(panel.components!.length).toBeGreaterThanOrEqual(3);
    const text = visibleText(panel);
    expect(text).toContain("AGENT PICK");
    expect(text).toContain("SAT 28/06");
    expect(text).toContain("SUGGESTED COMP A");
    expect(text).toContain("MAP: TBD");
    expect(panel.content).toContain("You're **in**");
    // p1 is a Duelist: the panel opens on the Duelists tab.
    expect(panel.embeds!.slice(1).some((e) => e.toJSON().title?.includes("JETT"))).toBe(true);
    // the controller and sentinel tabs are one tap away
    const tabs = (panel.components![0]!.toJSON().components as Array<{ label: string; disabled?: boolean }>);
    expect(tabs.map((t) => t.label)).toEqual(["Duelists", "Initiators", "Controllers", "Sentinels"]);
    expect(tabs[0]!.disabled).toBe(true);
    await finish();
  });

  it("the panel shows the map and its comps once an admin sets the map", async () => {
    const { poll, slots } = await freshPoll();
    const edit = await ctx.services.schedules.editSlot({ guildId, position: 1, mapInput: "ascent", now: FAR });
    expect(edit.ok && edit.value.slot.map).toBe("Ascent");
    const c = await voteVia(poll.id, slots[0]!.id, p1);
    const text = visibleText(c.followUp.mock.calls[0]![0]);
    expect(text).toContain("MAP: ASCENT");
    expect(text).not.toContain("(general)");
    const bad = await ctx.services.schedules.editSlot({ guildId, position: 1, mapInput: "dust2", now: FAR });
    expect(bad.ok).toBe(false);
    const cleared = await ctx.services.schedules.editSlot({ guildId, position: 1, mapInput: "clear", now: FAR });
    expect(cleared.ok && cleared.value.slot.map).toBeNull();
    await finish();
  });

  it("picking an agent: saved, panel redrawn with 'YOUR PICK', and the public card shows it without re-pinging anyone", async () => {
    const { poll, slots } = await freshPoll();
    const slotId = slots[0]!.id;
    await voteVia(poll.id, slotId, p1);
    edits.length = 0;

    const c = click(agentPickId(slotId, "jett"), p1, guildId);
    await dispatchButton(c.interaction, ctx);
    const panel = lastPanel(c);
    expect(panel.content).toContain("You're playing **Jett**");
    expect(visibleText(panel)).toContain("YOUR PICK");
    expect((await ctx.repositories.schedules.listPicksBySlot(slotId)).map((p) => [p.discordUserId, p.agentKey])).toEqual([[p1.id, "jett"]]);

    // the public schedule card was refreshed with the pick, and that edit cannot notify anyone
    expect(edits).toHaveLength(1);
    expect(edits[0]!.messageId).toBe(`msg-${poll.id}`);
    expect(visibleText(edits[0]!.payload)).toContain(`<@${p1.id}> · **Jett**`);
    expect(edits[0]!.payload.suppressMentions).toBe(true);
    expect(edits[0]!.payload.mentionUserIds ?? []).toHaveLength(0);

    // picking the same agent again changes nothing and doesn't refresh the card
    edits.length = 0;
    const again = click(agentPickId(slotId, "jett"), p1, guildId);
    await dispatchButton(again.interaction, ctx);
    expect(lastPanel(again).content).toContain("already your pick");
    expect(edits).toHaveLength(0);
    await finish();
  });

  it("an agent has one holder per slot: the second player is told who has it; the first player can change and free it", async () => {
    const { poll, slots } = await freshPoll();
    const slotId = slots[0]!.id;
    await voteVia(poll.id, slotId, p1);
    await voteVia(poll.id, slotId, p2);
    await dispatchButton(click(agentPickId(slotId, "jett"), p1, guildId).interaction, ctx);

    const taken = click(agentPickId(slotId, "jett"), p2, guildId);
    await dispatchButton(taken.interaction, ctx);
    expect(lastPanel(taken).content).toContain(`already picked by <@${p1.id}>`);
    expect((await ctx.repositories.schedules.listPicksBySlot(slotId)).map((p) => p.discordUserId)).toEqual([p1.id]);
    // The panel jumps to the tab of the agent that was refused and shows Jett as picked by p1, with its button disabled.
    const card = lastPanel(taken).embeds!.map((e) => e.toJSON()).find((e) => e.title?.includes("JETT"))!;
    expect(card.description).toContain(`PICKED BY** <@${p1.id}>`);
    const jettButton = (lastPanel(taken).components!.flatMap((r) => r.toJSON().components) as Array<{ label: string; disabled?: boolean }>).find((b) => b.label.startsWith("Jett"))!;
    expect(jettButton.disabled).toBe(true);

    // p1 switches to Raze: Jett is free again for p2
    await dispatchButton(click(agentPickId(slotId, "raze"), p1, guildId).interaction, ctx);
    expect((await ctx.repositories.schedules.listPicksBySlot(slotId)).map((p) => p.agentKey)).toEqual(["raze"]);
    const nowFree = click(agentPickId(slotId, "jett"), p2, guildId);
    await dispatchButton(nowFree.interaction, ctx);
    expect(lastPanel(nowFree).content).toContain("You're playing **Jett**");
    await finish();
  });

  it("two players grabbing the same agent at once: exactly one wins (unique index, not luck)", async () => {
    const { poll, slots } = await freshPoll();
    const slotId = slots[0]!.id;
    await voteVia(poll.id, slotId, p1);
    await voteVia(poll.id, slotId, p2);
    const results = await Promise.all([
      ctx.services.agentPicks.pick({ guildId, slotId, discordUserId: p1.id, agentKey: "omen" }),
      ctx.services.agentPicks.pick({ guildId, slotId, discordUserId: p2.id, agentKey: "omen" }),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    const picks = await ctx.repositories.schedules.listPicksBySlot(slotId);
    expect(picks.filter((p) => p.agentKey === "omen")).toHaveLength(1);
    await finish();
  });

  it("clear my pick; and a pick is per slot, so the same agent can be played in two matches", async () => {
    const { poll, slots } = await freshPoll();
    const [s1, s2] = slots as [(typeof slots)[number], (typeof slots)[number]];
    await voteVia(poll.id, s1.id, p1);
    await voteVia(poll.id, s2.id, p1);
    await dispatchButton(click(agentPickId(s1.id, "jett"), p1, guildId).interaction, ctx);
    await dispatchButton(click(agentPickId(s2.id, "jett"), p1, guildId).interaction, ctx);
    expect((await ctx.repositories.schedules.listPicksBySlot(s1.id))).toHaveLength(1);
    expect((await ctx.repositories.schedules.listPicksBySlot(s2.id))).toHaveLength(1);

    const clear = click(agentClearId(s1.id, "DUELIST"), p1, guildId);
    await dispatchButton(clear.interaction, ctx);
    expect(lastPanel(clear).content).toContain("Pick cleared");
    expect(await ctx.repositories.schedules.listPicksBySlot(s1.id)).toHaveLength(0);
    expect(await ctx.repositories.schedules.listPicksBySlot(s2.id)).toHaveLength(1);

    // clearing again is harmless
    const twice = click(agentClearId(s1.id, "DUELIST"), p1, guildId);
    await dispatchButton(twice.interaction, ctx);
    expect(lastPanel(twice).content).toContain("hadn't picked");
    await finish();
  });

  it("'Switch slot' cycles through my upcoming slots (only offered with more than one)", async () => {
    const { poll, slots } = await freshPoll();
    const [s1, s2] = slots as [(typeof slots)[number], (typeof slots)[number]];
    const one = await voteVia(poll.id, s1.id, p3);
    expect(JSON.stringify(lastPanel({ ...one, update: one.update } as never).components!.map((r) => r.toJSON()))).not.toContain("Switch slot");
    const two = await voteVia(poll.id, s2.id, p3);
    expect(JSON.stringify(two.followUp.mock.calls[0]![0].components!.map((r) => r.toJSON()))).toContain("Switch slot");

    const sw = click(agentSwitchId(s2.id, "SENTINEL"), p3, guildId);
    await dispatchButton(sw.interaction, ctx);
    expect(visibleText(lastPanel(sw))).toContain("SAT 28/06"); // back to the first slot
    const sw2 = click(agentSwitchId(s1.id, "SENTINEL"), p3, guildId);
    await dispatchButton(sw2.interaction, ctx);
    expect(visibleText(lastPanel(sw2))).toContain("SUN 29/06");
    await finish();
  });

  it("the card's 🎯 PICK AGENT button opens the panel for my first slot; refuses someone with no vote", async () => {
    const { poll, slots } = await freshPoll();
    const none = click(buildAgentsCustomId(poll.id), p1, guildId);
    await dispatchButton(none.interaction, ctx);
    expect(none.reply.mock.calls[0]![0].content).toContain("Vote for a slot first");
    expect(none.followUp).not.toHaveBeenCalled();

    await voteVia(poll.id, slots[1]!.id, p1); // only the Sunday slot
    const open = click(buildAgentsCustomId(poll.id), p1, guildId);
    await dispatchButton(open.interaction, ctx);
    expect(open.update).not.toHaveBeenCalled(); // the public card is left alone
    expect(visibleText(open.followUp.mock.calls[0]![0])).toContain("SUN 29/06");
    await finish();
  });

  it("taking back a vote (or declining) gives the agent back", async () => {
    const { poll, slots } = await freshPoll();
    const [s1, s2] = slots as [(typeof slots)[number], (typeof slots)[number]];
    await voteVia(poll.id, s1.id, p1);
    await voteVia(poll.id, s2.id, p1);
    await dispatchButton(click(agentPickId(s1.id, "jett"), p1, guildId).interaction, ctx);
    await dispatchButton(click(agentPickId(s2.id, "raze"), p1, guildId).interaction, ctx);

    await voteVia(poll.id, s1.id, p1); // toggles the vote off
    expect(await ctx.repositories.schedules.listPicksBySlot(s1.id)).toHaveLength(0);
    expect(await ctx.repositories.schedules.listPicksBySlot(s2.id)).toHaveLength(1);

    await dispatchButton(click(buildDeclineCustomId(poll.id), p1, guildId).interaction, ctx);
    expect(await ctx.repositories.schedules.listPicksBySlot(s2.id)).toHaveLength(0);
    // and now the panel is refused: they're out
    const refused = click(agentPickId(s2.id, "raze"), p1, guildId);
    await dispatchButton(refused.interaction, ctx);
    expect(refused.reply.mock.calls[0]![0].content).toContain("Vote for this slot first");
    await finish();
  });

  it("only voters who are Premier players can open or use the panel", async () => {
    const { poll, slots } = await freshPoll();
    const slotId = slots[0]!.id;
    await voteVia(poll.id, slotId, p1);

    for (const [who, msg] of [[member, "Premier players only"], [outsider, "Only Premier players"], [p2, "Vote for this slot first"]] as const) {
      const c = click(agentPickId(slotId, "jett"), who, guildId);
      await dispatchButton(c.interaction, ctx);
      expect(c.reply.mock.calls[0]![0].content, who.name).toContain(msg);
    }
    expect(await ctx.repositories.schedules.listPicksBySlot(slotId)).toHaveLength(0);
    // an agent that doesn't exist, and a slot that doesn't exist
    const ghost = click(agentPickId(slotId, "notanagent"), p1, guildId);
    await dispatchButton(ghost.interaction, ctx);
    expect(ghost.reply.mock.calls[0]![0].content).toContain("isn't in the list");
    const gone = click(agentPickId(999999999, "jett"), p1, guildId);
    await dispatchButton(gone.interaction, ctx);
    expect(gone.reply.mock.calls[0]![0].content).toContain("no longer exists");
    await finish();
  });

  describe("adding an agent that isn't listed", () => {
    const submit = async (slotId: number, role: "DUELIST" | "INITIATOR" | "CONTROLLER" | "SENTINEL", who: { id: string; name: string }, name: string, token = "tok") => {
      const code = { DUELIST: "D", INITIATOR: "I", CONTROLLER: "C", SENTINEL: "S" }[role];
      const raw = {
        id: "i-modal",
        token,
        guild_id: guildId,
        user: { id: who.id, username: who.name, global_name: who.name },
        member: { user: { id: who.id, username: who.name, global_name: who.name }, nick: null, roles: [] },
        data: { custom_id: `agentadd:${slotId}:${code}`, components: [{ type: ComponentType.Label, component: { type: ComponentType.TextInput, custom_id: "agent_name", value: name } }] },
      } as unknown as APIModalSubmitInteraction;
      interactionEdits.length = 0;
      followups.length = 0;
      await handleAgentAddModal(raw, ctx);
      return { edit: interactionEdits.at(-1)?.payload, followup: followups.at(-1)?.payload };
    };

    it("adds it to the role, says who suggested it, shows it to everyone, and lets people pick it", async () => {
      const { poll, slots } = await freshPoll();
      const slotId = slots[0]!.id;
      await voteVia(poll.id, slotId, p1);
      await voteVia(poll.id, slotId, p2);

      const r = await submit(slotId, "DUELIST", p1, "Zephyr");
      expect(r.edit!.content).toContain("**Zephyr** added to Duelists");
      expect(r.edit!.content).toContain(`suggested by <@${p1.id}>`);
      const card = r.edit!.embeds!.map((e) => e.toJSON()).find((e) => e.title?.includes("ZEPHYR"))!;
      expect(card.description).toContain(`ADDED BY <@${p1.id}>`);
      expect(card.description).toContain("OPEN");
      const stored = (await ctx.repositories.schedules.listCustomAgents(guildId)).find((c) => c.key === "zephyr")!;
      expect(stored).toMatchObject({ displayName: "Zephyr", role: "DUELIST", suggestedByUserId: p1.id });

      // another player sees it on the Duelists tab, credited to p1
      const tab = click(agentRoleId(slotId, "DUELIST"), p2, guildId);
      await dispatchButton(tab.interaction, ctx);
      const seen = lastPanel(tab).embeds!.map((e) => e.toJSON()).find((e) => e.title?.includes("ZEPHYR"))!;
      expect(seen.description).toContain(`ADDED BY <@${p1.id}>`);

      // ...and can pick it; the public card then shows the name
      edits.length = 0;
      const pickIt = click(agentPickId(slotId, "zephyr"), p2, guildId);
      await dispatchButton(pickIt.interaction, ctx);
      expect(lastPanel(pickIt).content).toContain("You're playing **Zephyr**");
      expect(visibleText(edits.at(-1)!.payload)).toContain(`<@${p2.id}> · **Zephyr**`);
      await finish();
    });

    it("a second submit of the same name doesn't add a duplicate; it says who added it", async () => {
      const { poll, slots } = await freshPoll();
      const slotId = slots[0]!.id;
      await voteVia(poll.id, slotId, p1);
      await voteVia(poll.id, slotId, p2);
      await submit(slotId, "SENTINEL", p1, "Bastion");
      const dup = await submit(slotId, "SENTINEL", p2, " bastion ");
      expect(dup.edit!.content).toContain(`already added by <@${p1.id}>`);
      expect((await ctx.repositories.schedules.listCustomAgents(guildId)).filter((c) => c.key === "bastion")).toHaveLength(1);
      await finish();
    });

    it("a built-in agent can't be 'added' again, however it's spelled — and it jumps to the right tab", async () => {
      const { poll, slots } = await freshPoll();
      const slotId = slots[0]!.id;
      await voteVia(poll.id, slotId, p1);
      const r = await submit(slotId, "DUELIST", p1, "kay-o");
      expect(r.edit!.content).toContain("**KAY/O** is already in the list under Initiators");
      expect(r.edit!.embeds!.map((e) => e.toJSON()).some((e) => e.title?.includes("KAY/O"))).toBe(true); // now on the Initiators tab
      await finish();
    });

    it.each(["x", "", "a".repeat(21), "bad<script>", "@everyone", "🔥🔥"])("rejects the name %j", async (name) => {
      const { poll, slots } = await freshPoll();
      await voteVia(poll.id, slots[0]!.id, p1);
      const before = (await ctx.repositories.schedules.listCustomAgents(guildId)).length;
      const r = await submit(slots[0]!.id, "DUELIST", p1, name);
      expect(r.edit!.content).toMatch(/Agent names are 2–20 characters|isn't usable/);
      expect((await ctx.repositories.schedules.listCustomAgents(guildId)).length).toBe(before);
      await finish();
    });

    it("limits how many agents one player can add", async () => {
      const { poll, slots } = await freshPoll();
      const slotId = slots[0]!.id;
      await voteVia(poll.id, slotId, p3);
      const mine = (await ctx.repositories.schedules.listCustomAgents(guildId)).filter((c) => c.suggestedByUserId === p3.id).length;
      for (let i = mine; i < MAX_SUGGESTIONS_PER_PLAYER; i++) await submit(slotId, "CONTROLLER", p3, `Capagent${i}x`);
      const over = await submit(slotId, "CONTROLLER", p3, "Onetoomany");
      expect(over.edit!.content).toContain(`already added ${MAX_SUGGESTIONS_PER_PLAYER} agents`);
      await finish();
    });

    it("members, non-voters and unregistered users get a private refusal and nothing is stored", async () => {
      const { poll, slots } = await freshPoll();
      const slotId = slots[0]!.id;
      await voteVia(poll.id, slotId, p1);
      const before = (await ctx.repositories.schedules.listCustomAgents(guildId)).length;
      for (const who of [member, outsider, p2]) {
        const r = await submit(slotId, "DUELIST", who, "Sneaky");
        expect(r.followup!.content, who.name).toMatch(/Premier players|Vote for this slot first/);
        expect(r.edit).toBeUndefined();
      }
      expect((await ctx.repositories.schedules.listCustomAgents(guildId)).length).toBe(before);
      await finish();
    });
  });
});
