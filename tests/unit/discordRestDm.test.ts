import { describe, expect, it, vi } from "vitest";
import { Routes } from "discord.js";
import { DiscordRestClient, type DiscordRest } from "../../src/discord/discordRest.js";

function client(overrides: { post?: ReturnType<typeof vi.fn>; get?: ReturnType<typeof vi.fn> } = {}) {
  const post = overrides.post ?? vi.fn(async () => ({ id: "x" }));
  const get = overrides.get ?? vi.fn(async () => []);
  const rest = { post, get } as unknown as DiscordRest;
  return { discord: new DiscordRestClient(rest, "app-1"), post, get };
}

describe("DiscordRestClient — DM support (Phase 7)", () => {
  it("createDmChannel POSTs the recipient to /users/@me/channels", async () => {
    const { discord, post } = client({ post: vi.fn(async () => ({ id: "dm-9" })) });
    await expect(discord.createDmChannel("user-1")).resolves.toEqual({ id: "dm-9" });
    expect(post).toHaveBeenCalledWith(Routes.userChannels(), { body: { recipient_id: "user-1" } });
  });

  it("sendDirectMessage never allows any mention to ping (allowed_mentions.parse = [])", async () => {
    const { discord, post } = client();
    await discord.sendDirectMessage("dm-1", { content: "hi @everyone <@123>" });
    const [route, options] = post.mock.calls[0] as unknown as [string, { body: Record<string, unknown> }];
    expect(route).toBe(Routes.channelMessages("dm-1"));
    expect(options.body.allowed_mentions).toEqual({ parse: [] });
    expect(options.body.content).toBe("hi @everyone <@123>");
  });

  it("sendDirectMessage serializes button rows", async () => {
    const { discord, post } = client();
    const { buildReplyRow } = await import("../../src/discord/consoleConversation.js");
    await discord.sendDirectMessage("dm-1", { content: "x", components: [buildReplyRow(3)] });
    const [, options] = post.mock.calls[0] as unknown as [string, { body: { components: Array<{ components: Array<{ custom_id: string }> }> } }];
    expect(options.body.components[0]!.components[0]!.custom_id).toBe("console:reply:3");
  });

  it("listChannelMessages passes the cursor and returns messages oldest-first by snowflake (not string order)", async () => {
    const get = vi.fn(async () => [
      { id: "1000000000000000010", content: "b", author: { id: "u" } },
      { id: "999999999999999999", content: "a", author: { id: "u" } }, // shorter string, smaller number
      { id: "1000000000000000020", content: "c", author: { id: "u" } },
    ]);
    const { discord } = client({ get });
    const messages = await discord.listChannelMessages("dm-1", { after: "500" });
    expect(messages.map((m) => m.content)).toEqual(["a", "b", "c"]);
    const [route, options] = get.mock.calls[0] as unknown as [string, { query: URLSearchParams }];
    expect(route).toBe(Routes.channelMessages("dm-1"));
    expect(options.query.get("after")).toBe("500");
    expect(options.query.get("limit")).toBe("50");
  });

  it("listChannelMessages omits `after` when there's no cursor", async () => {
    const { discord, get } = client();
    await discord.listChannelMessages("dm-1", { after: null });
    const [, options] = get.mock.calls[0] as unknown as [string, { query: URLSearchParams }];
    expect(options.query.has("after")).toBe(false);
  });
});
