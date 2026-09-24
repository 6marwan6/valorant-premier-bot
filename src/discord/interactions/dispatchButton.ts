import type { ButtonInteraction } from "discord.js";
import type { AppContext } from "../../appContext.js";
import { parseAttendanceCustomId } from "../../modules/attendance/customId.js";
import { buildRosterMessage } from "../../modules/attendance/rosterMessage.js";
import { resolveDisplayName } from "../displayName.js";
import { startConsoleDm } from "../consoleConversation.js";
import type { MatchRow } from "../../database/schema/matches.js";
import type { PlayerRow } from "../../database/schema/players.js";
import type { AttendanceRow } from "../../database/schema/attendance.js";

/**
 * Plan section 15 step 6 / section 17 — amended: reactions are PUBLIC.
 *
 * - PLAYING (CELEBRATE) / CANNOT_PLAY (ROAST): the AI message is posted in
 *   the match channel, @mentioning the player.
 * - WANTS_TO_BUT_CANNOT (CONSOLE): the public channel only gets a fixed,
 *   non-roasting "can't make it" line (no AI text, no reason). The
 *   conversation about why happens in a private DM (Phase 7); the click gets
 *   an ephemeral pointer to it. If no DM is possible (AI follow-ups off,
 *   closed DMs) the player gets Phase 6's single ephemeral message instead.
 * - If the AI fails, the safe fallback goes to the player privately, never
 *   into the channel.
 *
 * Runs strictly AFTER the attendance write and roster update, fully isolated
 * (plan sections 48, 66 #8). Skipped when the AI isn't configured, on an
 * unchanged click (section 50), or without an active player profile.
 */
async function sendAiFollowUp(
  interaction: ButtonInteraction,
  ctx: AppContext,
  params: { match: MatchRow; status: AttendanceRow["status"]; changed: boolean; roster: PlayerRow[] },
): Promise<void> {
  if (!params.changed || !ctx.services.ai.enabled) return;
  const player = params.roster.find((p) => p.discordUserId === interaction.user.id);
  if (!player) return;
  const channelId = params.match.announcementChannelId;

  try {
    await ctx.services.conversations.endForAttendanceChange(player.id, params.match.id, params.status);

    let dmFailed = false;
    if (params.status === "WANTS_TO_BUT_CANNOT") {
      const started = await startConsoleDm(ctx, { player, match: params.match });
      if (started === "already_open") return;
      if (channelId) {
        await ctx.discord.sendMentionMessage(channelId, "can't make it this time 🟡", player.discordUserId);
      }
      if (started === "started") {
        await interaction.followUp({ content: "📩 I sent you a DM — let's talk there.", ephemeral: true });
        return;
      }
      dmFailed = started === "dm_failed";
      // "unavailable" / "dm_failed": fall through to the private single message.
    }

    const outcome = await ctx.services.ai.respondToAttendance({
      player,
      match: params.match,
      status: params.status,
    });

    if (params.status !== "WANTS_TO_BUT_CANNOT" && outcome.source === "ai" && channelId) {
      await ctx.discord.sendMentionMessage(channelId, outcome.text, player.discordUserId);
      return;
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
 * Routes a button click. Currently only attendance buttons exist
 * (custom_id `attendance:<matchId>:<status>`, plan section 15); anything
 * else is logged and ignored rather than crashing, the same
 * fail-safe posture as dispatchCommand's "unknown command" branch.
 */
export async function dispatchButton(interaction: ButtonInteraction, ctx: AppContext): Promise<void> {
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
    const roster = await ctx.repositories.players.listActiveByGuild(guildId);
    const { content, components } = buildRosterMessage(match, attendanceRows, roster);
    // update() edits the message the button itself is attached to — the
    // one shared public message everyone sees (plan section 16), no
    // separate fetch-by-id needed for this path.
    await interaction.update({ content, components });

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

    await sendAiFollowUp(interaction, ctx, { match, status: parsed.status, changed: result.value.changed, roster });
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
