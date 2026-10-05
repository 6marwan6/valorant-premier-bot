import type { ButtonInteraction } from "discord.js";
import type { AppContext } from "../../appContext.js";
import { parseAttendanceCustomId } from "../../modules/attendance/customId.js";
import { buildRosterMessage } from "../../modules/attendance/rosterMessage.js";
import { buildFullSquadCard, buildReactionCard } from "../../modules/attendance/reactionCard.js";
import { resolveDisplayName } from "../displayName.js";
import { startConsoleDm } from "../consoleConversation.js";
import { isMemoryDeleteCustomId } from "../../modules/memories/memoryManageCustomId.js";
import { handleMemoryDeleteButton } from "../memoryDelete.js";
import { isScheduleCustomId } from "../../modules/schedules/scheduleCustomId.js";
import { dispatchScheduleButton } from "./dispatchScheduleButton.js";
import { isAgentCustomId } from "../../modules/agents/agentCustomId.js";
import { dispatchAgentButton } from "./dispatchAgentPick.js";
import { avatarUrlOf } from "../avatarUrl.js";
import type { MatchRow } from "../../database/schema/matches.js";
import type { PlayerRow } from "../../database/schema/players.js";
import type { AttendanceRow } from "../../database/schema/attendance.js";
import type { MentionCard } from "../discordRest.js";

/**
 * Plan section 15 step 6 / section 17: "Start the corresponding AI flow".
 *
 * - CELEBRATE (PLAYING) / ROAST (CANNOT_PLAY) (plan sections 18/19): one
 *   PUBLIC @mention of the player in the match channel (a product decision
 *   made after Phase 6 — the team-visible banter is the point). The public
 *   post is best-effort: if Discord rejects it, the same text goes to the
 *   player privately (ephemeral) instead, so they still get a reply.
 * - CONSOLE (WANTS_TO_BUT_CANNOT, plan sections 20/61) — Phase 7: a real
 *   private conversation in the player's Discord DMs. Publicly the channel
 *   only ever sees one fixed line ("can't make it this time 🟡", no AI text,
 *   no reason — nothing personal); the click itself gets a short ephemeral
 *   pointer to the DM. If the conversation can't happen (the
 *   player turned "AI follow-ups" off — plan section 9 — or their DMs are
 *   closed to the bot) it falls back to Phase 6's single ephemeral message,
 *   so the player always gets *something* truthful.
 *
 * Any change of answer also ends an open conversation about the previous
 * one (a "wanted to but can't" chat is meaningless once they say they're
 * playing).
 *
 * Runs strictly AFTER the attendance write and public roster update have
 * succeeded, and is fully isolated: nothing in here can turn a recorded
 * response into a "something went wrong" message (plan sections 48 and 66
 * #8). Skipped when the AI isn't configured, when the click didn't change
 * anything (idempotency, section 50), or when the clicker has no active
 * player profile.
 */
/**
 * Best-effort public @mention (see sendAiFollowUp's doc). Never throws: a
 * failed public post must not abort the rest of the reaction — for WANTS it
 * would otherwise skip the DM pointer *after* the DM was already opened, and
 * for CELEBRATE/ROAST it would leave the player with no reply at all
 * (plan sections 48 and 66 #8).
 */
async function tryPostMention(
  ctx: AppContext,
  params: { channelId: string; text: string; userId: string; matchId: number; kind: string; card?: MentionCard },
): Promise<boolean> {
  try {
    await ctx.discord.sendMentionMessage(params.channelId, params.text, params.userId, params.card);
    return true;
  } catch (err) {
    ctx.logger.warn(
      { event: "ai.followup.publicPostFailed", kind: params.kind, matchId: params.matchId, err: err instanceof Error ? err.message : String(err) },
      "Public @mention failed",
    );
    return false;
  }
}

/**
 * The deterministic "everyone's in" moment: posted once, when THIS click is
 * the one that makes every active player PLAYING. A repeated click
 * (changed=false) never re-fires it, it needs no LLM, and a Discord failure
 * is swallowed — attendance is already recorded (plan sections 48, 66 #8).
 */
async function maybePostFullSquad(
  ctx: AppContext,
  params: { match: MatchRow; status: AttendanceRow["status"]; changed: boolean; attendanceRows: AttendanceRow[]; roster: PlayerRow[] },
): Promise<void> {
  const channelId = params.match.announcementChannelId;
  if (!channelId || !params.changed || params.status !== "PLAYING" || params.roster.length === 0) return;
  const playingIds = new Set(params.attendanceRows.filter((r) => r.status === "PLAYING").map((r) => r.discordUserId));
  if (!params.roster.every((p) => playingIds.has(p.discordUserId))) return;
  try {
    const card = buildFullSquadCard(params.match, params.roster, Math.floor(params.match.scheduledAt.getTime() / 1000));
    await ctx.discord.sendChannelMessage(channelId, { embeds: card.embeds });
  } catch (err) {
    ctx.logger.warn(
      { event: "attendance.fullSquadPostFailed", matchId: params.match.id, err: err instanceof Error ? err.message : String(err) },
      "Full-squad celebration failed (attendance is still recorded)",
    );
  }
}

async function sendAiFollowUp(
  interaction: ButtonInteraction,
  ctx: AppContext,
  params: { match: MatchRow; status: AttendanceRow["status"]; changed: boolean; roster: PlayerRow[]; attendanceRows: AttendanceRow[] },
): Promise<void> {
  if (!params.changed || !ctx.services.ai.enabled) return;
  const player = params.roster.find((p) => p.discordUserId === interaction.user.id);
  if (!player) return;
  const channelId = params.match.announcementChannelId;
  const cardFor = (text: string): MentionCard =>
    buildReactionCard({
      player,
      match: params.match,
      status: params.status,
      text,
      attendanceRows: params.attendanceRows,
      rosterSize: params.roster.length,
      avatarUrl: avatarUrlOf(interaction),
    });

  try {
    await ctx.services.conversations.endForAttendanceChange(player.id, params.match.id, params.status);

    let dmFailed = false;
    if (params.status === "WANTS_TO_BUT_CANNOT") {
      const started = await startConsoleDm(ctx, { player, match: params.match });
      if (started === "already_open") return;
      if (channelId) {
        const text = "can't make it this time 🟡";
        await tryPostMention(ctx, { channelId, text, userId: player.discordUserId, matchId: params.match.id, kind: "wants_note", card: cardFor(text) });
      }
      if (started === "started") {
        await interaction.followUp({ content: "📩 I sent you a DM, let's talk there.", ephemeral: true });
        return;
      }
      dmFailed = started === "dm_failed";
      // "unavailable" / "dm_failed": fall through to the single message.
    }

    const outcome = await ctx.services.ai.respondToAttendance({
      player,
      match: params.match,
      status: params.status,
    });

    if (params.status !== "WANTS_TO_BUT_CANNOT" && outcome.source === "ai" && channelId) {
      const posted = await tryPostMention(ctx, { channelId, text: outcome.text, userId: player.discordUserId, matchId: params.match.id, kind: "reaction", card: cardFor(outcome.text) });
      if (posted) return;
      // Public post failed: fall through to the private message below.
    }

    const note = dmFailed
      ? "\n\n_(I tried to DM you but couldn't — allow DMs from server members if you'd like to chat.)_"
      : "";
    await interaction.followUp({ content: `${outcome.text}${note}`, ephemeral: true });
  } catch (err) {
    ctx.logger.error(
      {
        event: "ai.followup.failed",
        matchId: params.match.id,
        playerId: player.id,
        err: err instanceof Error ? err.message : String(err),
      },
      "Failed to deliver AI followup",
    );
  }
}

/**
 * Routes a button click. Three kinds exist: weekly-schedule votes (`sched:...`, handled by dispatchScheduleButton.ts); attendance buttons (custom_id
 * `attendance:<matchId>:<status>`, plan section 15); and the memory
 * `/memories`-and-Forget-note delete buttons (`memory:del:<id>`, plan
 * sections 42/43 — since the section 21 revision, this is the only memory
 * button there is; memories save automatically, see consoleConversation.ts
 * and memoryService.ts). Memory deletes route to discord/memoryDelete.ts
 * before the attendance-specific guild check below, since it runs in
 * contexts an attendance click never does (a DM, or an ephemeral command
 * reply) and never touches attendance or match state at all. Anything else
 * is logged and ignored rather than crashing, the same fail-safe posture
 * as dispatchCommand's "unknown command" branch.
 */
export async function dispatchButton(interaction: ButtonInteraction, ctx: AppContext): Promise<void> {
  if (isMemoryDeleteCustomId(interaction.customId)) {
    await handleMemoryDeleteButton(interaction, ctx);
    return;
  }

  // Agent-pick panel (2026-10-04): `agent:<slotId>:...` — see dispatchAgentPick.ts.
  if (isAgentCustomId(interaction.customId)) {
    await dispatchAgentButton(interaction, ctx);
    return;
  }

  // Weekly schedule votes (2026-10-03): `sched:<pollId>:...` — see dispatchScheduleButton.ts.
  if (isScheduleCustomId(interaction.customId)) {
    await dispatchScheduleButton(interaction, ctx);
    return;
  }

  const parsed = parseAttendanceCustomId(interaction.customId);
  if (!parsed) {
    ctx.logger.warn(
      { event: "button.unrecognized", customId: interaction.customId },
      "Received an unrecognized button interaction",
    );
    if (interaction.isRepliable()) {
      await interaction.reply({ content: "This button isn't recognized anymore.", ephemeral: true });
    }
    return;
  }

  const guildId = interaction.guildId;
  if (!guildId) {
    // Component interactions on a guild message are always guild-scoped in
    // practice, but the type is nullable — handled explicitly rather than
    // asserted away.
    await interaction.reply({ content: "This can only be used in a server.", ephemeral: true });
    return;
  }

  const startedAt = Date.now();
  try {
    // Match attendance is a Premier thing (2026-10-03): a server member who taps a button gets a clear private answer, nothing is recorded.
    const clicker = await ctx.repositories.players.getByDiscordUserId(guildId, interaction.user.id);
    if (clicker?.active && clicker.kind === "MEMBER") {
      await interaction.reply({ content: "❌ Match attendance is for Premier players only — you're registered as a server member.", ephemeral: true });
      return;
    }

    const result = await ctx.services.attendance.recordAttendance({
      guildId,
      matchId: parsed.matchId,
      discordUserId: interaction.user.id,
      discordDisplayName: resolveDisplayName(interaction),
      status: parsed.status,
    });

    if (!result.ok) {
      // Plan section 15 step 3: "Verify that the match is accepting
      // responses." A rejection here means the match state changed since
      // the message was posted (cancelled, or otherwise closed) — tell
      // the clicking user privately and leave the public message alone
      // rather than risk overwriting it with something wrong.
      await interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
      ctx.logger.info(
        {
          event: "attendance.rejected",
          guildId,
          matchId: parsed.matchId,
          status: parsed.status,
          latencyMs: Date.now() - startedAt,
        },
        "Attendance click rejected",
      );
      return;
    }

    const { match, attendanceRows } = result.value;
    const roster = await ctx.repositories.players.listActivePlayersByGuild(guildId);
    const { content, embeds, components } = buildRosterMessage(match, attendanceRows, roster);
    // update() edits the message the button itself is attached to — the
    // one shared public message everyone sees (plan section 16), no
    // separate fetch-by-id needed for this path.
    await interaction.update({ content, embeds, components });

    ctx.logger.info(
      {
        event: "attendance.recorded",
        guildId,
        matchId: parsed.matchId,
        discordUserId: interaction.user.id,
        status: parsed.status,
        latencyMs: Date.now() - startedAt,
      },
      "Attendance recorded",
    );

    const { changed } = result.value;
    // Deterministic and AI-independent, so it runs before the AI flow (which
    // returns early in several branches) and works with the AI switched off.
    await maybePostFullSquad(ctx, { match, status: parsed.status, changed, attendanceRows, roster });
    await sendAiFollowUp(interaction, ctx, { match, status: parsed.status, changed, roster, attendanceRows });
  } catch (err) {
    const cause = err instanceof Error && "cause" in err ? (err as { cause?: unknown }).cause : undefined;
    ctx.logger.error(
      {
        event: "attendance.failed",
        guildId,
        matchId: parsed.matchId,
        latencyMs: Date.now() - startedAt,
        err: err instanceof Error ? err.message : String(err),
        cause: cause instanceof Error ? cause.message : undefined,
      },
      "Attendance button handler threw",
    );
    // Plan section 48/49: never claim success, never leave attendance in
    // an ambiguous state, and the match system must stay usable even if
    // something downstream fails.
    const failureMessage = "Something went wrong recording your response. Please try again.";
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: failureMessage, ephemeral: true }).catch(() => undefined);
    } else {
      await interaction.reply({ content: failureMessage, ephemeral: true }).catch(() => undefined);
    }
  }
}
