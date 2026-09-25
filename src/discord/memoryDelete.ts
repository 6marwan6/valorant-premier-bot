import type { ButtonInteraction } from "discord.js";
import type { AppContext } from "../appContext.js";
import { parseMemoryDeleteCustomId } from "../modules/memories/memoryManageCustomId.js";

/**
 * The 🗑️ delete buttons under `/memories` (plan sections 42/43). Routed
 * from dispatchButton.ts like every other button.
 *
 * Replaces the whole ephemeral list with a plain confirmation rather than
 * surgically editing out just the deleted line: the other buttons still on
 * that message are numbered against the *original* list (see
 * commands/memories.ts), so leaving them in place after one entry is gone
 * would point at the wrong memories. Pointing the player back at a fresh
 * `/memories` is simpler and can't go stale.
 */
export async function handleMemoryDeleteButton(interaction: ButtonInteraction, ctx: AppContext): Promise<void> {
  const memoryId = parseMemoryDeleteCustomId(interaction.customId);
  const guildId = interaction.guildId;
  if (memoryId === null || !guildId) {
    await interaction.followUp({ content: "This button isn't recognized anymore.", ephemeral: true });
    return;
  }

  try {
    const result = await ctx.services.memories.deleteOwn({ guildId, discordUserId: interaction.user.id, memoryId });

    await interaction.update({
      content:
        result === "deleted"
          ? "🗑️ Forgotten. Run `/memories` again to see the updated list."
          : "That one's already gone.",
      components: [],
    });

    ctx.logger.info({ event: "memory.delete", memoryId, guildId, result }, "Memory delete handled");
  } catch (err) {
    ctx.logger.error(
      { event: "memory.delete.failed", memoryId, err: err instanceof Error ? err.message : String(err) },
      "Memory delete handler threw",
    );
    await interaction.followUp({ content: "Something went wrong. Please try again.", ephemeral: true }).catch(() => undefined);
  }
}
