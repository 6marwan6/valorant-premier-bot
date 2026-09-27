import type { ButtonInteraction } from "discord.js";
import type { AppContext } from "../appContext.js";
import { parseMemoryDeleteCustomId } from "../modules/memories/memoryManageCustomId.js";

/**
 * The 🗑️ delete buttons — plan sections 42/43's `/memories` list, and
 * (since the section 21 revision) the single "Forget this" button that
 * rides on an auto-saved memory's DM note (see consoleConversation.ts).
 * Both use the exact same `memory:del:<memoryId>` id and land here, routed
 * from dispatchButton.ts like every other button.
 *
 * Appends a short note to whatever message the button was already on
 * rather than replacing it outright: in the `/memories` list that leaves
 * the (now-stale) numbered list visible above the note, which is fine —
 * its buttons are already gone (`components: []`) and a fresh `/memories`
 * is one command away; in a DM wrap-up it means the player still sees the
 * AI's actual reply text, just with the outcome appended, instead of
 * having their conversation replaced by a bare confirmation. One handler,
 * one message shape, works in a guild channel or a DM alike — the whole
 * point of resolving ownership from the memory's own `playerId` (see
 * MemoryService.deleteOwn) instead of `interaction.guildId`, which DMs
 * don't have.
 */
export async function handleMemoryDeleteButton(interaction: ButtonInteraction, ctx: AppContext): Promise<void> {
  const memoryId = parseMemoryDeleteCustomId(interaction.customId);
  if (memoryId === null) {
    await interaction.followUp({ content: "This button isn't recognized anymore.", ephemeral: true });
    return;
  }

  try {
    const result = await ctx.services.memories.deleteOwn({ discordUserId: interaction.user.id, memoryId });
    const original = interaction.message?.content ?? "";
    const note = result === "deleted" ? "\n\n-# 🗑️ Forgotten." : "\n\n-# That one's already gone.";

    await interaction.update({ content: `${original}${note}`, components: [] });

    ctx.logger.info({ event: "memory.delete", memoryId, result }, "Memory delete handled");
  } catch (err) {
    ctx.logger.error(
      { event: "memory.delete.failed", memoryId, err: err instanceof Error ? err.message : String(err) },
      "Memory delete handler threw",
    );
    await interaction.followUp({ content: "Something went wrong. Please try again.", ephemeral: true }).catch(() => undefined);
  }
}
