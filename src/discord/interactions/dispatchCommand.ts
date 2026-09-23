import type { ChatInputCommandInteraction } from "discord.js";
import type { AppContext } from "../../appContext.js";
import { commandsByName } from "../commands/index.js";

/**
 * Routes a slash-command interaction to its handler.
 *
 * Deliberately does NOT do admin gating here — /setup declares its own
 * setDefaultMemberPermissions and re-checks server-side inside its
 * execute(). Future admin commands (create-match, add-player, ...) will
 * follow the same pattern rather than a blanket "all commands are admin"
 * rule, since plan section 42 lists player-facing commands
 * (/profile, /memories, /ai-settings) that must NOT require admin.
 */
export async function dispatchCommand(
  interaction: ChatInputCommandInteraction,
  ctx: AppContext,
): Promise<void> {
  const command = commandsByName.get(interaction.commandName);

  if (!command) {
    ctx.logger.warn(
      { event: "command.unknown", commandName: interaction.commandName },
      "Received interaction for unregistered command",
    );
    if (interaction.isRepliable()) {
      await interaction.reply({ content: "Unknown command.", ephemeral: true });
    }
    return;
  }

  const startedAt = Date.now();
  try {
    await command.execute(interaction, ctx);
    ctx.logger.info(
      {
        event: "command.success",
        commandName: interaction.commandName,
        guildId: interaction.guildId,
        latencyMs: Date.now() - startedAt,
      },
      "Command handled",
    );
  } catch (err) {
    // drizzle-orm 0.45.x wraps driver errors: err.message is a generic
    // "Failed query: ..."; the actual DB error (constraint name, Postgres
    // error code) lives on err.cause. Log both so failures stay debuggable
    // — see tests/integration/matchRepository.test.ts for the concrete
    // shape this was discovered against.
    const cause = err instanceof Error && "cause" in err ? (err as { cause?: unknown }).cause : undefined;
    ctx.logger.error(
      {
        event: "command.failed",
        commandName: interaction.commandName,
        guildId: interaction.guildId,
        latencyMs: Date.now() - startedAt,
        err: err instanceof Error ? err.message : String(err),
        cause: cause instanceof Error ? cause.message : undefined,
      },
      "Command handler threw",
    );

    // Plan section 48/49: fail safe, never leave the user without a
    // response, and never imply a state change happened when it didn't.
    const failureMessage = "Something went wrong running that command. Please try again.";
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: failureMessage }).catch(() => undefined);
    } else if (interaction.isRepliable()) {
      await interaction.reply({ content: failureMessage, ephemeral: true }).catch(() => undefined);
    }
  }
}

// Phase 3 will add a sibling dispatchButton(interaction, ctx) here for
// attendance buttons (plan section 15), and interactionCreate.ts will
// branch on interaction.isChatInputCommand() / interaction.isButton().
