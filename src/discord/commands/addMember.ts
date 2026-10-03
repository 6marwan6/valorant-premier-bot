import { SlashCommandBuilder } from "discord.js";
import type { Command } from "./types.js";
import { requireAdminWithConfig } from "../commandGuards.js";
import { parseCommaSeparatedList } from "../../modules/players/playerValidation.js";
import { BANTER_STYLE_CHOICES, type BanterStyle } from "../../modules/ai/mariPersona.js";
import type { PlayerProfileFields } from "../../database/repositories/playerRepository.js";

/**
 * /add-member — registers a server member who is NOT a Premier player
 * (2026-10-03, owner's request; docs/Plan_Amendment_Weekly_Schedule.md).
 *
 * A member gets the same kind of profile a player does, so everything Mari
 * does for a person works for them: server chat (`/mari`, `@Mari`), DM chat,
 * voice, memories and retrieval, AI settings (roast intensity, banter style)
 * and protected topics (plan sections 9 and 10 — the privacy filtering is
 * identical). What they don't get is anything Premier: no role or agents, no
 * place on the roster, no weekly-schedule votes, no match attendance, no
 * reminders, hype or recaps.
 *
 * Admin only, like /add-player (plan sections 41/55). To make a member a
 * Premier player later, run /add-player for them — it keeps their memories
 * and AI settings.
 */
const data = new SlashCommandBuilder()
  .setName("add-member")
  .setDescription("Register a server member who isn't a Premier player (Mari chat and memory, no Premier). Admin only.")
  .setDMPermission(false)
  .addUserOption((opt) => opt.setName("member").setDescription("The Discord user to register").setRequired(true))
  .addIntegerOption((opt) =>
    opt
      .setName("roast_intensity")
      .setDescription("0-100, defaults to this server's configured default")
      .setMinValue(0)
      .setMaxValue(100)
      .setRequired(false),
  )
  .addStringOption((opt) =>
    opt
      .setName("banter_style")
      .setDescription("How Mari talks to them")
      .setRequired(false)
      .addChoices(...BANTER_STYLE_CHOICES.map((c) => ({ name: c.name, value: c.value }))),
  )
  .addStringOption((opt) =>
    opt.setName("protected_topics").setDescription('Subjects Mari must never joke about, comma-separated (e.g. "Family, Health")').setRequired(false),
  );

const addMemberCommand: Command = {
  data,
  async execute(interaction, ctx) {
    const guard = await requireAdminWithConfig(interaction, ctx);
    if (!guard) return;

    const target = interaction.options.getUser("member", true);
    if (target.bot) {
      await interaction.reply({ content: "❌ Bots can't be registered.", ephemeral: true });
      return;
    }
    const roastIntensity = interaction.options.getInteger("roast_intensity");
    const banterStyle = interaction.options.getString("banter_style") as BanterStyle | null;
    const topicsRaw = interaction.options.getString("protected_topics");

    let protectedTopics: string[] | undefined;
    if (topicsRaw !== null) {
      const parsed = parseCommaSeparatedList(topicsRaw, "protected topic");
      if (!parsed.ok) {
        await interaction.reply({ content: `❌ ${parsed.error}`, ephemeral: true });
        return;
      }
      protectedTopics = parsed.values;
    }

    const existing = await ctx.repositories.players.getByDiscordUserId(guard.guildId, target.id);

    // Never silently strip someone's Premier status: an active player has to be removed first.
    if (existing?.active && existing.kind === "PLAYER") {
      await interaction.reply({
        content: `❌ <@${target.id}> is an active Premier player. Run \`/remove-player\` first if they should become a plain member.`,
        ephemeral: true,
      });
      return;
    }

    let created = false;
    let player;
    if (!existing) {
      player = await ctx.repositories.players.createMember(guard.guildId, target.id, {
        displayName: target.displayName,
        roastIntensity: roastIntensity ?? guard.config.defaultRoastIntensity,
        ...(banterStyle ? { banterStyle } : {}),
        ...(protectedTopics ? { protectedTopics } : {}),
      });
      created = true;
    } else {
      // An existing member (re-add / edit) or a removed profile: keep its AI settings and memories, change only what was passed.
      const updates: Partial<PlayerProfileFields> = { kind: "MEMBER", active: true, displayName: target.displayName };
      if (roastIntensity !== null) updates.roastIntensity = roastIntensity;
      if (banterStyle !== null) updates.banterStyle = banterStyle;
      if (protectedTopics) updates.protectedTopics = protectedTopics;
      // A removed player turned member loses the Valorant profile fields that no longer apply.
      if (existing.kind === "PLAYER") Object.assign(updates, { role: null, agents: [], preferredAgent: null });
      player = await ctx.repositories.players.update(guard.guildId, target.id, updates);
    }
    if (!player) {
      await interaction.reply({ content: "Something went wrong saving that profile. Please try again.", ephemeral: true });
      return;
    }

    ctx.logger.info(
      { event: created ? "member.added" : "member.updated", guildId: guard.guildId, discordUserId: target.id },
      created ? "Server member added" : "Server member updated",
    );
    const lines = [
      `${created ? "✅ **Added**" : "✅ **Updated**"} <@${target.id}> as a **server member** (not a Premier player).`,
      "• Can: chat with Mari, use memories, DM, voice.",
      "• Can't: vote on the schedule, answer match attendance, get Premier reminders or recaps.",
      `• Roast intensity: ${player.roastIntensity}`,
      `• Banter style: ${player.banterStyle}`,
      `• Protected topics: ${player.protectedTopics.join(", ") || "_none_"}`,
    ];
    await interaction.reply({ content: lines.join("\n"), ephemeral: true });
  },
};

export default addMemberCommand;
