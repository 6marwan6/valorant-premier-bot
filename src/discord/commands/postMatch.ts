import { SlashCommandBuilder } from "discord.js";
import type { Command } from "./types.js";
import { requireAdminWithConfig } from "../commandGuards.js";
import { buildRosterMessage } from "../../modules/attendance/rosterMessage.js";

/**
 * /post-match — plan section 41 doesn't name this command; it was added
 * in Phase 3 as a provisional bridge before Phase 4's reminder scheduler
 * existed (see README's Phase 3 "ordering tensions" section for the
 * original reasoning).
 *
 * Phase 4 (services/scheduling/reminderCronJob.ts) now opens a match for
 * confirmation automatically, via whichever configured reminder offset
 * fires first — the plan's own section 61 example ("posted... three
 * hours before kickoff"). This command is kept, not retired, as the
 * "post early" manual override the README predicted: an admin who wants
 * the match open right now, ahead of its scheduled reminders, still has
 * a button for that. It calls the exact same
 * AttendanceService.prepareAnnouncement/recordAnnouncement pair the cron
 * job uses, so whichever one wins a race (this command vs. a reminder
 * firing at the same moment) leaves the match in a consistent state —
 * prepareAnnouncement's SCHEDULED-only guard makes the loser's attempt
 * fail with "already been posted" rather than double-post.
 */
const data = new SlashCommandBuilder()
  .setName("post-match")
  .setDescription("Post the match announcement with attendance buttons now, ahead of its reminder. Admin only.")
  .setDMPermission(false)
  .addIntegerOption((opt) =>
    opt.setName("match_id").setDescription("Match number, e.g. 42").setRequired(true),
  );

const postMatchCommand: Command = {
  data,
  async execute(interaction, ctx) {
    const guard = await requireAdminWithConfig(interaction, ctx);
    if (!guard) return;

    const matchId = interaction.options.getInteger("match_id", true);

    const prepared = await ctx.services.attendance.prepareAnnouncement(guard.guildId, matchId);
    if (!prepared.ok) {
      await interaction.reply({ content: `❌ ${prepared.error}`, ephemeral: true });
      return;
    }

    const { match, channelId } = prepared.value;

    // match.status here is still SCHEDULED — the DB transition to
    // CONFIRMATION_OPEN only commits below, once the send succeeds (plan
    // section 48: don't mark state changed until the action it describes
    // actually happened). But buildRosterMessage's button-attachment rule
    // is driven by status, and the message we're sending right now IS the
    // "open for confirmation" message — so build it against the status
    // this match is *about to have*, not its current row.
    const { content, components } = buildRosterMessage({ ...match, status: "CONFIRMATION_OPEN" }, []);

    // No channel-type check here: /setup's match_channel option is
    // already restricted to ChannelType.GuildText (see setup.ts), so a
    // configured matchChannelId is guaranteed sendable. Any unexpected
    // REST failure (channel deleted, bot kicked, etc.) surfaces through
    // dispatchCommand's generic error handling.
    const sent = await ctx.discord.sendChannelMessage(channelId, { content, components });

    await ctx.services.attendance.recordAnnouncement(match.id, channelId, sent.id);

    ctx.logger.info(
      { event: "match.posted", guildId: guard.guildId, matchId: match.id, channelId },
      "Match announcement posted",
    );

    await interaction.reply({
      content: `✅ Posted **Match #${match.id}** to <#${channelId}> and opened it for confirmations.`,
      ephemeral: true,
    });
  },
};

export default postMatchCommand;
