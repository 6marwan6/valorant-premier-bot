import { SlashCommandBuilder } from "discord.js";
import type { Command } from "./types.js";
import { requireAdminWithConfig } from "../commandGuards.js";
import { syncAnnouncementIfPosted } from "../announcementSync.js";
import type { MatchResultValue } from "../../modules/matches/postMatchService.js";

/**
 * /complete-match — plan section 39 "Post-Match Mode". Result is required
 * (the plan's own example always states one); notes are optional freeform
 * text ("Ahmed clutched round 19. Omar top fragged. Marwan forgot to smoke
 * Heaven."), fed to AiService.extractMatchEvents (plan section 40) before
 * the recap is generated. Everything past the lifecycle/config checks is
 * PostMatchService's job — this handler is Discord-facing glue only, same
 * split as every other command in this codebase.
 */
const data = new SlashCommandBuilder()
  .setName("complete-match")
  .setDescription("Mark a Premier match as completed and post a recap. Admin only.")
  .setDMPermission(false)
  .addIntegerOption((opt) => opt.setName("match_id").setDescription("Match number, e.g. 42").setRequired(true))
  .addStringOption((opt) =>
    opt
      .setName("result")
      .setDescription("Did the team win or lose?")
      .setRequired(true)
      .addChoices({ name: "Win", value: "WIN" }, { name: "Loss", value: "LOSS" }),
  )
  .addStringOption((opt) =>
    opt
      .setName("notes")
      .setDescription("Optional notes, e.g. 'Ahmed clutched round 19. Omar top fragged.'")
      .setRequired(false),
  );

const completeMatchCommand: Command = {
  data,
  async execute(interaction, ctx) {
    const guard = await requireAdminWithConfig(interaction, ctx);
    if (!guard) return;

    const matchId = interaction.options.getInteger("match_id", true);
    const result = interaction.options.getString("result", true) as MatchResultValue;
    const notes = interaction.options.getString("notes")?.trim() || null;

    const outcome = await ctx.services.postMatch.completeMatch({ guildId: guard.guildId, matchId, result, notes });
    if (!outcome.ok) {
      await interaction.reply({ content: `❌ ${outcome.error}`, ephemeral: true });
      return;
    }

    const { match, matchEvents, recap, channelId } = outcome.value;

    // The match already lost its buttons the instant status became
    // COMPLETED (rosterMessage.ts only ever renders them for
    // CONFIRMATION_OPEN) — this just pushes that fact to the already-posted
    // public message, same as /cancel-match and /edit-match do.
    const withAttendance = await ctx.services.attendance.getMatchWithAttendance(guard.guildId, matchId);
    if (withAttendance) {
      await syncAnnouncementIfPosted(ctx, withAttendance);
    }

    // Plan section 14's principle applies here too: the header/result/
    // opponent are deterministic facts built by the app, never the LLM —
    // only the body underneath is AI-generated (or a safe generic fallback
    // if AI is off or fails, plan section 48).
    const header = result === "WIN" ? "🏆 **MATCH REPORT**" : "💔 **MATCH REPORT**";
    const scoreLine = `**${match.opponent}** — ${result === "WIN" ? "WIN" : "LOSS"}`;
    const body =
      recap.source === "ai"
        ? recap.text
        : result === "WIN"
          ? "GG — chalk that one up. 🏆"
          : "GG — back to the grind for the next one.";

    await ctx.discord.sendChannelMessage(channelId, { content: [header, "", scoreLine, "", body].join("\n") });

    await interaction.reply({
      content: `✅ **Match #${match.id}** recorded as a ${result === "WIN" ? "win" : "loss"} vs ${match.opponent}${matchEvents.length > 0 ? ` — logged ${matchEvents.length} match event${matchEvents.length === 1 ? "" : "s"}.` : "."}`,
      ephemeral: true,
    });
  },
};

export default completeMatchCommand;
