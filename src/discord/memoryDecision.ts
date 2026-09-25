import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import type { ButtonInteraction } from "discord.js";
import type { AppContext } from "../appContext.js";
import { buildMemoryDeclineCustomId, buildMemoryRememberCustomId, parseMemoryDecisionCustomId } from "../modules/memories/memoryCustomId.js";

/**
 * Discord side of Phase 8's memory approval (plan section 21). The
 * decision itself lives in modules/memories/memoryService.ts; this file
 * only builds the buttons and moves the DM message around the decision,
 * the same split as consoleConversation.ts.
 *
 * Routed from dispatchButton.ts exactly like an attendance click — same
 * DeferredMessageUpdate ack Discord already received before either handler
 * runs (see handleDiscordInteraction.ts) — but this one edits a DM message,
 * never attendance or match state (plan section 66 #8 holds regardless of
 * which button-flow is running).
 */

const REMEMBERED_NOTE = "\n\n-# 🧠 Got it — I'll remember that.";
const DECLINED_NOTE = "\n\n-# 👍 Okay, I won't remember that.";

export function buildMemoryDecisionRow(messageId: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildMemoryRememberCustomId(messageId))
      .setLabel("Remember")
      .setEmoji("🧠")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(buildMemoryDeclineCustomId(messageId))
      .setLabel("Don't Remember")
      .setEmoji("❌")
      .setStyle(ButtonStyle.Secondary),
  );
}

export async function handleMemoryDecisionButton(interaction: ButtonInteraction, ctx: AppContext): Promise<void> {
  const parsed = parseMemoryDecisionCustomId(interaction.customId);
  if (!parsed) {
    await interaction.followUp({ content: "This button isn't recognized anymore.", ephemeral: true });
    return;
  }

  const startedAt = Date.now();
  try {
    const outcome = await ctx.services.memories.decide({
      messageId: parsed.messageId,
      discordUserId: interaction.user.id,
      decision: parsed.decision,
    });

    switch (outcome.kind) {
      // Same message either way — don't confirm whether a memory candidate
      // belonging to someone else exists at all (plan section 44).
      case "not_found":
      case "forbidden":
        await interaction.followUp({ content: "I couldn't find that.", ephemeral: true });
        break;

      case "already_decided":
        await interaction.followUp({ content: "Already handled that one 👍", ephemeral: true });
        break;

      case "declined":
        await interaction.update({ content: `${outcome.originalText}${DECLINED_NOTE}`, components: [] });
        break;

      case "remembered":
        await interaction.update({ content: `${outcome.originalText}${REMEMBERED_NOTE}`, components: [] });
        break;
    }

    ctx.logger.info(
      {
        event: "memory.decision",
        messageId: parsed.messageId,
        decision: parsed.decision,
        outcome: outcome.kind,
        latencyMs: Date.now() - startedAt,
      },
      "Memory candidate decision handled",
    );
  } catch (err) {
    ctx.logger.error(
      {
        event: "memory.decision.failed",
        messageId: parsed.messageId,
        latencyMs: Date.now() - startedAt,
        err: err instanceof Error ? err.message : String(err),
      },
      "Memory decision handler threw",
    );
    await interaction.followUp({ content: "Something went wrong. Please try again.", ephemeral: true }).catch(() => undefined);
  }
}
