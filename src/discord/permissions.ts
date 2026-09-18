import { PermissionFlagsBits } from "discord.js";
import type { ChatInputCommandInteraction, GuildMemberRoleManager } from "discord.js";

/**
 * Admin authorization — plan section 55 "Security":
 *   - Discord user authorization.
 *   - Admin role verification.
 *   - Permission checks before every privileged command.
 *
 * Two independent paths grant admin access, either is sufficient:
 *   1. Native Discord "Administrator" permission on the guild. Discord
 *      itself also enforces this at the command level via
 *      setDefaultMemberPermissions (see commands/setup.ts), but we check it
 *      again here as defense-in-depth — a guild admin can loosen a
 *      command's default permission in Discord's integration settings, so
 *      this app must not rely on that as its only gate (plan section 55).
 *   2. Membership in the configured `admin_role_id` (plan section 53),
 *      which only exists once /setup has been run.
 *
 * This function takes plain values rather than the live interaction object
 * so it can be unit tested with simple fixtures (see
 * tests/unit/permissions.test.ts) without standing up a real Discord
 * client.
 */
export function isAdmin(params: {
  hasAdministratorPermission: boolean;
  memberRoleIds: string[];
  adminRoleId: string | null | undefined;
}): boolean {
  if (params.hasAdministratorPermission) return true;
  if (!params.adminRoleId) return false;
  return params.memberRoleIds.includes(params.adminRoleId);
}

/**
 * Extracts the plain-value inputs isAdmin() needs from a live
 * ChatInputCommandInteraction. Guild-only interactions in discord.js
 * populate interaction.member from the interaction payload itself, so no
 * privileged GUILD_MEMBERS intent is required to read roles here.
 */
export function checkAdminFromInteraction(
  interaction: ChatInputCommandInteraction,
  adminRoleId: string | null | undefined,
): boolean {
  const hasAdministratorPermission =
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;

  const roles = interaction.member?.roles;
  const memberRoleIds = Array.isArray(roles)
    ? roles
    : ((roles as GuildMemberRoleManager | undefined)?.cache?.map((r) => r.id) ?? []);

  return isAdmin({ hasAdministratorPermission, memberRoleIds, adminRoleId });
}

export const NOT_ADMIN_MESSAGE =
  "You need to be a server administrator, or hold the configured admin role, to use this command.";
