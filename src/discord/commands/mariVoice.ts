import { ChannelType, SlashCommandBuilder } from "discord.js";
import type { Command } from "./types.js";
import { requireAdminWithConfig } from "../commandGuards.js";
import { VoiceNoteError, buildVoiceNote, loadVoiceNoteSettings } from "../../modules/voice/voiceNote.js";

/** A voice note is spoken text, and speech is cut at ~400 characters (about 25 seconds); the model's draft cap is the same as /mari-say. */
const MAX_VOICE_CHARS = 400;
const MAX_AI_DRAFT_CHARS = 400;

/**
 * /mari-voice — an admin has Mari send a voice note in a channel (2026-10-01 (d)).
 *
 * The voice-note sibling of /mari-say, with the same rules: admin only; the text is spoken exactly as written
 * unless `ai_voice` is on, in which case the model rewrites it in Mari's voice first (and if the AI is off or
 * its output is rejected, NOTHING is sent: no different words than the admin approved), with `preview` to see
 * the rewrite privately; it goes to `channel` or the channel the command was used in.
 *
 * What it adds: the text is spoken with her live voice settings (Groq Orpheus; English or Arabic chosen by the
 * script of each sentence, same as live voice) and posted as a Discord voice message. A voice message can't
 * carry text, so the words are not shown next to it. If Discord refuses the voice-message flow the same audio
 * is posted as a normal .ogg attachment and the admin is told.
 *
 * It runs in the Vercel app, so GROQ_API_KEY (and optionally the VOICE_* variables) must be set there too.
 */
const data = new SlashCommandBuilder()
  .setName("mari-voice")
  .setDescription("Make Mari send a voice note in a channel (English or Arabic). Admin only.")
  .setDMPermission(false)
  .addStringOption((opt) =>
    opt
      .setName("message")
      .setDescription("What Mari says out loud (a draft if ai_voice is on). Up to 400 characters.")
      .setRequired(true)
      .setMaxLength(MAX_VOICE_CHARS),
  )
  .addBooleanOption((opt) =>
    opt.setName("ai_voice").setDescription("Rewrite your message in Mari's voice with AI before speaking it (default: speak it as written)").setRequired(false),
  )
  .addBooleanOption((opt) =>
    opt.setName("preview").setDescription("With ai_voice: show me the rewrite privately instead of sending the voice note").setRequired(false),
  )
  .addChannelOption((opt) =>
    opt.setName("channel").setDescription("Where to send it (default: this channel)").addChannelTypes(ChannelType.GuildText).setRequired(false),
  );

function renderPreview(text: string): string {
  const pasteable = text.replace(/```/g, "'''").replace(/\r?\n/g, " ");
  return `👀 **Preview — no voice note was sent.** Run the command again with \`ai_voice\` for a new take, or paste this into \`message\` (without \`ai_voice\`) to have her say exactly this:\n\`\`\`\n${pasteable}\n\`\`\``;
}

const mariVoiceCommand: Command = {
  data,
  async execute(interaction, ctx) {
    const guard = await requireAdminWithConfig(interaction, ctx);
    if (!guard) return;

    const content = interaction.options.getString("message", true).replace(/\\n/g, " ").trim();
    const aiVoice = interaction.options.getBoolean("ai_voice") === true;
    const preview = interaction.options.getBoolean("preview") === true;
    const channelId = interaction.options.getChannel("channel")?.id ?? interaction.channelId;

    if (content.length === 0) {
      await interaction.reply({ content: "❌ The message is empty.", ephemeral: true });
      return;
    }
    if (preview && !aiVoice) {
      await interaction.reply({ content: "❌ `preview` only works together with `ai_voice`.", ephemeral: true });
      return;
    }
    if (aiVoice && content.length > MAX_AI_DRAFT_CHARS) {
      await interaction.reply({ content: `❌ With \`ai_voice\` the draft can be at most ${MAX_AI_DRAFT_CHARS} characters (yours is ${content.length}).`, ephemeral: true });
      return;
    }

    const settings = loadVoiceNoteSettings();
    if (!settings && !(aiVoice && preview)) {
      await interaction.reply({ content: "❌ Voice isn't configured in the app: `GROQ_API_KEY` is missing from the Vercel environment (the voice worker's own settings aren't shared with it).", ephemeral: true });
      return;
    }

    let finalText = content;
    if (aiVoice) {
      if (!ctx.services.ai.enabled) {
        await interaction.reply({ content: "❌ Mari's AI isn't configured right now, so I can't rewrite it. Nothing was sent — drop `ai_voice` to have her say your text exactly as written.", ephemeral: true });
        return;
      }
      const roster = await ctx.repositories.players.listActiveByGuild(guard.guildId);
      const outcome = await ctx.services.ai.rewriteAdminMessage({ draft: content, roster });
      if (outcome.source !== "ai") {
        await interaction.reply({ content: "❌ The AI didn't give me a usable rewrite (it may be down, or its answer was rejected). Nothing was sent. Try again, or drop `ai_voice`.", ephemeral: true });
        return;
      }
      finalText = outcome.text;
      if (preview) {
        await interaction.reply({ content: renderPreview(finalText), ephemeral: true });
        return;
      }
    }

    let note;
    try {
      note = await buildVoiceNote({ text: finalText, settings: settings!, logger: ctx.logger });
    } catch (err) {
      const kind = err instanceof VoiceNoteError ? err.kind : "tts";
      ctx.logger.error({ event: "mariVoice.synthFailed", guildId: guard.guildId, kind, err: err instanceof Error ? err.message : String(err) }, "Mari couldn't make the voice note");
      await interaction.reply({
        content:
          kind === "empty"
            ? "❌ There was nothing speakable in that text (only emoji or symbols?)."
            : "❌ I couldn't make the voice note (the speech service refused or timed out). Nothing was sent. For Arabic, the Arabic voice's terms must be accepted once in the Groq console.",
        ephemeral: true,
      });
      return;
    }

    let asVoiceMessage = true;
    try {
      await ctx.discord.sendVoiceMessage(channelId, note);
    } catch (err) {
      ctx.logger.warn({ event: "mariVoice.voiceMessageFailed", guildId: guard.guildId, channelId, err: err instanceof Error ? err.message : String(err) }, "Voice-message upload failed; sending the audio as a file instead");
      asVoiceMessage = false;
      try {
        await ctx.discord.sendAudioFile(channelId, note.ogg);
      } catch (err2) {
        ctx.logger.error({ event: "mariVoice.failed", guildId: guard.guildId, channelId, err: err2 instanceof Error ? err2.message : String(err2) }, "Mari couldn't post the voice note");
        await interaction.reply({ content: `❌ I couldn't post in <#${channelId}>. Check that Mari can view that channel and has **Send Messages** and **Attach Files** there (and **Send Voice Messages** for the voice-message player).`, ephemeral: true });
        return;
      }
    }

    ctx.logger.info({ event: "mariVoice.sent", guildId: guard.guildId, channelId, aiVoice, asVoiceMessage, language: note.language, chunks: note.chunks, seconds: note.durationSecs }, "Voice note sent as Mari");
    await interaction.reply({
      content: `✅ Voice note sent in <#${channelId}>${aiVoice ? " — rewritten in Mari's voice" : ""}${asVoiceMessage ? "" : ". Discord refused the voice-message player, so it went as a normal audio file (give Mari **Send Voice Messages** in that channel)"}.`,
      ephemeral: true,
    });
  },
};

export default mariVoiceCommand;
