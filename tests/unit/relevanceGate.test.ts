import { describe, expect, it } from "vitest";
import {
  MAX_RETRIEVED_CHAT_MEMORIES,
  isRelevantTo,
  keywordOverlap,
  retrieveMemories,
  tokenize,
} from "../../src/modules/memories/memoryRetrieval.js";
import {
  chatMentionsMatch,
  chatMentionsMatchHistory,
  memorySpotlight,
  recentPlayerText,
} from "../../src/modules/ai/mariPersona.js";
import { MAX_SHARED_MEMORIES, TeamFactsService } from "../../src/modules/ai/teamFactsService.js";
import { makeMemory, makePlayer } from "./helpers/aiFixtures.js";

const user = (content: string) => ({ role: "USER" as const, content });
const mari = (content: string) => ({ role: "ASSISTANT" as const, content });

describe("relevance gate (2026-09-30): memories are used when the context leans toward them, not to fill a quota", () => {
  const exam = makeMemory({ type: "MATCH_EVENT", content: "Had an exam that stopped him playing a match.", importance: 30 });
  const ping = makeMemory({ type: "RUNNING_JOKE", content: "Blames ping after every death.", importance: 100, confidence: 1 });
  const jett = makeMemory({ type: "VALORANT_PREFERENCE", content: "Only ever plays Jett.", importance: 100, confidence: 1 });
  const all = [exam, ping, jett];

  it("a greeting or filler connects to nothing: no memories, however important they are", () => {
    for (const text of ["yo mari", "lol", "hey", "ok", ""]) {
      expect(retrieveMemories({ memories: all, mode: "DIRECT_CHAT", forbiddenTopics: [], queryText: text })).toEqual([]);
    }
  });

  it("an on-topic message brings in only the memory it connects to, even though others rank higher on importance", () => {
    const selected = retrieveMemories({ memories: all, mode: "DIRECT_CHAT", forbiddenTopics: [], queryText: "i have an exam tomorrow" });
    expect(selected).toEqual([exam]);
  });

  it("light stemming: exam / exams and blame / blames line up", () => {
    expect(isRelevantTo(exam.content, "my exams are killing me")).toBe(true);
    expect(tokenize("exams")).toEqual(tokenize("exam"));
  });

  it("words that appear in nearly every memory (game, play, valorant, team...) do not count as a connection", () => {
    expect(isRelevantTo("Plays a lot of Valorant with the team.", "wanna play some valorant with the team tonight")).toBe(false);
    expect(keywordOverlap("Only ever plays Jett.", "let's play a game")).toBe(0);
  });

  it("the ceiling still applies to the memories that do connect", () => {
    const many = Array.from({ length: MAX_RETRIEVED_CHAT_MEMORIES + 4 }, (_, i) => makeMemory({ content: `Streams on twitch, fact ${i}.` }));
    const selected = retrieveMemories({ memories: many, mode: "DIRECT_CHAT", forbiddenTopics: [], queryText: "are you still streaming on twitch" });
    expect(selected).toHaveLength(MAX_RETRIEVED_CHAT_MEMORIES);
  });

  it("privacy filtering still runs first: a relevant PROTECTED or forbidden-topic memory is never returned", () => {
    const protectedMemory = makeMemory({ visibility: "PROTECTED", content: "Exam on Sunday." });
    const forbidden = makeMemory({ content: "Exam stress from university." });
    const selected = retrieveMemories({
      memories: [protectedMemory, forbidden],
      mode: "DIRECT_CHAT",
      forbiddenTopics: ["university"],
      queryText: "exam tomorrow",
    });
    expect(selected).toEqual([]);
  });

  it("without query text (button reactions) ranking is unchanged: nothing is gated", () => {
    expect(retrieveMemories({ memories: all, mode: "DIRECT_CHAT", forbiddenTopics: [], limit: 5 })).toHaveLength(3);
  });
});

describe("memorySpotlight (button reactions have no message to judge relevance against)", () => {
  it("is deterministic per seed and lands on roughly one reaction in three", () => {
    expect(memorySpotlight("1:42:ROAST")).toBe(memorySpotlight("1:42:ROAST"));
    let hits = 0;
    for (let i = 0; i < 600; i++) if (memorySpotlight(`${i}:42:ROAST`)) hits++;
    expect(hits).toBeGreaterThan(140);
    expect(hits).toBeLessThan(260);
  });
});

describe("chat topic detectors", () => {
  it("next-match block: schedule and lineup talk, not generic chatter and not 'last match' talk", () => {
    expect(chatMentionsMatch([user("who's playing tonight?")])).toBe(true);
    expect(chatMentionsMatch([user("what time is kickoff")])).toBe(true);
    expect(chatMentionsMatch([user("can't make it to the match")])).toBe(true);
    expect(chatMentionsMatch([user("i can't make tomorrow")])).toBe(true);
    expect(chatMentionsMatch([user("this song is so good")])).toBe(false);
    expect(chatMentionsMatch([user("how did the last match go?")])).toBe(false);
  });

  it("last-match block: results and history talk", () => {
    expect(chatMentionsMatchHistory([user("how did the last match go?")])).toBe(true);
    expect(chatMentionsMatchHistory([user("did we win?")])).toBe(true);
    expect(chatMentionsMatchHistory([user("gg on that clutch")])).toBe(true);
    expect(chatMentionsMatchHistory([user("who's playing tonight?")])).toBe(false);
  });

  it("context is the last two player messages, so a short follow-up still leans on the one before it", () => {
    const transcript = [user("old topic"), mari("..."), user("who's playing tonight?"), mari("omar"), user("and ali?")];
    expect(recentPlayerText(transcript)).toBe("who's playing tonight? and ali?");
    expect(chatMentionsMatch(transcript)).toBe(true);
    // ...but an older message stops counting once two newer ones follow it.
    expect(chatMentionsMatch([user("who's playing tonight?"), user("lol"), user("anyway")])).toBe(false);
  });
});

describe("TeamFactsService: teammates' shared memories ride along only when the conversation leans toward them", () => {
  const chatter = makePlayer({ id: 1, displayName: "Ahmed", discordUserId: "u1", protectedTopics: [] });
  const omar = makePlayer({ id: 2, displayName: "Omar", discordUserId: "u2", protectedTopics: [] });
  const ali = makePlayer({ id: 3, displayName: "Ali", discordUserId: "u3", protectedTopics: [] });
  const memories = [
    makeMemory({ playerId: 2, visibility: "TEAM", type: "RUNNING_JOKE", content: "Says he is him after every kill." }),
    makeMemory({ playerId: 3, visibility: "TEAM", type: "HABIT", content: "Streams on twitch on weekends." }),
  ];

  const service = new TeamFactsService(
    { listActiveByGuild: async () => [chatter, omar, ali] } as never,
    { listByGuildAndStatuses: async () => [] } as never,
    { listByMatch: async () => [] } as never,
    { listByMatch: async () => [] } as never,
    { listSharedForPlayers: async () => memories } as never,
  );

  const load = async (queryText: string) =>
    (await service.load({ guildId: "guild-1", chatterPlayerId: 1, queryText })).sharedMemories.map((m) => `${m.ownerName}: ${m.content}`);

  it("nothing on-topic (or no text at all) means no teammate memories", async () => {
    expect(await load("what should i eat")).toEqual([]);
    expect(await load("")).toEqual([]);
  });

  it("a shared meaningful word brings in that memory only", async () => {
    expect(await load("is anyone streaming on twitch tonight")).toEqual(["Ali: Streams on twitch on weekends."]);
  });

  it("naming the teammate brings in their memories (whole word, case-insensitive)", async () => {
    expect(await load("what's OMAR like")).toEqual(["Omar: Says he is him after every kill."]);
    // "ali" inside another word is not a mention of Ali
    expect(await load("that is pure reality")).toEqual([]);
  });

  it("never exceeds the shared-memory ceiling", () => {
    expect(MAX_SHARED_MEMORIES).toBeLessThanOrEqual(2);
  });
});
