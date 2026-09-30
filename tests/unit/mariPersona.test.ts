import { describe, expect, it } from "vitest";
import { buildAIContext } from "../../src/modules/ai/aiContextBuilder.js";
import { buildDirectChatContext, buildServerChatContext, buildConversationContext } from "../../src/modules/ai/conversationContextBuilder.js";
import { buildMatchHypeContext } from "../../src/modules/ai/teamAiContextBuilder.js";
import { MARI_PERSONA, chatMentionsValorant, valorantSpotlight, lowestRoastIntensity } from "../../src/modules/ai/mariPersona.js";
import { makeMatch, makePlayer } from "./helpers/aiFixtures.js";

const user = (content: string) => ({ role: "USER" as const, content });

describe("Mari persona (2026-09-30)", () => {
  it("gives every Mari prompt the same voice block and drops the blanket 'no sexual content' rule", () => {
    const player = makePlayer();
    const systems = [
      buildAIContext({ player, mode: "ROAST", match: makeMatch() }).system,
      buildDirectChatContext({ player, transcript: [user("hey")] }).system,
      buildServerChatContext({ player, transcript: [user("hey")] }).system,
      buildConversationContext({ player, match: makeMatch(), transcript: [] }).system,
      buildMatchHypeContext({ match: makeMatch(), roster: [player] }).system,
    ];
    for (const system of systems) {
      expect(system).toContain("You are Mari, a gamer girl");
      expect(system).not.toContain("NEVER sexual content");
    }
  });

  it("keeps the hard spice limits in every prompt that allows spice", () => {
    const player = makePlayer();
    for (const system of [
      buildAIContext({ player, mode: "ROAST", match: makeMatch() }).system,
      buildDirectChatContext({ player, transcript: [user("hey")] }).system,
      buildServerChatContext({ player, transcript: [user("hey")] }).system,
      buildMatchHypeContext({ match: makeMatch(), roster: [player] }).system,
    ]) {
      expect(system).toContain("Never a graphic description");
      expect(system).toContain("never at a third person");
      expect(system).toContain("go completely clean");
      expect(system).toMatch(/NEVER (use )?slurs/);
    }
  });

  it("CONSOLE prompts carry the voice but no spice section", () => {
    const system = buildConversationContext({ player: makePlayer(), match: makeMatch(), transcript: [] }).system;
    expect(system).toContain("You are Mari, a gamer girl");
    expect(system).not.toContain("SPICE (flirty and dirty jokes)");
    expect(system).toContain("no flirty or sexual jokes at all");
  });

  it("spice level follows roast intensity in single-shot replies", () => {
    const at = (roastIntensity: number) =>
      buildAIContext({ player: makePlayer({ roastIntensity }), mode: "ROAST", match: makeMatch() }).user;
    expect(at(0)).toContain("Spice level for this message: 0 —");
    expect(at(25)).toContain("Spice level for this message: 1 —");
    expect(at(50)).toContain("Spice level for this message: 2 —");
    expect(at(75)).toContain("Spice level for this message: 3 —");
    expect(at(100)).toContain("Spice level for this message: 4 (max)");
  });

  it("CONSOLE never gets spice or a banter style, whatever the roast intensity", () => {
    const user_ = buildAIContext({
      player: makePlayer({ roastIntensity: 100, banterStyle: "FLIRTY" }),
      mode: "CONSOLE",
      match: makeMatch(),
    }).user;
    expect(user_).toContain("Spice level for this message: 0 —");
    expect(user_).toContain("Banter style: NEUTRAL");
    expect(user_).not.toContain("FLIRTY");
  });

  it("spice follows roast intensity in DM chat and public server chat too", () => {
    const player = makePlayer({ roastIntensity: 100, banterStyle: "ANNOYING" });
    for (const build of [buildDirectChatContext, buildServerChatContext]) {
      const ctx = build({ player, transcript: [user("hey")] });
      expect(ctx.user).toContain("Spice level for this message: 4 (max)");
      expect(ctx.user).toContain("Banter style: ANNOYING");
    }
  });

  it("a protected topic list is still passed through so a player can opt out of spice", () => {
    const ctx = buildDirectChatContext({
      player: makePlayer({ protectedTopics: ["flirting", "sex jokes"] }),
      transcript: [user("hey")],
    });
    expect(ctx.user).toContain("- flirting");
    expect(ctx.user).toContain("- sex jokes");
    expect(ctx.system).toContain("your spice level is 0");
  });

  it("team broadcasts use the mildest roast band on the roster", () => {
    const roster = [makePlayer({ id: 1, roastIntensity: 100 }), makePlayer({ id: 2, displayName: "Omar", roastIntensity: 20 })];
    const ctx = buildMatchHypeContext({ match: makeMatch(), roster });
    expect(ctx.user).toContain("Spice level for this message: 1 —");
    expect(ctx.user).not.toContain("4 (max)");
    expect(lowestRoastIntensity([80, 35, 100])).toBe(35);
    expect(lowestRoastIntensity([])).toBe(50);
  });
});

describe("Valorant details only when they fit", () => {
  it("single-shot: the role/agent lines only appear on some messages, and always when forced", () => {
    const player = makePlayer();
    const shown = Array.from({ length: 200 }, (_, i) =>
      buildAIContext({ player: makePlayer({ id: i + 1 }), mode: "CELEBRATE", match: makeMatch() }).user.includes("Role: DUELIST"),
    ).filter(Boolean).length;
    expect(shown).toBeGreaterThan(20);
    expect(shown).toBeLessThan(90);

    expect(buildAIContext({ player, mode: "CELEBRATE", match: makeMatch(), includeValorant: true }).user).toContain("Agents: Jett, Raze");
    expect(buildAIContext({ player, mode: "CELEBRATE", match: makeMatch(), includeValorant: false }).user).not.toContain("Role: DUELIST");
    expect(valorantSpotlight("1:42:CELEBRATE")).toBe(valorantSpotlight("1:42:CELEBRATE"));
  });

  it("single-shot: a player with Valorant references off never gets them, even when forced", () => {
    const ctx = buildAIContext({ player: makePlayer({ valorantReferencesEnabled: false }), mode: "ROAST", match: makeMatch(), includeValorant: true });
    expect(ctx.user).not.toContain("Role: DUELIST");
    expect(ctx.user).toContain("Valorant references: disabled");
  });

  it("chats: role/agents are withheld until the player talks about the game", () => {
    const player = makePlayer();
    const quiet = buildDirectChatContext({ player, transcript: [user("mari im so tired today")] });
    expect(quiet.user).not.toContain("Role: DUELIST");
    expect(quiet.user).not.toContain("Agents:");

    const gamey = buildDirectChatContext({ player, transcript: [user("i was maining jett last night")] });
    expect(gamey.user).toContain("Role: DUELIST");
    expect(gamey.user).toContain("Agents: Jett, Raze");
  });

  it("server chat: the roster's roles/agents are withheld too unless the chat is about the game", () => {
    const facts = {
      roster: [{ displayName: "Omar", role: "CONTROLLER" as const, agents: ["Omen"], preferredAgent: "Omen" }],
      nextMatch: null,
      lastMatch: null,
      sharedMemories: [],
      rosterForbiddenTopics: [],
    };
    const quiet = buildServerChatContext({ player: makePlayer(), transcript: [user("who is online")], facts });
    expect(quiet.user).toContain("- Omar");
    expect(quiet.user).not.toContain("Omen");

    const gamey = buildServerChatContext({ player: makePlayer(), transcript: [user("who plays controller on premier")], facts });
    expect(gamey.user).toContain("Omen");
  });

  it("chatMentionsValorant only looks at the last two player messages", () => {
    expect(chatMentionsValorant([user("valorant"), user("a"), user("b"), user("c")])).toBe(false);
    expect(chatMentionsValorant([user("a"), user("that clutch was insane")])).toBe(true);
    expect(chatMentionsValorant([user("lol razer keyboard")], ["Raze"])).toBe(false);
    expect(chatMentionsValorant([user("i miss playing raze")], ["Raze"])).toBe(true);
    expect(chatMentionsValorant([])).toBe(false);
  });
});

describe("Mari's stretched-out, self-loving voice (2026-09-30)", () => {
  it("the shared persona block carries the signature style and its guardrails", () => {
    expect(MARI_PERSONA).toContain("stretch words out");
    expect(MARI_PERSONA).toContain('"heyyyy"');
    expect(MARI_PERSONA).toContain("shamelessly in love with yourself");
    expect(MARI_PERSONA).toContain("never guilt-trip anyone");
    expect(MARI_PERSONA).toContain("turn the bubbly way down");
  });
});
