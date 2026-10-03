import type { ButtonInteraction } from "discord.js";

/** The clicker's avatar, when Discord's payload carried a hash (the HTTP adapter passes it through); null drops a card's thumbnail. */
export function avatarUrlOf(interaction: ButtonInteraction): string | null {
  const user = interaction.user as { id: string; avatar?: string | null };
  return user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128` : null;
}
