import { ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder } from "discord.js";
import type { Command } from "./types.js";
import type { MemoryRow, MemoryType } from "../../database/schema/memories.js";
import { buildMemoryDeleteCustomId } from "../../modules/memories/memoryManageCustomId.js";

/** Plan section 43's own worked example groups by category, not creation order; this is that grouping, extended to all nine (section 22) types. */
const CATEGORY_ORDER: MemoryType[] = [
  "RUNNING_JOKE",
  "TEAM_JOKE",
  "VALORANT_PREFERENCE",
  "PLAYER_PREFERENCE",
  "PERSONALITY_TRAIT",
  "HABIT",
  "MATCH_EVENT",
  "ACHIEVEMENT",
  "TEAM_HISTORY",
];

const CATEGORY_LABELS: Record<MemoryType, string> = {
  RUNNING_JOKE: "Running jokes",
  TEAM_JOKE: "Team jokes",
  VALORANT_PREFERENCE: "Valorant",
  PLAYER_PREFERENCE: "Preferences",
  PERSONALITY_TRAIT: "Personality",
  HABIT: "Habits",
  MATCH_EVENT: "Match events",
  ACHIEVEMENT: "Achievements",
  TEAM_HISTORY: "Team history",
};

/** Discord's own component caps (5 action rows per message, 5 buttons per row) — see the row-chunking loop below. */
const MAX_DISPLAYED = 25;

/**
 * /memories — plan sections 42 ("Player Commands": "/memories") and 43
 * ("Memory Management"): a categorized summary of what's been approved
 * about the caller, plus a delete button per entry — the plan's own named
 * alternative to a separate `/memory-delete <id>` command ("or an
 * interactive memory-management flow"), chosen because a player should
 * never have to know or type a raw memory id to forget something about
 * themselves.
 *
 * Self-service and read-only for anyone but the caller's own profile: no
 * admin guard (plan section 42 lists this as an ordinary player command,
 * unlike /player in section 41), and it only ever looks up the *caller's*
 * own player row — there is no id parameter to look up someone else's
 * (plan section 44 rule 4).
 */
const data = new SlashCommandBuilder()
  .setName("memories")
  .setDescription("See what M.A.R.I. remembers about you, and forget anything you'd rather it didn't.")
  .setDMPermission(false);

const memoriesCommand: Command = {
  data,
  async execute(interaction, ctx) {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
      return;
    }

    const player = await ctx.repositories.players.getByDiscordUserId(guildId, interaction.user.id);
    if (!player) {
      await interaction.reply({ content: "You're not on the active roster, so there's nothing to look up.", ephemeral: true });
      return;
    }

    const all = await ctx.repositories.memories.listByPlayer(player.id);
    if (all.length === 0) {
      await interaction.reply({ content: "🧠 I don't have anything remembered about you yet.", ephemeral: true });
      return;
    }

    const shown = all.slice(0, MAX_DISPLAYED);
    const byType = new Map<MemoryType, MemoryRow[]>();
    for (const memory of shown) {
      const bucket = byType.get(memory.type);
      if (bucket) bucket.push(memory);
      else byType.set(memory.type, [memory]);
    }

    const lines = ["🧠 **Your memories**"];
    const buttons: ButtonBuilder[] = [];
    let n = 0;
    for (const type of CATEGORY_ORDER) {
      const bucket = byType.get(type);
      if (!bucket || bucket.length === 0) continue;
      lines.push("", `**${CATEGORY_LABELS[type]}**`);
      for (const memory of bucket) {
        n += 1;
        lines.push(`${n}. ${memory.content}`);
        buttons.push(
          new ButtonBuilder()
            .setCustomId(buildMemoryDeleteCustomId(memory.id))
            .setLabel(String(n))
            .setEmoji("🗑️")
            .setStyle(ButtonStyle.Danger),
        );
      }
    }

    if (all.length > shown.length) {
      lines.push("", `_+${all.length - shown.length} more not shown._`);
    }
    lines.push("", "_Tap a number below to forget that memory._");

    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    for (let i = 0; i < buttons.length; i += 5) {
      rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(i, i + 5)));
    }

    await interaction.reply({ content: lines.join("\n"), components: rows, ephemeral: true });
  },
};

export default memoriesCommand;
