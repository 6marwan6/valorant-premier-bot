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
import { modeForStatus } from "./aiMode.js";
import {
  CONSOLE_STATIC_OPENER,
  CONVERSATION_FALLBACK_MESSAGE,
  MAX_PLAYER_TURNS,
  type ConversationTranscriptEntry,
} from "./conversationContextBuilder.js";

/** Nobody has replied for this long -> the conversation is over (Discord DMs stay open forever; the chat shouldn't). */
export const CONVERSATION_IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000;

/** Longest player message stored/sent to the model. The reply modal caps at 500; a burst of typed DMs is joined and capped here (plan section 57). */
export const MAX_PLAYER_MESSAGE_CHARS = 800;

/** Matches still worth consoling someone about (plan section 12). Once the match starts/ends/is cancelled the conversation has no point. */
const OPEN_MATCH_STATUSES: ReadonlyArray<MatchRow["status"]> = ["SCHEDULED", "CONFIRMATION_OPEN"];

export interface ConversationServiceOptions {
  idleTimeoutMs?: number;
  maxPlayerTurns?: number;
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

  constructor(
    private readonly conversations: AiConversationRepository,
    private readonly players: PlayerRepository,
    private readonly matches: MatchRepository,
    private readonly ai: AiService,
    options: ConversationServiceOptions = {},
  ) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? CONVERSATION_IDLE_TIMEOUT_MS;
    this.maxPlayerTurns = options.maxPlayerTurns ?? MAX_PLAYER_TURNS;
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
   * row id a Remember/Don't Remember button needs.
   */
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
    if (now.getTime() - conversation.lastActivityAt.getTime() > this.idleTimeoutMs) return "IDLE_TIMEOUT";

    const match = loaded?.match ?? (await this.matches.getById(conversation.matchId));
    if (!match || !OPEN_MATCH_STATUSES.includes(match.status)) return "MATCH_CLOSED";

    const player = loaded?.player ?? (await this.players.getById(conversation.playerId));
    // Removed from the team, or turned "AI follow-ups" off (plan section 9) mid-conversation: respect it.
    if (!player || !player.active || !player.aiFollowUpsEnabled) return "COMPLETED";

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
    now?: Date;
  }): Promise<ReplyOutcome> {
    const now = params.now ?? new Date();

    const conversation = await this.conversations.getById(params.conversationId);
    if (!conversation) return { kind: "not_found" };

    const player = await this.players.getById(conversation.playerId);
    if (!player || player.discordUserId !== params.discordUserId) return { kind: "forbidden" };

    if (conversation.endedAt) return { kind: "ended", reason: conversation.endReason };

    const match = await this.matches.getById(conversation.matchId);
    const invalid = await this.endReasonIfInvalid(conversation, now, { player, match });
    if (invalid) {
      await this.conversations.end(conversation.id, invalid);
      return { kind: "ended", reason: invalid };
    }
    if (!match) return { kind: "ended", reason: "MATCH_CLOSED" }; // unreachable after the check above; satisfies the type checker

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

    const generated = await this.ai.respondInConversation({
      player,
      match,
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

  private async loadTranscript(conversationId: number): Promise<ConversationTranscriptEntry[]> {
    const rows = await this.conversations.listMessages(conversationId);
    return rows
      .filter((row): row is typeof row & { role: "USER" | "ASSISTANT" } => row.role === "USER" || row.role === "ASSISTANT")
      .map((row) => ({ role: row.role, content: row.content }));
  }
}
