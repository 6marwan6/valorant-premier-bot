import { describe, expect, it, vi } from "vitest";
import { Routes } from "discord.js";
import { DiscordRestClient, allowedMentionsFor } from "../../src/discord/discordRest.js";

describe("allowed_mentions on channel messages (2026-10-02)", () => {
  it("is only set when mentions are suppressed", () => {
    expect(allowedMentionsFor({})).toBeUndefined();
    expect(allowedMentionsFor({ suppressMentions: false, mentionUserIds: ["1"] })).toBeUndefined();
  });

  it("suppressed = nobody can be pinged, except the explicitly allowed users", () => {
    expect(allowedMentionsFor({ suppressMentions: true })).toEqual({ parse: [] });
    expect(allowedMentionsFor({ suppressMentions: true, mentionUserIds: ["1", "1", "2"] })).toEqual({ parse: [], users: ["1", "2"] });
  });

  it("sendChannelMessage actually sends it to Discord (it used to drop suppressMentions)", async () => {
    const post = vi.fn(async () => ({ id: "m1" }));
    const client = new DiscordRestClient({ post } as never, "app");
    await client.sendChannelMessage("c1", { content: "@everyone hi", suppressMentions: true });
    await client.sendChannelMessage("c1", { content: "<@7> hi", suppressMentions: true, mentionUserIds: ["7"] });
    const calls = post.mock.calls as unknown as Array<[string, { body: { allowed_mentions?: unknown } }]>;
    expect(calls[0]![0]).toBe(Routes.channelMessages("c1"));
    expect(calls[0]![1].body.allowed_mentions).toEqual({ parse: [] });
    expect(calls[1]![1].body.allowed_mentions).toEqual({ parse: [], users: ["7"] });
  });
});
