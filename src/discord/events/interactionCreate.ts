import { Events, type Client } from "discord.js";
import type { AppContext } from "../../appContext.js";
import { dispatchCommand } from "../interactions/dispatchCommand.js";

/**
 * Single entry point for all Discord interactions. Currently only branches
 * on chat-input (slash) commands; Phase 3 adds an isButton() branch here for
 * attendance buttons (plan section 15).
 */
export function registerInteractionCreateEvent(client: Client, ctx: AppContext): void {
  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isChatInputCommand()) {
      await dispatchCommand(interaction, ctx);
      return;
    }
    // Buttons, select menus, modals: handled starting Phase 3.
  });
}
