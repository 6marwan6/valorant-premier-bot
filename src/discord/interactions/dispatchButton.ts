import type { ButtonInteraction } from "discord.js";
import type { AppContext } from "../../appContext.js";
import { parseAttendanceCustomId } from "../../modules/attendance/customId.js";
import { buildRosterMessage } from "../../modules/attendance/rosterMessage.js";
import { resolveDisplayName } from "../displayName.js";

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
    const { content, components } = buildRosterMessage(match, attendanceRows);
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
