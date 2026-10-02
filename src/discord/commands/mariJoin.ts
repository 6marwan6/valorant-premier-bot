import { ChannelType, SlashCommandBuilder } from "discord.js";
import type { Command } from "./types.js";
import { requireMemberWithConfig } from "../commandGuards.js";
import { parseMatchDateTime } from "../../modules/matches/dateTime.js";
import {
  LANGUAGE_CHOICES,
  LISTEN_CHOICES,
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
 * /mari-join — a member (any member, 2026-10-02) tells Mari which voice channel to join, and when
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
 *   There is no date option (removed 2026-10-01): a clock time that has already
 *   passed today means the same time TOMORROW (the reply shows the exact moment).
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
 * - `listen` (optional, 2026-10-01 (b)): whether she needs her name. "Group" = only when she hears
 *   "Mari"; "Just one person" = she answers everything the roster player says; "Auto" (the default)
 *   = no name needed only while exactly one human is with her. Same rules as the other choices:
 *   left out keeps what she has, applies to this session, changes a live session without moving her.
 * - Open to every server member (2026-10-02). Only the style options above (voice, direction, pitch, listen)
 *   stay admin-only; a non-admin who sets one is refused and nothing is scheduled.
 * - `language` (optional, 2026-10-02): "en" (default) or "ar-EG". The language of the whole session, fixed:
 *   it is what Deepgram is told she is hearing and whether she speaks with the Arabic voice. She speaks Arabic
 *   ONLY when this is ar-EG; there is no auto-detection and no second speech-to-text request. Open to every
 *   member, like the command itself. Left out, a fresh join is English; a live session keeps its language.
 */
const data = new SlashCommandBuilder()
  .setName("mari-join")
  .setDescription("Tell Mari which voice channel to join, and when.")
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
      .setDescription("When (team timezone): 19:00, 7pm, 2 hours ... Default: now. A time already past = tomorrow")
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
  .addStringOption((opt) =>
    opt
      .setName("listen")
      .setDescription("Does she need to hear her name? Group = yes; Just one person = no (default: auto)")
      .setRequired(false)
      .addChoices(...LISTEN_CHOICES),
  )
  .addStringOption((opt) =>
    opt
      .setName("language")
      .setDescription("The language she hears and speaks this session (default: English). Arabic only if you pick ar-EG")
      .setRequired(false)
      .addChoices(...LANGUAGE_CHOICES),
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
    const guard = await requireMemberWithConfig(interaction, ctx);
    if (!guard) return;

    const channel = interaction.options.getChannel("channel", true);
    const timeStr = interaction.options.getString("time")?.trim() ?? "";
    const rawDirection = interaction.options.getString("direction");
    const overrides: VoiceOverrides = {
      voice: interaction.options.getString("voice"),
      direction: rawDirection === null ? null : sanitizeDirection(rawDirection),
      pitch: interaction.options.getNumber("pitch"),
      listen: interaction.options.getString("listen"),
      language: interaction.options.getString("language"),
    };
    // Anyone may call her; changing how she sounds or listens stays an admin decision.
    // `language` is open to everyone: the person who is going to speak Arabic has to be able to say so.
    if (!guard.isAdmin && hasOverrides({ ...overrides, language: null })) {
      await interaction.reply({ content: "❌ Anyone can ask Mari to join (and pick her `language`), but only admins can change her `voice`, `direction`, `pitch` or `listen`. Run it again with just the channel (and time).", ephemeral: true });
      return;
    }
    if (rawDirection !== null && rawDirection.trim() !== "" && overrides.direction === "" && !/^(none|off|default|clear)$/i.test(rawDirection.trim())) {
      await interaction.reply({ content: "❌ `direction` must be plain words (letters only), e.g. `cheerful`. Type `none` to clear it.", ephemeral: true });
      return;
    }

    // Discord already limits the picker to voice channels (addChannelTypes above). A payload that carries no type
    // is not evidence of a text channel, so only a type we can actually see and that isn't voice is refused.
    if (channel.type !== undefined && channel.type !== ChannelType.GuildVoice) {
      await interaction.reply({ content: "❌ Pick a **voice** channel (Mari can't join a text channel).", ephemeral: true });
      return;
    }

    const now = new Date();
    let joinAt = now;
    let rolledToTomorrow = false;
    if (timeStr) {
      let parsed = parseMatchDateTime("today", timeStr, guard.config.timezone, now);
      if (!parsed.ok) {
        await interaction.reply({ content: `❌ ${parsed.error}`, ephemeral: true });
        return;
      }
      if (parsed.scheduledAt.getTime() < now.getTime() - PAST_GRACE_MS) {
        // No date option any more: a time that already passed today means tomorrow at that time.
        const tomorrow = parseMatchDateTime("tomorrow", timeStr, guard.config.timezone, now);
        if (!tomorrow.ok) {
          await interaction.reply({ content: "❌ That time has already passed today. Give a clock time like `19:00`, or leave `time` out to join right now.", ephemeral: true });
          return;
        }
        parsed = tomorrow;
        rolledToTomorrow = true;
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
    if (rolledToTomorrow) lines.push("🗓️ That time has already passed today, so I used tomorrow.");
    if (hasOverrides(overrides)) lines.push(`🎚️ ${describeOverrides(overrides)} (if she's already in that channel, it changes right away)`);
    if (outcome.replaced) lines.push(`↪️ That replaces the earlier request for <#${outcome.replaced.channelId}>.`);
    lines.push("-# Needs the gateway worker running with voice enabled. She leaves when the channel empties.");
    await interaction.reply({ content: lines.join("\n"), ephemeral: true });
  },
};

export default mariJoinCommand;
