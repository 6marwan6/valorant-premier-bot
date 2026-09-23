import type { ChatInputCommandInteraction } from "discord.js";
import type { AppContext } from "../appContext.js";
import type { ServerConfigRow } from "../database/schema/serverConfig.js";
import { checkAdminFromInteraction, NOT_ADMIN_MESSAGE } from "./permissions.js";

/**
 * Shared precondition for every admin-only match command (plan section 55:
 * "Permission checks before every privileged command"). Unlike /setup —
 * which is the one command allowed to run before any config exists —
 * every match command needs the guild's server_config row anyway (for
 * admin_role_id and, for create/edit, the timezone), so this fetches it
 * once and both gates access and hands back the config for the caller to
 * use.
 *
 * Replies to the interaction itself on failure (guild-only / not-admin /
 * no-config-yet) and returns null; callers just do:
 *
 *   const guard = await requireAdminWithConfig(interaction, ctx);
 *   if (!guard) return;
 */
export async function requireAdminWithConfig(
  interaction: ChatInputCommandInteraction,
  ctx: AppContext,
): Promise<{ guildId: string; config: ServerConfigRow } | null> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
    return null;
  }

  const config = await ctx.repositories.serverConfig.getByGuildId(guildId);

  if (!checkAdminFromInteraction(interaction, config?.adminRoleId)) {
    await interaction.reply({ content: NOT_ADMIN_MESSAGE, ephemeral: true });
    return null;
  }

  if (!config) {
    await interaction.reply({
      content: "Run `/setup` first so I know this server's timezone, match channel, and admin role.",
      ephemeral: true,
    });
    return null;
  }

  return { guildId, config };
}
