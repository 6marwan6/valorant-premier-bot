import { describe, expect, it, vi } from "vitest";
import { AGENTS, agentEmojiName, agentSmallIconUrl } from "../../src/modules/agents/agentData.js";
import { agentEmojiMapFrom, agentIconText, agentsMissingEmojis, emojiMarkup } from "../../src/modules/agents/agentEmojis.js";
import { clearAgentEmojiCache, loadAgentEmojis } from "../../src/discord/agentEmojiCache.js";

describe("agent emoji map", () => {
  it("keeps only this app's agent_<key> emojis for known built-in agents", () => {
    const map = agentEmojiMapFrom([
      { id: "111111111111111111", name: "agent_jett" },
      { id: "222222222222222222", name: "agent_notanagent" },
      { id: "333333333333333333", name: "logo" },
      { id: "oops", name: "agent_sova" },
      { id: "444444444444444444", name: null },
    ]);
    expect([...map.keys()]).toEqual(["jett"]);
    expect(emojiMarkup(map.get("jett")!)).toBe("<:agent_jett:111111111111111111>");
  });

  it("falls back to the glyph when there is no emoji or no map", () => {
    const map = agentEmojiMapFrom([{ id: "111111111111111111", name: "agent_jett" }]);
    expect(agentIconText("jett", "⚔️", map)).toBe("<:agent_jett:111111111111111111>");
    expect(agentIconText("raze", "⚔️", map)).toBe("⚔️");
    expect(agentIconText("raze", "⚔️", undefined)).toBe("⚔️");
  });

  it("names every emoji validly (2–32 chars, letters/digits/underscore) and points at the small portrait", () => {
    for (const a of AGENTS) {
      expect(agentEmojiName(a.key)).toMatch(/^[A-Za-z0-9_]{2,32}$/);
      expect(agentSmallIconUrl(a)).toBe(`https://media.valorant-api.com/agents/${a.uuid}/displayiconsmall.png`);
    }
  });

  it("plans uploads only for agents without an emoji yet (the sync script is safe to re-run)", () => {
    expect(agentsMissingEmojis([])).toHaveLength(AGENTS.length);
    const some = agentsMissingEmojis(["agent_jett", "agent_sova", "unrelated"]);
    expect(some).toHaveLength(AGENTS.length - 2);
    expect(some.some((a) => a.key === "jett")).toBe(false);
    expect(agentsMissingEmojis(AGENTS.map((a) => agentEmojiName(a.key)))).toHaveLength(0);
  });
});

describe("loadAgentEmojis", () => {
  const list = [{ id: "111111111111111111", name: "agent_jett" }];

  it("fetches once and shares the result (including concurrent callers)", async () => {
    const discord = { listApplicationEmojis: vi.fn(async () => list) };
    const [a, b] = await Promise.all([loadAgentEmojis(discord, undefined, 1000), loadAgentEmojis(discord, undefined, 1000)]);
    await loadAgentEmojis(discord, undefined, 2000);
    expect(discord.listApplicationEmojis).toHaveBeenCalledTimes(1);
    expect(a.get("jett")?.id).toBe("111111111111111111");
    expect(b).toBe(a);
  });

  it("refreshes after the TTL", async () => {
    const discord = { listApplicationEmojis: vi.fn(async () => list) };
    await loadAgentEmojis(discord, undefined, 1000);
    await loadAgentEmojis(discord, undefined, 1000 + 11 * 60_000);
    expect(discord.listApplicationEmojis).toHaveBeenCalledTimes(2);
  });

  it("never throws: a Discord failure gives an empty map, logged, and is retried only after a minute", async () => {
    const warn = vi.fn();
    const discord = { listApplicationEmojis: vi.fn(async () => { throw new Error("discord down"); }) };
    expect((await loadAgentEmojis(discord, { warn }, 1000)).size).toBe(0);
    expect((await loadAgentEmojis(discord, { warn }, 30_000)).size).toBe(0);
    expect(discord.listApplicationEmojis).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    await loadAgentEmojis(discord, { warn }, 1000 + 61_000);
    expect(discord.listApplicationEmojis).toHaveBeenCalledTimes(2);
  });

  it("copes with a Discord client that has no emoji support at all (a fake in a test, say)", async () => {
    expect((await loadAgentEmojis({} as never)).size).toBe(0);
  });

  it("can be cleared", async () => {
    const discord = { listApplicationEmojis: vi.fn(async () => list) };
    await loadAgentEmojis(discord, undefined, 1000);
    clearAgentEmojiCache(discord);
    await loadAgentEmojis(discord, undefined, 1001);
    expect(discord.listApplicationEmojis).toHaveBeenCalledTimes(2);
  });
});
