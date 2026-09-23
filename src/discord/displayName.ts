import type { ButtonInteraction } from "discord.js";

/**
 * Resolves the best available display name for whoever triggered an
 * interaction — server nickname first, then Discord's global display
 * name, then username. `interaction.member` can be either a cached
 * `GuildMember` (with a `.displayName` getter) or a raw API partial (with
 * just a `.nick` field), depending on gateway cache state, so both shapes
 * are handled explicitly rather than assumed.
 */
export function resolveDisplayName(interaction: ButtonInteraction): string {
  const member = interaction.member;
  if (member && typeof member === "object") {
    if ("displayName" in member && typeof member.displayName === "string" && member.displayName) {
      return member.displayName;
    }
    if ("nick" in member && typeof member.nick === "string" && member.nick) {
      return member.nick;
    }
  }
  return interaction.user.globalName ?? interaction.user.username;
}
