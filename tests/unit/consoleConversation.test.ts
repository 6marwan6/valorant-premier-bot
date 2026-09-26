import { describe, expect, it, vi } from "vitest";
import { ComponentType, InteractionResponseType, TextInputStyle } from "discord-api-types/v10";
import {
  buildReplyModal,
  buildReplyRow,
  deliverConversationReply,
  extractModalText,
  quoteForDm,
  startConsoleDm,
} from "../../src/discord/consoleConversation.js";
import type { AppContext } from "../../src/appContext.js";
import type { AiConversationRow } from "../../src/database/schema/aiConversations.js";
import { makeMatch, makePlayer } from "./helpers/aiFixtures.js";

function conversation(overrides: Partial<AiConversationRow> = {}): AiConversationRow {
  return {
    id: 9,
    guildId: "guild-1",
    playerId: 1,
    matchId: 42,
    mode: "CONSOLE",
    dmChannelId: "dm-1",
    lastSeenMessageId: "100",
    startedAt: new Date(),
    lastActivityAt: new Date(),
    endedAt: null,
    endReason: null,
    ...overrides,
  };
}

describe("buildReplyModal", () => {
  it("is a real Discord modal: one required paragraph input inside a Label (action rows in modals are deprecated), within Discord's limits", () => {
    const modal = buildReplyModal(12);
    expect(modal.type).toBe(InteractionResponseType.Modal);
    expect(modal.data.custom_id).toBe("console:modal:12");
    expect(modal.data.title.length).toBeLessThanOrEqual(45);
    const label = modal.data.components[0] as unknown as { type: number; label: string; component: Record<string, unknown> };
    expect(label.type).toBe(ComponentType.Label);
    expect(label.label.length).toBeLessThanOrEqual(45);
    const field = label.component;
    expect(field.type).toBe(ComponentType.TextInput);
    expect(field.style).toBe(TextInputStyle.Paragraph);
    expect(field.required).toBe(true);
    expect(field.custom_id).toBe("reply");
    expect(field.max_length as number).toBeLessThanOrEqual(4000);
  });
});

describe("extractModalText", () => {
  const submit = (components: unknown) => ({ data: { custom_id: "console:modal:1", components } }) as never;

  it("reads the Label-wrapped shape", () => {
    expect(extractModalText(submit([{ type: 18, component: { type: 4, custom_id: "reply", value: "hello" } }]))).toBe("hello");
  });

  it("still reads the deprecated action-row shape", () => {
    expect(extractModalText(submit([{ type: 1, components: [{ type: 4, custom_id: "reply", value: "hi there" }] }]))).toBe("hi there");
  });

  it("ignores other fields and returns '' when there's nothing", () => {
    expect(extractModalText(submit([{ type: 18, component: { type: 4, custom_id: "other", value: "x" } }]))).toBe("");
    expect(extractModalText(submit([]))).toBe("");
  });
});

describe("buildReplyRow", () => {
  it("is a single primary button whose id carries the conversation", () => {
    const json = buildReplyRow(5).toJSON() as { components: Array<{ custom_id: string; label: string }> };
    expect(json.components).toHaveLength(1);
    expect(json.components[0]!.custom_id).toBe("console:reply:5");
    expect(json.components[0]!.label).toBe("Reply");
  });
});

describe("quoteForDm", () => {
  it("quotes every line", () => {
    expect(quoteForDm("line one\nline two")).toBe("> line one\n> line two");
  });
});

function fakeCtx(sendImpl?: () => Promise<{ id: string }>, savedMessage: { id: number; memoryCandidate: { type: string; content: string } | null } | null = { id: 501, memoryCandidate: null }) {
  const sendDirectMessage = vi.fn(sendImpl ?? (async () => ({ id: "m-1" })));
  const editChannelMessage = vi.fn(async () => undefined);
  const recordAssistantMessage = vi.fn(async () => savedMessage);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const ctx = {
    logger,
    discord: { sendDirectMessage, editChannelMessage },
    services: { conversations: { recordAssistantMessage } },
  } as unknown as AppContext;
  return { ctx, sendDirectMessage, editChannelMessage, recordAssistantMessage, logger };
}

describe("deliverConversationReply", () => {
  const base = {
    kind: "reply" as const,
    conversation: conversation(),
    text: "That's valid 😭",
    continues: true,
    source: "ai" as const,
    memoryCandidate: null,
  };

  it("continuing: reply gets the Reply button + hint, and the player's own words are quoted above it (modal path)", async () => {
    const t = fakeCtx();
    const ok = await deliverConversationReply(t.ctx, {
      conversation: base.conversation,
      dmChannelId: "dm-1",
      outcome: base,
      echo: "I have an exam tomorrow.",
    });
    expect(ok).toBe(true);
    const [channel, payload] = t.sendDirectMessage.mock.calls[0] as unknown as [string, { content: string; components: unknown[] }];
    expect(channel).toBe("dm-1");
    expect(payload.content.startsWith("> I have an exam tomorrow.\n")).toBe(true);
    expect(payload.content).toContain("That's valid 😭");
    expect(payload.content).toContain("Tap **Reply**");
    expect(payload.components).toHaveLength(1);
    expect(t.recordAssistantMessage).toHaveBeenCalledWith(9, "That's valid 😭", null);
    expect(t.editChannelMessage).not.toHaveBeenCalled();
  });

  it("final message: no button, no hint, and the stored text is the model's text only (no quote/footer)", async () => {
    const t = fakeCtx();
    await deliverConversationReply(t.ctx, {
      conversation: base.conversation,
      dmChannelId: "dm-1",
      outcome: { ...base, continues: false },
    });
    const [, payload] = t.sendDirectMessage.mock.calls[0] as unknown as [string, { content: string; components: unknown[] }];
    expect(payload.components).toEqual([]);
    expect(payload.content).toBe("That's valid 😭");
    expect(t.recordAssistantMessage).toHaveBeenCalledWith(9, "That's valid 😭", null);
  });

  it("a wrap-up reply carrying a memory candidate (plan section 21) gets a follow-up edit adding Remember/Don't Remember buttons", async () => {
    const candidate = { type: "MATCH_EVENT" as const, content: "Ahmed had an exam." };
    const t = fakeCtx(undefined, { id: 501, memoryCandidate: candidate });
    const outcome = { ...base, continues: false, memoryCandidate: candidate };
    const ok = await deliverConversationReply(t.ctx, { conversation: base.conversation, dmChannelId: "dm-1", outcome });
    expect(ok).toBe(true);
    expect(t.recordAssistantMessage).toHaveBeenCalledWith(9, "That's valid 😭", candidate);
    expect(t.editChannelMessage).toHaveBeenCalledTimes(1);
    const [channel, messageId, payload] = t.editChannelMessage.mock.calls[0] as unknown as [
      string,
      string,
      { content: string; components: Array<{ toJSON: () => { components: Array<{ custom_id: string }> } }> },
    ];
    expect(channel).toBe("dm-1");
    expect(messageId).toBe("m-1");
    const buttonIds = payload.components[0]!.toJSON().components.map((c) => c.custom_id);
    expect(buttonIds).toEqual(["memory:remember:501", "memory:decline:501"]);
  });

  it("no candidate on the saved row: no edit call at all, even on a wrap-up turn", async () => {
    const t = fakeCtx(undefined, { id: 501, memoryCandidate: null });
    const outcome = { ...base, continues: false };
    await deliverConversationReply(t.ctx, { conversation: base.conversation, dmChannelId: "dm-1", outcome });
    expect(t.editChannelMessage).not.toHaveBeenCalled();
  });

  it("never exceeds Discord's 2000-character limit even with a long quote", async () => {
    const t = fakeCtx();
    await deliverConversationReply(t.ctx, {
      conversation: base.conversation,
      dmChannelId: "dm-1",
      outcome: { ...base, text: "y".repeat(1000) },
      echo: "x".repeat(5000),
    });
    const [, payload] = t.sendDirectMessage.mock.calls[0] as unknown as [string, { content: string }];
    expect(payload.content.length).toBeLessThanOrEqual(2000);
  });

  it("delivery failure: reports false, logs, and records nothing (the transcript never claims an undelivered message)", async () => {
    const t = fakeCtx(async () => {
      throw Object.assign(new Error("boom"), { code: 50007 });
    });
    const ok = await deliverConversationReply(t.ctx, { conversation: base.conversation, dmChannelId: "dm-1", outcome: base });
    expect(ok).toBe(false);
    expect(t.recordAssistantMessage).not.toHaveBeenCalled();
    expect(t.logger.error).toHaveBeenCalled();
  });

  it("a bookkeeping failure after a successful send still counts as delivered", async () => {
    const t = fakeCtx();
    t.recordAssistantMessage.mockRejectedValueOnce(new Error("db down"));
    const ok = await deliverConversationReply(t.ctx, { conversation: base.conversation, dmChannelId: "dm-1", outcome: base });
    expect(ok).toBe(true);
  });

  it("logs metadata only — never the message content (plan section 51)", async () => {
    const t = fakeCtx(async () => {
      throw new Error("boom");
    });
    await deliverConversationReply(t.ctx, {
      conversation: base.conversation,
      dmChannelId: "dm-1",
      outcome: { ...base, text: "SECRET-REPLY-TEXT" },
      echo: "SECRET-PLAYER-TEXT",
    });
    expect(JSON.stringify(t.logger.error.mock.calls)).not.toContain("SECRET");
  });
});

describe("startConsoleDm", () => {
  it("passes non-'started' outcomes straight through without touching Discord, and logs which one and why", async () => {
    for (const aiEnabled of [true, false]) {
      const createDmChannel = vi.fn();
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const ctx = {
        logger,
        discord: { createDmChannel },
        services: {
          ai: { enabled: aiEnabled },
          conversations: { startConsole: vi.fn(async () => ({ kind: "unavailable" as const })) },
        },
      } as unknown as AppContext;
      expect(await startConsoleDm(ctx, { player: makePlayer(), match: makeMatch() })).toBe("unavailable");
      expect(createDmChannel).not.toHaveBeenCalled();
      // Used to be completely silent either way — now says which of the
      // two very different reasons it was (plan design principle #8's own
      // "AI off" case vs. a player's individual setting).
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: "ai.conversation.unavailable", reason: aiEnabled ? "player_ai_followups_disabled" : "ai_disabled" }),
        expect.any(String),
      );
    }

    const createDmChannel2 = vi.fn();
    const logger2 = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const ctx2 = {
      logger: logger2,
      discord: { createDmChannel: createDmChannel2 },
      services: { ai: { enabled: true }, conversations: { startConsole: vi.fn(async () => ({ kind: "already_open" as const })) } },
    } as unknown as AppContext;
    expect(await startConsoleDm(ctx2, { player: makePlayer(), match: makeMatch() })).toBe("already_open");
    expect(createDmChannel2).not.toHaveBeenCalled();
    expect(logger2.info).toHaveBeenCalledWith(expect.objectContaining({ event: "ai.conversation.alreadyOpen" }), expect.any(String));
  });

  it("a bookkeeping failure after the DM went out is NOT reported as a DM failure", async () => {
    const abandon = vi.fn();
    const ctx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      discord: { createDmChannel: vi.fn(async () => ({ id: "dm-1" })), sendDirectMessage: vi.fn(async () => ({ id: "m-1" })) },
      services: {
        ai: { enabled: true },
        conversations: {
          startConsole: vi.fn(async () => ({ kind: "started", conversation: conversation(), openerText: "hi" })),
          recordOpener: vi.fn(async () => {
            throw new Error("db down");
          }),
          abandon,
        },
      },
    } as unknown as AppContext;
    expect(await startConsoleDm(ctx, { player: makePlayer(), match: makeMatch() })).toBe("started");
    expect(abandon).not.toHaveBeenCalled();
  });

  it("a closed-DM failure logs both the Discord error code AND HTTP status (plan section 51: metadata, not content)", async () => {
    const abandon = vi.fn();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const ctx = {
      logger,
      discord: {
        createDmChannel: vi.fn(async () => {
          throw Object.assign(new Error("Cannot send messages to this user"), { code: 50007, status: 403 });
        }),
      },
      services: {
        ai: { enabled: true },
        conversations: {
          startConsole: vi.fn(async () => ({ kind: "started", conversation: conversation(), openerText: "hi" })),
          abandon,
        },
      },
    } as unknown as AppContext;
    expect(await startConsoleDm(ctx, { player: makePlayer(), match: makeMatch() })).toBe("dm_failed");
    expect(abandon).toHaveBeenCalledWith(conversation().id, "DM_UNAVAILABLE");
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ code: 50007, status: 403 }), expect.any(String));
  });
});
