import { ChannelType, SlashCommandBuilder } from "discord.js";
import type { Command } from "./types.js";
import { requireAdminWithConfig } from "../commandGuards.js";

/** Discord's hard limit for a message's `content`. */
const MAX_SAY_CHARS = 2000;
/** With `ai_voice` the text is a draft for the model, which has its own (shorter) output cap. */
const MAX_AI_DRAFT_CHARS = 1000;

/**
 * /mari-say — an admin has Mari post a message in a channel (2026-09-30).
 *
 * Two modes:
 * - **Verbatim (default).** The admin writes the text and Mari posts it word
 *   for word. Nothing goes through the LLM, so it can't drift from what the
 *   admin approved.
 * - **`ai_voice: true`.** The text is treated as a *draft*: the model rewrites
 *   it in Mari's voice (mariPersona.ts — the same persona every other Mari
 *   message uses), keeping every fact and command. Because the result is
 *   generated, `preview: true` shows it to the admin privately instead of
 *   posting, so they can re-roll or copy it and post it verbatim. If the AI is
 *   off, fails, or its output is rejected, NOTHING is posted — silently
 *   posting a different text than the admin asked for would be worse.
 *
 * - Admin only: same gate as every other admin command (Discord Administrator
 *   permission or the configured admin role — commandGuards.ts).
 * - Posts to `channel`, or to the channel the command was used in.
 * - Mentions are suppressed unless `allow_pings` is true (verbatim mode only;
 *   AI output never pings), so an accidental `@everyone` doesn't ping the
 *   whole server.
 * - A literal `\n` in the text becomes a line break (slash-command text boxes
 *   are single-line).
 * - The admin gets an ephemeral confirmation; the message appears as Mari's own.
 */
const data = new SlashCommandBuilder()
  .setName("mari-say")
  .setDescription("Make Mari post a message in a channel, as written or rewritten in her voice. Admin only.")
  .setDMPermission(false)
  .addStringOption((opt) =>
    opt
      .setName("message")
      .setDescription("What Mari should post (a draft if ai_voice is on). Type \\n for a line break.")
      .setRequired(true)
      .setMaxLength(MAX_SAY_CHARS),
  )
  .addBooleanOption((opt) =>
    opt
      .setName("ai_voice")
      .setDescription("Rewrite your message in Mari's voice with AI before posting (default: post it exactly as written)")
      .setRequired(false),
  )
  .addBooleanOption((opt) =>
    opt
      .setName("preview")
      .setDescription("With ai_voice: show me the rewrite privately instead of posting it")
      .setRequired(false),
  )
  .addChannelOption((opt) =>
    opt
      .setName("channel")
      .setDescription("Where to post it (default: this channel)")
      .addChannelTypes(ChannelType.GuildText)
      .setRequired(false),
  )
  .addBooleanOption((opt) =>
    opt
      .setName("allow_pings")
      .setDescription("Let @everyone / @role / @user mentions in the message ping (default: no; not with ai_voice)")
      .setRequired(false),
  );

/** The preview goes back as text the admin can paste into `message`: real line breaks would be lost in a slash-command box, so they are shown as \n. */
function renderPreview(text: string): string {
  const pasteable = text.replace(/```/g, "'''").replace(/\r?\n/g, "\\n");
  return `👀 **Preview — nothing was posted.** Run the command again with \`ai_voice\` for a new take, or paste this into \`message\` (without \`ai_voice\`) to post it exactly:\n\`\`\`\n${pasteable}\n\`\`\``;
}

const mariSayCommand: Command = {
  data,
  async execute(interaction, ctx) {
    const guard = await requireAdminWithConfig(interaction, ctx);
    if (!guard) return;

    const raw = interaction.options.getString("message", true);
    const content = raw.replace(/\\n/g, "\n").trim();
    const aiVoice = interaction.options.getBoolean("ai_voice") === true;
    const preview = interaction.options.getBoolean("preview") === true;
    const allowPings = interaction.options.getBoolean("allow_pings") === true;

    if (content.length === 0) {
      await interaction.reply({ content: "❌ The message is empty.", ephemeral: true });
      return;
    }
    if (content.length > MAX_SAY_CHARS) {
      await interaction.reply({
        content: `❌ That's ${content.length} characters — Discord's limit is ${MAX_SAY_CHARS}.`,
        ephemeral: true,
      });
      return;
    }
    if (preview && !aiVoice) {
      await interaction.reply({ content: "❌ `preview` only works together with `ai_voice` (a verbatim message has nothing to preview).", ephemeral: true });
      return;
    }
    if (aiVoice && allowPings) {
      await interaction.reply({ content: "❌ `allow_pings` can't be combined with `ai_voice` — AI-written text never pings anyone.", ephemeral: true });
      return;
    }
    if (aiVoice && content.length > MAX_AI_DRAFT_CHARS) {
      await interaction.reply({
        content: `❌ With \`ai_voice\` the draft can be at most ${MAX_AI_DRAFT_CHARS} characters (yours is ${content.length}).`,
        ephemeral: true,
      });
      return;
    }

    const channelId = interaction.options.getChannel("channel")?.id ?? interaction.channelId;

    let finalText = content;
    if (aiVoice) {
      if (!ctx.services.ai.enabled) {
        await interaction.reply({ content: "❌ Mari's AI isn't configured right now, so I can't rewrite it. Nothing was posted — drop `ai_voice` to post your text exactly as written.", ephemeral: true });
        return;
      }
      const roster = await ctx.repositories.players.listActiveByGuild(guard.guildId);
      const outcome = await ctx.services.ai.rewriteAdminMessage({ draft: content, roster });
      if (outcome.source !== "ai") {
        await interaction.reply({
          content: "❌ The AI didn't give me a usable rewrite (it may be down, or its answer was rejected). Nothing was posted. Try again, or drop `ai_voice` to post your text exactly as written.",
          ephemeral: true,
        });
        return;
      }
      finalText = outcome.text;

      if (preview) {
        await interaction.reply({ content: renderPreview(finalText), ephemeral: true });
        return;
      }
    }

    try {
      await ctx.discord.sendChannelMessage(channelId, { content: finalText, suppressMentions: !allowPings });
    } catch (err) {
      ctx.logger.error(
        { event: "mariSay.failed", guildId: guard.guildId, channelId, aiVoice, err: err instanceof Error ? err.message : String(err) },
        "Mari couldn't post the message",
      );
      await interaction.reply({
        content: `❌ I couldn't post in <#${channelId}>. Check that Mari can view that channel and has **Send Messages** there.`,
        ephemeral: true,
      });
      return;
    }

    ctx.logger.info({ event: "mariSay.posted", guildId: guard.guildId, channelId, aiVoice }, "Admin message posted as Mari");
    await interaction.reply({
      content: aiVoice ? `✅ Posted in <#${channelId}> — rewritten in Mari's voice.` : `✅ Posted in <#${channelId}>.`,
      ephemeral: true,
    });
  },
};

export default mariSayCommand;
