import type { AiConversationRepository } from "../../database/repositories/aiConversationRepository.js";
import type { MatchRepository } from "../../database/repositories/matchRepository.js";
import type { PlayerRepository } from "../../database/repositories/playerRepository.js";
import type {
  AiConversationEndReason,
  AiConversationRow,
  AiMessageRow,
} from "../../database/schema/aiConversations.js";
import type { MatchRow } from "../../database/schema/matches.js";
import type { PlayerRow } from "../../database/schema/players.js";
import type { AttendanceRow } from "../../database/schema/attendance.js";
import type { AiService } from "./aiService.js";
import type { MemoryCandidate } from "./aiOutput.js";
import { isChatMode, modeForStatus, type ChatMode } from "./aiMode.js";
import type { MemoryService } from "../memories/memoryService.js";
import {
  CONSOLE_STATIC_OPENER,
  CONVERSATION_FALLBACK_MESSAGE,
  MAX_PLAYER_TURNS,
  type ConversationTranscriptEntry,
  type SpokenReplyOptions,
} from "./conversationContextBuilder.js";

/** Nobody has replied for this long -> the conversation is over (Discord DMs stay open forever; the chat shouldn't). */
export const CONVERSATION_IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000;

/**
 * The free-form chats (2026-09-29) close after 5 hours without a message —
 * the player's own number. The next message opens a NEW chat, which starts
 * from the memory table only: the old transcript is never carried over
 * (plan section 29).
 */
export const CHAT_IDLE_TIMEOUT_MS = 5 * 60 * 60 * 1000;

/**
 * Backend cap on player messages in one free-form chat (plan section 37).
 * Far above CONSOLE's 5 — a real chat runs long — but still bounded. Hitting
 * it just closes this chat; the next message starts a fresh one.
 */
export const MAX_CHAT_PLAYER_TURNS = 40;

/** Sent when the model can't answer mid-chat. The chat stays open — one glitch doesn't end a conversation. */
export const CHAT_FALLBACK_MESSAGE = "My brain glitched for a second 😵 Say that again?";

/** Longest player message stored/sent to the model. The reply modal caps at 500; a burst of typed DMs is joined and capped here (plan section 57). */
export const MAX_PLAYER_MESSAGE_CHARS = 800;

/** Matches still worth consoling someone about (plan section 12). Once the match starts/ends/is cancelled the conversation has no point. */
const OPEN_MATCH_STATUSES: ReadonlyArray<MatchRow["status"]> = ["SCHEDULED", "CONFIRMATION_OPEN"];

export interface ConversationServiceOptions {
  idleTimeoutMs?: number;
  maxPlayerTurns?: number;
  /** Free-form chats only (2026-09-29). */
  chatIdleTimeoutMs?: number;
  maxChatPlayerTurns?: number;
}

export type StartOutcome =
  /** Conversation row exists; the transport must now deliver `openerText` and call `recordOpener` (or `abandon`). */
  | { kind: "started"; conversation: AiConversationRow; openerText: string }
  /** Not applicable right now (AI off, or this player turned "AI follow-ups" off) — the caller uses the Phase 6 single message instead. */
  | { kind: "unavailable" }
  /** This player already has an open conversation for this match; do nothing (plan section 50). */
  | { kind: "already_open" };

export type ReplyOutcome =
  | { kind: "not_found" }
  /** The sender isn't the conversation's player (plan section 44 rule 3). */
  | { kind: "forbidden" }
  /** Ended before/while handling this message; nothing was stored. `reason` is why. */
  | { kind: "ended"; reason: AiConversationEndReason | null }
  /** Already processed (retry / overlapping delivery path) — do nothing (plan section 50). */
  | { kind: "duplicate" }
  /** Empty after trimming (e.g. attachment-only DM) — nothing to answer. */
  | { kind: "ignored" }
  | {
      kind: "reply";
      conversation: AiConversationRow;
      text: string;
      /** True when the conversation stays open and the message should carry a Reply button. */
      continues: boolean;
      source: "ai" | "fallback";
      /**
       * Phase 8: non-null only when `!continues` (a candidate is only ever
       * proposed on a wrap-up turn — see aiService.ts's gate) — mutually
       * exclusive with the Reply button by construction, never both.
       */
      memoryCandidate: MemoryCandidate | null;
      /**
       * Free-form chats (2026-09-29): what this turn did to the player's memory
       * table, for logging and tests. Never shown to the player — memories are
       * saved silently and forgetting is confirmed by Mari's own reply text.
       */
      memoryEffects?: { saved: number; skipped: number; forgotten: number };
      /** True on the reply that hit the chat length cap: this chat is now closed and the next message opens a fresh one. */
      chatLimitReached?: boolean;
    };

/**
 * Plan section 59 Phase 7: conversation state + CONSOLE conversation flow.
 * Framework-agnostic on purpose (no Discord types — same split as
 * MatchService / AttendanceService): it decides *whether and what* to say
 * and keeps the database truthful; delivering DMs lives in
 * discord/consoleConversation.ts.
 *
 * Plan section 37 in practice: the model only ever *suggests* — its
 * `should_follow_up` is one input, but the backend independently enforces
 * the turn cap, idle timeout, match state and ownership, and it alone
 * writes conversation state. Assistant messages are recorded by the
 * transport only after Discord confirms delivery, so the stored transcript
 * never claims the player was told something they weren't.
 */
export class ConversationService {
  private readonly idleTimeoutMs: number;
  private readonly maxPlayerTurns: number;
  private readonly chatIdleTimeoutMs: number;
  private readonly maxChatPlayerTurns: number;

  constructor(
    private readonly conversations: AiConversationRepository,
    private readonly players: PlayerRepository,
    private readonly matches: MatchRepository,
    private readonly ai: AiService,
    options: ConversationServiceOptions = {},
    /** Optional so every pre-2026-09-29 call site keeps working: without it a chat still talks, it just neither remembers nor forgets. */
    private readonly memoryService: MemoryService | null = null,
  ) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? CONVERSATION_IDLE_TIMEOUT_MS;
    this.maxPlayerTurns = options.maxPlayerTurns ?? MAX_PLAYER_TURNS;
    this.chatIdleTimeoutMs = options.chatIdleTimeoutMs ?? CHAT_IDLE_TIMEOUT_MS;
    this.maxChatPlayerTurns = options.maxChatPlayerTurns ?? MAX_CHAT_PLAYER_TURNS;
  }

  /** True when the LLM layer is configured — without it there is nothing to converse with (plan design principle #8: behave exactly as before). */
  get enabled(): boolean {
    return this.ai.enabled;
  }

  /**
   * A player changed their attendance answer, so any open conversation
   * about a *different* answer no longer applies (a CONSOLE chat about
   * "wanted to play but can't" makes no sense once they say they're
   * playing). A conversation that already matches the new answer is left
   * alone — that's what makes a double-clicked button harmless instead of
   * one click ending the conversation the other just opened.
   */
  async endForAttendanceChange(playerId: number, matchId: number, newStatus: AttendanceRow["status"]): Promise<void> {
    await this.conversations.endOpenForPlayerMatch(playerId, matchId, "ATTENDANCE_CHANGED", modeForStatus(newStatus));
  }

  /**
   * Plan section 20 / 59: WANTS_TO_BUT_CANNOT -> open a private
   * conversation. Creates the row (idempotently) and produces the opening
   * message; the caller delivers it. The opener is the plan's own example
   * wording if the LLM is unavailable — the conversation itself doesn't
   * depend on the model being up just to *start*.
   */
  async startConsole(params: { player: PlayerRow; match: MatchRow }): Promise<StartOutcome> {
    const { player, match } = params;
    if (!this.ai.enabled || !player.aiFollowUpsEnabled) return { kind: "unavailable" };

    const { conversation, created } = await this.conversations.openOrGet({
      guildId: match.guildId,
      playerId: player.id,
      matchId: match.id,
      mode: "CONSOLE",
    });
    if (!created) return { kind: "already_open" };

    const generated = await this.ai.respondInConversation({
      player,
      match,
      conversationId: conversation.id,
      transcript: [],
      maxPlayerTurns: this.maxPlayerTurns,
    });
    const openerText = generated.source === "ai" ? generated.text : CONSOLE_STATIC_OPENER;
    return { kind: "started", conversation, openerText };
  }

  /**
   * The free-form chats (plan section 63's `/ai`; DM + server split
   * 2026-09-29): opens this player's one standing chat of this kind, or
   * returns the one already open. A chat that has been idle past the 5-hour
   * limit is closed first (`IDLE_TIMEOUT`) and a NEW one is opened — so the
   * player never has to "start over" by hand, and the new chat begins from
   * the memory table only (plan section 29).
   *
   * There is no AI-authored opener: the player's own message IS the first
   * turn, so the caller feeds it straight into `handlePlayerReply`. Gated on
   * `this.ai.enabled` only, deliberately NOT on `aiFollowUpsEnabled` (plan
   * section 9) — that setting means "let Mari keep prompting me
   * automatically" (CELEBRATE/ROAST/CONSOLE, all app-triggered); a player
   * *initiating* a chat themselves is a different thing it was never meant
   * to gate.
   */
  async openChat(params: { guildId: string; player: PlayerRow; mode: ChatMode; now?: Date }): Promise<
    { kind: "unavailable" } | { kind: "ready"; conversation: AiConversationRow; created: boolean; rolledOver: boolean }
  > {
    if (!this.ai.enabled) return { kind: "unavailable" };
    const now = params.now ?? new Date();

    let rolledOver = false;
    const current = await this.conversations.getOpenChat(params.guildId, params.player.id, params.mode);
    if (current && now.getTime() - current.lastActivityAt.getTime() > this.chatIdleTimeoutMs) {
      await this.conversations.end(current.id, "IDLE_TIMEOUT");
      rolledOver = true;
    }

    const { conversation, created } = await this.conversations.openOrGetChat({
      guildId: params.guildId,
      playerId: params.player.id,
      mode: params.mode,
    });
    return { kind: "ready", conversation, created, rolledOver };
  }

  /** The 2026-09-28 name, kept so existing callers and tests read as before. */
  async openDirectChat(params: { guildId: string; player: PlayerRow }) {
    return this.openChat({ ...params, mode: "DIRECT_CHAT" });
  }

  /**
   * A message typed into the bot's DM (gateway worker, 2026-09-29). Finds the
   * conversation it belongs to — a still-valid open CONSOLE or DM chat living
   * in this DM channel — or opens a fresh DM chat (which is also what happens
   * after the 5-hour idle close: "if the chatter DMs the bot after, it's a new
   * chat"). Then it is an ordinary turn.
   */
  async routeDmMessage(params: {
    guildId: string;
    player: PlayerRow;
    dmChannelId: string;
    /** The Discord message id — recorded as the poll cursor when this message opens a chat. */
    discordMessageId: string;
    text: string;
    now?: Date;
  }): Promise<{ kind: "unavailable" } | { kind: "routed"; conversation: AiConversationRow; outcome: ReplyOutcome }> {
    if (!this.ai.enabled) return { kind: "unavailable" };
    const now = params.now ?? new Date();

    let conversation = await this.conversations.findOpenInDm(params.player.id, params.dmChannelId);
    if (conversation) {
      const invalid = await this.endReasonIfInvalid(conversation, now, { player: params.player });
      if (invalid) {
        await this.conversations.end(conversation.id, invalid);
        conversation = undefined;
      }
    }

    if (!conversation) {
      const opened = await this.openChat({ guildId: params.guildId, player: params.player, mode: "DIRECT_CHAT", now });
      if (opened.kind === "unavailable") return { kind: "unavailable" };
      conversation = opened.conversation;
    }
    if (conversation.dmChannelId !== params.dmChannelId) {
      // A fresh chat: remember where it lives. The poll cursor starts at this very message (already being handled).
      await this.conversations.setDmChannel(conversation.id, params.dmChannelId, params.discordMessageId);
    }

    const outcome = await this.handlePlayerReply({
      conversationId: conversation.id,
      discordUserId: params.player.discordUserId,
      text: params.text,
      sourceRef: `message:${params.discordMessageId}`,
      now,
    });
    return { kind: "routed", conversation, outcome };
  }

  /**
   * The opening message reached the player's DM. Persists it and records
   * where the DM lives; the poll cursor starts at the opener itself, so the
   * poller only ever considers what the player wrote after it.
   */
  async recordOpener(params: {
    conversationId: number;
    text: string;
    dmChannelId: string;
    discordMessageId: string;
  }): Promise<void> {
    await this.conversations.addMessage({ conversationId: params.conversationId, role: "ASSISTANT", content: params.text });
    await this.conversations.setDmChannel(params.conversationId, params.dmChannelId, params.discordMessageId);
  }

  /**
   * A reply reached the player's DM. Deliberately does NOT move the poll
   * cursor: the player may have typed something while the model was
   * thinking, and jumping the cursor to our own (newer) message would skip
   * it. The poller advances the cursor itself, only past what it has read.
   *
   * `memoryCandidate` (Phase 8) rides on this same row — see
   * schema/aiConversations.ts's doc comment on why there's no separate
   * staging table. Returns the stored row (or null if the insert didn't
   * happen — see AiConversationRepository.addMessage) so the caller has the
   * row id `MemoryService.autoSave` needs.
   */
  /** Which of these `message:<id>` refs already have a stored player message (poller de-duplication against the gateway worker). */
  async storedMessageRefs(conversationId: number, refs: string[]): Promise<Set<string>> {
    return this.conversations.listStoredSourceRefs(conversationId, refs);
  }

  async recordAssistantMessage(
    conversationId: number,
    text: string,
    memoryCandidate?: MemoryCandidate | null,
  ): Promise<AiMessageRow | null> {
    const row = await this.conversations.addMessage({
      conversationId,
      role: "ASSISTANT",
      content: text,
      memoryCandidate: memoryCandidate ?? undefined,
    });
    await this.conversations.touch(conversationId);
    return row;
  }

  /** Poll bookkeeping: the poller has seen everything up to (and including) this Discord message id. */
  async advancePollCursor(conversationId: number, newestSeenMessageId: string): Promise<void> {
    await this.conversations.advanceCursor(conversationId, newestSeenMessageId);
  }

  /** Ends a conversation for a reason discovered outside a reply (idle/match sweep). */
  async end(conversationId: number, reason: AiConversationEndReason): Promise<void> {
    await this.conversations.end(conversationId, reason);
  }

  /** Every open conversation the poller should look at. */
  async listOpenForPolling(): Promise<AiConversationRow[]> {
    return this.conversations.listOpenWithDm();
  }

  /** The opener could not be delivered (DMs closed etc.). The conversation never really began. */
  async abandon(conversationId: number, reason: AiConversationEndReason): Promise<void> {
    await this.conversations.end(conversationId, reason);
  }

  /** Why this conversation should be over right now, or `null` if it's still valid. */
  async endReasonIfInvalid(
    conversation: AiConversationRow,
    now: Date,
    loaded?: { player?: PlayerRow; match?: MatchRow },
  ): Promise<AiConversationEndReason | null> {
    const chat = isChatMode(conversation.mode);
    const idleLimit = chat ? this.chatIdleTimeoutMs : this.idleTimeoutMs;
    if (now.getTime() - conversation.lastActivityAt.getTime() > idleLimit) return "IDLE_TIMEOUT";

    // DIRECT_CHAT (2026-09-28) has no match at all, so it has nothing to be
    // MATCH_CLOSED about — this check only ever applies to CONSOLE.
    if (conversation.matchId !== null) {
      const match = loaded?.match ?? (await this.matches.getById(conversation.matchId));
      if (!match || !OPEN_MATCH_STATUSES.includes(match.status)) return "MATCH_CLOSED";
    }

    const player = loaded?.player ?? (await this.players.getById(conversation.playerId));
    // Removed from the team: nothing to say to them anymore.
    if (!player || !player.active) return "COMPLETED";
    // "AI follow-ups" off (plan section 9) mid-conversation: respect it — but it
    // only governs Mari prompting the player. A chat the player started
    // themselves is not a "follow-up" (see `openChat`), so it is exempt.
    if (!chat && !player.aiFollowUpsEnabled) return "COMPLETED";

    return null;
  }

  /**
   * One player message -> (maybe) one reply. `sourceRef` identifies the
   * message (`interaction:<id>` / `message:<id>`) so the same message
   * delivered twice, or through both the Reply button and the poller, is
   * answered once (plan section 50).
   */
  async handlePlayerReply(params: {
    conversationId: number;
    /** Discord id of whoever sent it — must be the conversation's player. */
    discordUserId: string;
    text: string;
    sourceRef: string;
    /** Set when the reply will be spoken aloud (voice worker). */
    voice?: SpokenReplyOptions;
    now?: Date;
  }): Promise<ReplyOutcome> {
    const now = params.now ?? new Date();

    const conversation = await this.conversations.getById(params.conversationId);
    if (!conversation) return { kind: "not_found" };

    const player = await this.players.getById(conversation.playerId);
    if (!player || player.discordUserId !== params.discordUserId) return { kind: "forbidden" };

    if (conversation.endedAt) return { kind: "ended", reason: conversation.endReason };

    // DIRECT_CHAT (2026-09-28) has matchId === null; every other mode always has one.
    const match = conversation.matchId !== null ? await this.matches.getById(conversation.matchId) : null;
    const invalid = await this.endReasonIfInvalid(conversation, now, { player, match: match ?? undefined });
    if (invalid) {
      await this.conversations.end(conversation.id, invalid);
      return { kind: "ended", reason: invalid };
    }
    if (conversation.matchId !== null && !match) return { kind: "ended", reason: "MATCH_CLOSED" }; // unreachable after the check above; satisfies the type checker

    const content = params.text.trim().slice(0, MAX_PLAYER_MESSAGE_CHARS);
    if (content.length === 0) return { kind: "ignored" };

    // Storing the player's message *is* the claim on it: the unique
    // (conversation, source_ref) index means only one caller gets past here.
    const stored = await this.conversations.addMessage({
      conversationId: conversation.id,
      role: "USER",
      content,
      sourceRef: params.sourceRef,
    });
    if (!stored) return { kind: "duplicate" };
    await this.conversations.touch(conversation.id);

    const transcript = await this.loadTranscript(conversation.id);
    const playerTurns = transcript.filter((entry) => entry.role === "USER").length;

    if (isChatMode(conversation.mode)) {
      return this.replyInChat({ conversation, player, transcript, playerTurns, voice: params.voice });
    }

    const generated = await this.ai.respondInConversation({
      player,
      match: match ?? null,
      conversationId: conversation.id,
      transcript,
      maxPlayerTurns: this.maxPlayerTurns,
    });

    if (generated.source === "fallback") {
      // Plan section 48: a failure never breaks anything else; wrap up
      // gracefully rather than leaving the player in a half-broken chat.
      await this.conversations.end(conversation.id, "AI_FAILURE");
      return {
        kind: "reply",
        conversation,
        text: CONVERSATION_FALLBACK_MESSAGE,
        continues: false,
        source: "fallback",
        memoryCandidate: null,
      };
    }

    const atTurnLimit = playerTurns >= this.maxPlayerTurns;
    const continues = generated.shouldFollowUp && !atTurnLimit;
    if (!continues) {
      await this.conversations.end(conversation.id, atTurnLimit ? "TURN_LIMIT" : "COMPLETED");
    }
    return {
      kind: "reply",
      conversation,
      text: generated.text,
      continues,
      source: "ai",
      memoryCandidate: generated.memoryCandidate,
    };
  }

  /**
   * One turn of a free-form chat (DM or server — 2026-09-29). Differs from
   * the CONSOLE turn above in exactly the ways the plan revision lists:
   *
   * - the model does not decide when the chat is over — only the backend
   *   does (5 idle hours, checked on the next message; or the length cap);
   * - a failure mid-chat does not end the chat — the player just gets a
   *   "say that again" and the chat stays open;
   * - memory is saved silently on ANY turn, and a forget request is applied
   *   here, before the reply goes out, so Mari's "done, forgotten" is true
   *   by the time the player reads it (plan section 37: the backend performs
   *   the action, the model only suggested it).
   */
  private async replyInChat(params: {
    conversation: AiConversationRow;
    player: PlayerRow;
    transcript: ConversationTranscriptEntry[];
    playerTurns: number;
    voice?: SpokenReplyOptions;
  }): Promise<ReplyOutcome> {
    const { conversation, player, transcript, playerTurns } = params;
    const chatMode = conversation.mode as ChatMode;

    const generated = await this.ai.respondInConversation({
      player,
      match: null,
      chatMode,
      conversationId: conversation.id,
      transcript,
      voice: params.voice,
    });

    if (generated.source === "fallback") {
      return { kind: "reply", conversation, text: CHAT_FALLBACK_MESSAGE, continues: true, source: "fallback", memoryCandidate: null };
    }

    const effects = { saved: 0, skipped: 0, forgotten: 0 };
    let text = generated.text;

    if (this.memoryService) {
      // Forget first: a fact the player is retracting in this very message
      // must not be re-saved from the same turn's candidates.
      if (generated.forgetMemoryIds.length > 0) {
        try {
          const removed = await this.memoryService.forgetForPlayer({ playerId: player.id, memoryIds: generated.forgetMemoryIds });
          effects.forgotten = removed.length;
          if (removed.length === 0) text = `${text}\n\n(I couldn't find that in what I have stored, so nothing was removed — \`/memories\` shows everything.)`;
        } catch {
          text = "I couldn't forget that just now — try again, or remove it with `/memories`.";
        }
      }
      if (generated.memoryCandidates.length > 0 && effects.forgotten === 0) {
        try {
          const result = await this.memoryService.saveFromChat({
            playerId: player.id,
            conversationId: conversation.id,
            mode: chatMode,
            candidates: generated.memoryCandidates,
          });
          effects.saved = result.saved.length;
          effects.skipped = result.skipped;
        } catch {
          // Bookkeeping never stands between the player and their answer (plan section 48's spirit).
        }
      }
    }

    const atCap = playerTurns >= this.maxChatPlayerTurns;
    if (atCap) await this.conversations.end(conversation.id, "TURN_LIMIT");

    return {
      kind: "reply",
      conversation,
      text,
      continues: !atCap,
      source: "ai",
      memoryCandidate: null,
      memoryEffects: effects,
      chatLimitReached: atCap || undefined,
    };
  }

  private async loadTranscript(conversationId: number): Promise<ConversationTranscriptEntry[]> {
    const rows = await this.conversations.listMessages(conversationId);
    return rows
      .filter((row): row is typeof row & { role: "USER" | "ASSISTANT" } => row.role === "USER" || row.role === "ASSISTANT")
      .map((row) => ({ role: row.role, content: row.content }));
  }
}
