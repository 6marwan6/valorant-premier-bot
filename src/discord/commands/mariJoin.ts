import { ChannelType, SlashCommandBuilder } from "discord.js";
import type { Command } from "./types.js";
import { requireAdminWithConfig } from "../commandGuards.js";
import { parseMatchDateTime } from "../../modules/matches/dateTime.js";
import {
  MAX_PITCH,
  MIN_PITCH,
  ORPHEUS_VOICES,
  describeOverrides,
  hasOverrides,
  sanitizeDirection,
  type VoiceOverrides,
} from "../../modules/voice/voiceSettings.js";

/** A time a few minutes in the past still means "now" (the admin typed 19:00 at 19:01); further back is almost certainly a typo for tomorrow. */
const PAST_GRACE_MS = 5 * 60_000;

/**
 * /mari-join — an admin tells Mari which voice channel to join, and when
 * (2026-10-01; plan section 41 revision, admin commands).
 *
 * The command itself only WRITES A REQUEST to the database; the voice
 * connection lives in the gateway worker (plan section 4's 2026-10-01 revision),
 * which picks the request up within about 15 seconds of its join time. So the
 * worker has to be running with voice enabled — the reply says so.
 *
 * - `channel` (required): the voice channel.
 * - `time` (optional): when. Omitted = now. Same forms as /create-match's time
 *   field: 19:00, 7pm, "2 hours", evening ... interpreted in the team timezone.
 * - `date` (optional, needs `time`): same forms as /create-match's date field;
 *   defaults to today.
 * - Only one request waits at a time: a new one replaces the previous one, which
 *   is also how an admin fixes a wrong time.
 * - Mari joins at the time — or, if the channel is still empty then, as soon as
 *   someone walks in within the next 30 minutes (she never sits alone in an
 *   empty channel). She leaves when the channel empties, like her auto-join.
 * - `voice`, `direction`, `pitch` (all optional, 2026-10-01): how she sounds. Whatever is left
 *   out keeps the VOICE_* default — or, if she is already in that channel, what she is using
 *   now — so `/mari-join channel:#x voice:troy` changes the voice of a live session without
 *   moving her. They apply to this session only; she goes back to the defaults next time she
 *   joins fresh (an auto-join or a request that names a different channel).
 * - Admin only, like every command that changes how the bot behaves.
 */
const data = new SlashCommandBuilder()
  .setName("mari-join")
  .setDescription("Tell Mari which voice channel to join, and when. Admin only.")
  .setDMPermission(false)
  .addChannelOption((opt) =>
    opt
      .setName("channel")
      .setDescription("The voice channel Mari should join")
      .addChannelTypes(ChannelType.GuildVoice)
      .setRequired(true),
  )
  .addStringOption((opt) =>
    opt
      .setName("time")
      .setDescription("When to join, in the team timezone: 19:00, 7pm, evening, 2 hours ... (default: now)")
      .setRequired(false)
      .setMaxLength(40),
  )
  .addStringOption((opt) =>
    opt
      .setName("date")
      .setDescription("Which day (needs time): today, tomorrow, a weekday, 18/09/2026 ... (default: today)")
      .setRequired(false)
      .setMaxLength(40),
  )
  .addStringOption((opt) =>
    opt
      .setName("voice")
      .setDescription("Which voice she speaks with (default: the server default)")
      .setRequired(false)
      .addChoices(...ORPHEUS_VOICES.map((v) => ({ name: v, value: v }))),
  )
  .addStringOption((opt) =>
    opt
      .setName("direction")
      .setDescription("One delivery word, e.g. cheerful, whisper, sad. Type none to clear it")
      .setRequired(false)
      .setMaxLength(30),
  )
  .addNumberOption((opt) =>
    opt
      .setName("pitch")
      .setDescription(`Pitch multiplier, ${MIN_PITCH} to ${MAX_PITCH} (1 = unchanged; also changes speed a little)`)
      .setRequired(false)
      .setMinValue(MIN_PITCH)
      .setMaxValue(MAX_PITCH),
  );

const mariJoinCommand: Command = {
  data,
  async execute(interaction, ctx) {
    const guard = await requireAdminWithConfig(interaction, ctx);
    if (!guard) return;

    const channel = interaction.options.getChannel("channel", true);
    const timeStr = interaction.options.getString("time")?.trim() ?? "";
    const dateStr = interaction.options.getString("date")?.trim() ?? "";
    const rawDirection = interaction.options.getString("direction");
    const overrides: VoiceOverrides = {
      voice: interaction.options.getString("voice"),
      direction: rawDirection === null ? null : sanitizeDirection(rawDirection),
      pitch: interaction.options.getNumber("pitch"),
    };
    if (rawDirection !== null && rawDirection.trim() !== "" && overrides.direction === "" && !/^(none|off|default|clear)$/i.test(rawDirection.trim())) {
      await interaction.reply({ content: "❌ `direction` must be plain words (letters only), e.g. `cheerful`. Type `none` to clear it.", ephemeral: true });
      return;
    }

    if (channel.type !== ChannelType.GuildVoice) {
      await interaction.reply({ content: "❌ Pick a **voice** channel (Mari can't join a text channel).", ephemeral: true });
      return;
    }

    const now = new Date();
    let joinAt = now;
    if (dateStr && !timeStr) {
      await interaction.reply({ content: "❌ `date` needs a `time` too (e.g. `date: tomorrow`, `time: 19:00`). Leave both out to join right now.", ephemeral: true });
      return;
    }
    if (timeStr) {
      const parsed = parseMatchDateTime(dateStr || "today", timeStr, guard.config.timezone, now);
      if (!parsed.ok) {
        await interaction.reply({ content: `❌ ${parsed.error}`, ephemeral: true });
        return;
      }
      if (parsed.scheduledAt.getTime() < now.getTime() - PAST_GRACE_MS) {
        await interaction.reply({ content: "❌ That time has already passed today. Add `date: tomorrow` (or leave `time` out to join right now).", ephemeral: true });
        return;
      }
      joinAt = parsed.scheduledAt.getTime() < now.getTime() ? now : parsed.scheduledAt;
    }

    let outcome;
    try {
      outcome = await ctx.repositories.voiceJoins.schedule({
        guildId: guard.guildId,
        channelId: channel.id,
        joinAt,
        requestedBy: interaction.user.id,
        ...overrides,
      });
    } catch (err) {
      ctx.logger.error({ event: "mariJoin.failed", guildId: guard.guildId, err: err instanceof Error ? err.message : String(err) }, "Couldn't store the voice join request");
      await interaction.reply({ content: "❌ Something went wrong saving that. Please try again.", ephemeral: true });
      return;
    }

    ctx.logger.info(
      { event: "mariJoin.scheduled", guildId: guard.guildId, channelId: channel.id, requestId: outcome.request.id, replaced: outcome.replaced?.id ?? null },
      "Voice join scheduled",
    );

    const unix = Math.floor(joinAt.getTime() / 1000);
    const isNow = !timeStr;
    const lines = [
      isNow
        ? `✅ Mari will join <#${channel.id}> in a few seconds (once someone is in there).`
        : `✅ Mari will join <#${channel.id}> <t:${unix}:F> (<t:${unix}:R>), or as soon as someone is in there within 30 minutes after that.`,
    ];
    if (hasOverrides(overrides)) lines.push(`🎚️ ${describeOverrides(overrides)} (if she's already in that channel, it changes right away)`);
    if (outcome.replaced) lines.push(`↪️ That replaces the earlier request for <#${outcome.replaced.channelId}>.`);
    lines.push("-# Needs the gateway worker running with voice enabled. She leaves when the channel empties.");
    await interaction.reply({ content: lines.join("\n"), ephemeral: true });
  },
};

export default mariJoinCommand;
