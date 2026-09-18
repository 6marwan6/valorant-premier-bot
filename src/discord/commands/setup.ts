import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import type { Command } from "./types.js";
import { isValidTimeZone } from "../timezone.js";

/**
 * /setup — plan section 41 "Admin Commands" (listed first) and section 53
 * "Configuration": guild_id, timezone, match_channel_id, admin_role_id,
 * reminder_schedule, default_roast_intensity, default_memory_policy.
 *
 * This is the only command Phase 1 needs to actually do something useful:
 * it writes (or updates) the server_config row that every later phase reads
 * from. Options are optional so /setup can be re-run to tweak a single
 * field (e.g. just the match channel) without resupplying everything.
 *
 * Gated at the Discord level via setDefaultMemberPermissions(Administrator)
 * — before /setup has ever run there is no admin_role_id to check against,
 * so native Discord admin is the only bootstrap path. checkAdminFromInteraction
 * re-verifies this server-side (plan section 55, defense-in-depth).
 */
const data = new SlashCommandBuilder()
  .setName("setup")
  .setDescription("Configure (or reconfigure) this server for the Premier bot. Admin only.")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false)
  .addChannelOption((opt) =>
    opt
      .setName("match_channel")
      .setDescription("Channel where match announcements & attendance messages are posted")
      .addChannelTypes(ChannelType.GuildText)
      .setRequired(false),
  )
  .addRoleOption((opt) =>
    opt
      .setName("admin_role")
      .setDescription("Role allowed to run admin commands (create-match, add-player, ...)")
      .setRequired(false),
  )
  .addStringOption((opt) =>
    opt
      .setName("timezone")
      .setDescription('IANA timezone, e.g. "Europe/Berlin" (plan default; see README)')
      .setRequired(false),
  )
  .addIntegerOption((opt) =>
    opt
      .setName("default_roast_intensity")
      .setDescription("Default roast intensity (0-100) for newly added players")
      .setMinValue(0)
      .setMaxValue(100)
      .setRequired(false),
  );

const setupCommand: Command = {
  data,
  async execute(interaction, ctx) {
    // checkAdminFromInteraction is re-imported lazily-free here via ctx-free
    // helper to keep this file focused; see interactions/dispatchCommand.ts
    // for the shared pre-check that wraps every admin-only command.
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
      return;
    }

    const matchChannel = interaction.options.getChannel("match_channel");
    const adminRole = interaction.options.getRole("admin_role");
    const timezone = interaction.options.getString("timezone");
    const roastIntensity = interaction.options.getInteger("default_roast_intensity");

    if (timezone && !isValidTimeZone(timezone)) {
      await interaction.reply({
        content: `"${timezone}" isn't a recognized IANA timezone (e.g. \`Europe/Berlin\`, \`Africa/Cairo\`). Nothing was changed.`,
        ephemeral: true,
      });
      return;
    }

    const updated = await ctx.repositories.serverConfig.upsert(guildId, {
      ...(matchChannel ? { matchChannelId: matchChannel.id } : {}),
      ...(adminRole ? { adminRoleId: adminRole.id } : {}),
      ...(timezone ? { timezone } : {}),
      ...(roastIntensity !== null ? { defaultRoastIntensity: roastIntensity } : {}),
    });

    ctx.logger.info(
      { event: "setup.updated", guildId },
      "Server configuration updated",
    );

    const lines = [
      "✅ **Server configuration saved.**",
      `• Timezone: \`${updated.timezone}\``,
      `• Match channel: ${updated.matchChannelId ? `<#${updated.matchChannelId}>` : "_not set_"}`,
      `• Admin role: ${updated.adminRoleId ? `<@&${updated.adminRoleId}>` : "_not set (Administrator permission still works)_"}`,
      `• Default roast intensity: ${updated.defaultRoastIntensity}`,
    ];

    await interaction.reply({ content: lines.join("\n"), ephemeral: true });
  },
};

export default setupCommand;
