import { describe, expect, it, vi } from "vitest";
import { isPremierPlayer } from "../../src/database/schema/players.js";
import { TeamFactsService } from "../../src/modules/ai/teamFactsService.js";
import { buildAIContext } from "../../src/modules/ai/aiContextBuilder.js";
import { buildConversationContext } from "../../src/modules/ai/conversationContextBuilder.js";
import { runServerChatTurn } from "../../src/discord/serverChat.js";
import type { AppContext } from "../../src/appContext.js";
import { buildDeclineEvent, buildVoteEvent } from "../../src/modules/schedules/scheduleAiEvent.js";
import { makeMatch, makeMemory, makePlayer } from "./helpers/aiFixtures.js";

const member = (over: Parameters<typeof makePlayer>[0] = {}) =>
  makePlayer({ id: 9, discordUserId: "m1", displayName: "Sara", kind: "MEMBER", role: null, agents: [], preferredAgent: null, protectedTopics: ["Exams"], ...over });

describe("server members vs Premier players", () => {
  it("isPremierPlayer is true only for kind PLAYER", () => {
    expect(isPremierPlayer(makePlayer())).toBe(true);
    expect(isPremierPlayer(member())).toBe(false);
  });
});

describe("TeamFactsService — the roster is Premier-only, privacy covers everyone", () => {
  const ahmed = makePlayer({ id: 1, discordUserId: "u1", displayName: "Ahmed", protectedTopics: ["Family"] });
  const sara = member();
  const memories = [makeMemory({ playerId: 9, visibility: "TEAM", type: "HABIT", content: "Streams on twitch on weekends." })];
  const listSharedForPlayers = vi.fn(async (_ids: number[]) => memories);

  const service = new TeamFactsService(
    { listActiveByGuild: async () => [ahmed, sara] } as never,
    { listByGuildAndStatuses: async () => [] } as never,
    { listByMatch: async () => [] } as never,
    { listByMatch: async () => [] } as never,
    { listSharedForPlayers } as never,
  );

  it("lists only Premier players on the roster", async () => {
    const facts = await service.load({ guildId: "guild-1", chatterPlayerId: 1 });
    expect(facts.roster.map((r) => r.displayName)).toEqual(["Ahmed"]);
  });

  it("a public reply must respect a member's protected topics too", async () => {
    const facts = await service.load({ guildId: "guild-1", chatterPlayerId: 1 });
    expect(facts.rosterForbiddenTopics).toEqual(expect.arrayContaining(["Family", "Exams"]));
  });

  it("a member's shared (TEAM) memories can come up in chat, like a player's", async () => {
    const facts = await service.load({ guildId: "guild-1", chatterPlayerId: 1, queryText: "is anyone streaming on twitch tonight" });
    expect(facts.sharedMemories.map((m) => m.ownerName)).toEqual(["Sara"]);
    expect(listSharedForPlayers).toHaveBeenCalledWith(expect.arrayContaining([9]));
  });
});

describe("prompts for a member", () => {
  it("the chat prompt says they are not on the Premier team and shows no role/agent background", () => {
    const { user } = buildConversationContext({
      player: member({ valorantReferencesEnabled: true }),
      match: makeMatch(),
      transcript: [{ role: "USER", content: "what agents should i play in valorant" }],
    } as never);
    expect(user).toContain("Server member: NOT on the Premier team");
    expect(user).not.toContain("Role:");
    expect(user).not.toContain("null");
  });

  it("the single-shot prompt does the same", () => {
    const ctx = buildAIContext({ player: member(), mode: "CELEBRATE", match: makeMatch() });
    expect(ctx.user).toContain("Server member: NOT on the Premier team");
    expect(ctx.user).not.toContain("Role:");
  });

  it("a Premier player's prompt is unchanged (role shown when the Valorant dice say so)", () => {
    const ctx = buildAIContext({ player: makePlayer(), mode: "CELEBRATE", match: makeMatch(), includeValorant: true });
    expect(ctx.user).toContain("Role: DUELIST");
    expect(ctx.user).not.toContain("Server member");
  });
});

describe("a member can chat with Mari (server chat is not Premier-gated)", () => {
  function chatCtx() {
    const conversations = {
      openChat: vi.fn(async () => ({ kind: "ready", conversation: { id: 5 }, created: true, rolledOver: false })),
      handlePlayerReply: vi.fn(async () => ({ kind: "reply", text: "hey Sara", chatLimitReached: false })),
      recordAssistantMessage: vi.fn(async () => undefined),
    };
    return { ctx: { services: { conversations }, logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } } as unknown as AppContext, conversations };
  }

  it("replies to a member", async () => {
    const { ctx, conversations } = chatCtx();
    const deliver = vi.fn(async () => undefined);
    const result = await runServerChatTurn(ctx, { guildId: "guild-1", player: member(), text: "hi", sourceRef: "message:1", deliver });
    expect(result).toEqual({ kind: "replied", text: "hey Sara" });
    expect(deliver).toHaveBeenCalledWith("hey Sara");
    expect(conversations.openChat).toHaveBeenCalled();
  });

  it("still refuses someone with no profile at all, and a removed member", async () => {
    const { ctx } = chatCtx();
    const deliver = vi.fn();
    expect(await runServerChatTurn(ctx, { guildId: "g", player: undefined, text: "hi", sourceRef: "m:1", deliver })).toEqual({ kind: "not_a_player" });
    expect(await runServerChatTurn(ctx, { guildId: "g", player: member({ active: false }), text: "hi", sourceRef: "m:2", deliver })).toEqual({ kind: "not_a_player" });
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe("schedule AI events — sparse, database-only facts", () => {
  const slot = { id: 3, pollId: 1, position: 1, scheduledAt: new Date("2026-10-10T16:00:00Z"), queueAt: null, remindMode: "AUTO", map: null, quorumAnnouncedAt: null, createdAt: new Date() } as const;

  it("a vote names only the slot voted for", () => {
    const e = buildVoteEvent({ pollId: 1, slot: { ...slot }, timezone: "Africa/Cairo" });
    expect(e.lines.join("\n")).toContain("CAN play SAT 10/10 at 19:00 (Africa/Cairo)");
    expect(e.lines.join("\n")).toContain("Player response: PLAYING");
    // No counts, no other voters, no squad status — those change by the minute and the model would quote them.
    expect(e.lines.join("\n")).not.toMatch(/\d+ of \d+|squad|needs? \d|so far/i);
    expect(e.seedKey).toBe("sched:1:vote");
  });

  it("a decline says they can't play any day, with the slot count", () => {
    expect(buildDeclineEvent({ pollId: 2, slotCount: 3 }).lines.join("\n")).toContain("CAN'T play on any of the 3 slots");
    expect(buildDeclineEvent({ pollId: 2, slotCount: 1 }).lines.join("\n")).toContain("1 slot offered");
  });

  it("buildAIContext renders the event instead of a match, and ROAST/CELEBRATE rules still apply", () => {
    const ctx = buildAIContext({ player: makePlayer(), mode: "ROAST", event: buildDeclineEvent({ pollId: 2, slotCount: 2 }) });
    expect(ctx.user).toContain("CURRENT EVENT");
    expect(ctx.user).toContain("CAN'T play on any of the 2 slots");
    expect(ctx.user).not.toContain("Kickoff:");
    expect(ctx.user).toContain("FORBIDDEN TOPICS");
    expect(ctx.system).toContain("ROAST");
  });

  it("buildAIContext refuses to run with neither a match nor an event", () => {
    expect(() => buildAIContext({ player: makePlayer(), mode: "CELEBRATE" })).toThrow();
  });
});
