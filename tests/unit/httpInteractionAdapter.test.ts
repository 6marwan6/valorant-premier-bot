import { describe, expect, it } from "vitest";
import { ApplicationCommandOptionType } from "discord-api-types/v10";
import type { APIChatInputApplicationCommandInteraction } from "discord-api-types/v10";
import type { DiscordRestClient } from "../../src/discord/discordRest.js";
import { buildCommandInteractionAdapter } from "../../src/discord/httpInteractionAdapter.js";

/**
 * Phase 5 needs a way to read a User-type slash-command option targeting
 * someone OTHER than the invoker (/add-player, /edit-player,
 * /remove-player, /player) — unlike every option type the adapter already
 * supported (String/Integer/Channel/Role), a User option's raw `value` is
 * just an id; the actual name lives in `data.resolved`. These tests cover
 * that resolution path directly, without going through a full signed HTTP
 * request (see tests/integration/httpInteractionE2E.test.ts for that).
 */
function fakeRaw(overrides: {
  options?: unknown[];
  resolvedUsers?: Record<string, { username: string; global_name?: string | null }>;
  resolvedMembers?: Record<string, { nick?: string | null }>;
}): APIChatInputApplicationCommandInteraction {
  return {
    type: 2,
    id: "interaction-1",
    application_id: "app-1",
    token: "token-1",
    version: 1,
    guild_id: "guild-1",
    channel_id: "chan-1",
    member: {
      user: { id: "invoker-1", username: "Admin" },
      roles: [],
      permissions: "8",
    },
    data: {
      id: "cmd-1",
      name: "add-player",
      type: 1,
      options: overrides.options ?? [],
      resolved: {
        users: overrides.resolvedUsers,
        members: overrides.resolvedMembers,
      },
    },
  } as unknown as APIChatInputApplicationCommandInteraction;
}

const noopDiscord = {} as DiscordRestClient;

describe("buildCommandInteractionAdapter — getUser", () => {
  it("resolves a guild member's nickname first", () => {
    const raw = fakeRaw({
      options: [{ name: "player", type: ApplicationCommandOptionType.User, value: "target-1" }],
      resolvedUsers: { "target-1": { username: "ahmed_rl", global_name: "Ahmed" } },
      resolvedMembers: { "target-1": { nick: "Ahmed the Ace" } },
    });
    const adapter = buildCommandInteractionAdapter(raw, noopDiscord);
    expect(adapter.options.getUser("player", true)).toEqual({
      id: "target-1",
      username: "ahmed_rl",
      globalName: "Ahmed",
      displayName: "Ahmed the Ace",
    });
  });

  it("falls back to global display name when there's no server nickname", () => {
    const raw = fakeRaw({
      options: [{ name: "player", type: ApplicationCommandOptionType.User, value: "target-1" }],
      resolvedUsers: { "target-1": { username: "ahmed_rl", global_name: "Ahmed" } },
      resolvedMembers: { "target-1": {} },
    });
    const adapter = buildCommandInteractionAdapter(raw, noopDiscord);
    expect((adapter.options.getUser("player") as { displayName: string }).displayName).toBe("Ahmed");
  });

  it("falls back to username when there's no nickname or global name", () => {
    const raw = fakeRaw({
      options: [{ name: "player", type: ApplicationCommandOptionType.User, value: "target-1" }],
      resolvedUsers: { "target-1": { username: "ahmed_rl", global_name: null } },
    });
    const adapter = buildCommandInteractionAdapter(raw, noopDiscord);
    expect((adapter.options.getUser("player") as { displayName: string }).displayName).toBe("ahmed_rl");
  });

  it("returns null when the option is absent and not required", () => {
    const raw = fakeRaw({ options: [] });
    const adapter = buildCommandInteractionAdapter(raw, noopDiscord);
    expect(adapter.options.getUser("player")).toBeNull();
  });

  it("throws when a required option is missing", () => {
    const raw = fakeRaw({ options: [] });
    const adapter = buildCommandInteractionAdapter(raw, noopDiscord);
    expect(() => adapter.options.getUser("player", true)).toThrow();
  });
});

describe("buildCommandInteractionAdapter — getBoolean", () => {
  it("reads a boolean option's value, including explicit false", () => {
    const raw = fakeRaw({
      options: [{ name: "running_jokes", type: ApplicationCommandOptionType.Boolean, value: false }],
    });
    const adapter = buildCommandInteractionAdapter(raw, noopDiscord);
    expect(adapter.options.getBoolean("running_jokes")).toBe(false);
  });

  it("returns null when the boolean option wasn't passed", () => {
    const raw = fakeRaw({ options: [] });
    const adapter = buildCommandInteractionAdapter(raw, noopDiscord);
    expect(adapter.options.getBoolean("running_jokes")).toBeNull();
  });
});
