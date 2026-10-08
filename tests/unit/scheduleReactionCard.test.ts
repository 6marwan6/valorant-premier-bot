import { describe, expect, it } from "vitest";
import type { ScheduleSlotRow } from "../../src/database/schema/schedules.js";
import { agentByKey, agentIconUrl } from "../../src/modules/agents/agentData.js";
import { agentEmojiMapFrom } from "../../src/modules/agents/agentEmojis.js";
import { buildVoteEvent, buildDeclineEvent } from "../../src/modules/schedules/scheduleAiEvent.js";
import { buildScheduleReactionCard } from "../../src/modules/schedules/scheduleMessage.js";

const slot: ScheduleSlotRow = { id: 1, pollId: 1, position: 1, scheduledAt: new Date("2026-10-10T16:00:00Z"), queueAt: null, remindMode: "AUTO", map: null, quorumAnnouncedAt: null, createdAt: new Date() };
const player = { discordUserId: "u1", displayName: "Ahmed", role: "DUELIST" as const, preferredAgent: "Raze" };
const AVATAR = "https://cdn.example/a.png";
const fields = (c: ReturnType<typeof buildScheduleReactionCard>) => Object.fromEntries((c.embeds[0]!.toJSON().fields ?? []).map((f) => [f.name, f.value]));

describe("the LOCKED IN card shows the picked agent", () => {
  const base = { player, kind: "VOTE" as const, text: "LET'S GO", pollId: 1, slot, timezone: "Africa/Cairo", avatarUrl: AVATAR };

  it("names the picked agent and its role (not the profile's preferred agent), with the portrait as the picture and the avatar in the author line", () => {
    const card = buildScheduleReactionCard({ ...base, agent: { key: "sova", name: "Sova", role: "INITIATOR" } });
    const j = card.embeds[0]!.toJSON();
    expect(fields(card).Agent).toBe("🔎 **Sova**");
    expect(fields(card).Role).toBe("🔎 Initiator");
    expect(JSON.stringify(j)).not.toContain("Raze");
    expect(j.thumbnail?.url).toBe(agentIconUrl(agentByKey("sova")!));
    expect(j.author?.icon_url).toBe(AVATAR);
  });

  it("uses the portrait emoji for the agent once uploaded", () => {
    const emojis = agentEmojiMapFrom([{ id: "111111111111111111", name: "agent_sova" }]);
    expect(fields(buildScheduleReactionCard({ ...base, agent: { key: "sova", name: "Sova", role: "INITIATOR" }, emojis })).Agent).toBe("<:agent_sova:111111111111111111> **Sova**");
  });

  it("a player-suggested agent has no portrait: the avatar stays the picture and the role glyph stands in", () => {
    const card = buildScheduleReactionCard({ ...base, agent: { key: "newguy", name: "Newguy", role: "CONTROLLER" } });
    expect(card.embeds[0]!.toJSON().thumbnail?.url).toBe(AVATAR);
    expect(fields(card).Agent).toBe("☁️ **Newguy**");
  });

  it("without an agent (and for OUT THIS WEEK) it is the same card as before: avatar, role, preferred agent", () => {
    const out = buildScheduleReactionCard({ ...base, kind: "DECLINE", slot: undefined });
    expect(out.embeds[0]!.toJSON().thumbnail?.url).toBe(AVATAR);
    expect(fields(out)).toEqual({ Role: "⚔️ Duelist", Agent: "Raze" });
  });
});

describe("what Mari is told", () => {
  it("a vote event carries the locked-in agent as a fact when there is one, and is unchanged otherwise", () => {
    const withAgent = buildVoteEvent({ pollId: 1, slot, timezone: "Africa/Cairo", agent: { name: "Jett", role: "DUELIST" } }).lines.join("\n");
    expect(withAgent).toContain("Agent they locked in for that slot: Jett (Duelist)");
    expect(withAgent).toContain("Player response: PLAYING");
    expect(buildVoteEvent({ pollId: 1, slot, timezone: "Africa/Cairo" }).lines.join("\n")).not.toContain("locked in");
    expect(buildDeclineEvent({ pollId: 1, slotCount: 2 }).lines.join("\n")).not.toContain("Agent");
  });
});
