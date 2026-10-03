import { EmbedBuilder, escapeMarkdown } from "discord.js";
import type { AttendanceRow } from "../../database/schema/attendance.js";
import type { MatchRow } from "../../database/schema/matches.js";

type Status = AttendanceRow["status"];

/** The profile facts the cards decorate with (plan section 8 — deterministic data; a `PlayerRow` satisfies this as-is). */
export interface CardPlayer {
  discordUserId: string;
  displayName: string;
  role?: "DUELIST" | "INITIATOR" | "CONTROLLER" | "SENTINEL" | null;
  preferredAgent?: string | null;
}

const DESCRIPTION_LIMIT = 4000; // Discord allows 4096

const LOOK: Record<Status, { color: number; title: string }> = {
  PLAYING: { color: 0x3bd671, title: "🟢  LOCKED IN" },
  CANNOT_PLAY: { color: 0xff4655, title: "🔴  MAN DOWN" },
  WANTS_TO_BUT_CANNOT: { color: 0xf5a623, title: "🟡  BENCHED BY LIFE" },
};

const ROLE_LABEL: Record<NonNullable<CardPlayer["role"]>, string> = {
  DUELIST: "⚔️ Duelist",
  INITIATOR: "🔎 Initiator",
  CONTROLLER: "☁️ Controller",
  SENTINEL: "🛡️ Sentinel",
};

const SQUARE: Record<Status | "PENDING", string> = {
  PLAYING: "🟩",
  WANTS_TO_BUT_CANNOT: "🟨",
  CANNOT_PLAY: "🟥",
  PENDING: "⬛",
};

/**
 * `🟩🟩🟨⬛⬛⬛` for the roster as it stands — one square per active player
 * (greens, then yellows, then reds, then undecided), same bar the roster
 * message draws so the two read as one UI. Pure counting over attendance
 * rows; the model never touches it.
 */
export function squadBar(attendanceRows: AttendanceRow[], rosterSize: number): string {
  const count = (s: Status) => attendanceRows.filter((r) => r.status === s).length;
  const squares = [
    ...Array<string>(count("PLAYING")).fill(SQUARE.PLAYING),
    ...Array<string>(count("WANTS_TO_BUT_CANNOT")).fill(SQUARE.WANTS_TO_BUT_CANNOT),
    ...Array<string>(count("CANNOT_PLAY")).fill(SQUARE.CANNOT_PLAY),
  ].slice(0, rosterSize);
  while (squares.length < rosterSize) squares.push(SQUARE.PENDING);
  return squares.join("");
}

/**
 * The public reaction to a click (plan sections 18/19/20): the reply text —
 * the LLM's CELEBRATE/ROAST line, or CONSOLE's fixed "can't make it" line —
 * inside a card. Everything that isn't that sentence (title, color, the
 * player's role/agent, the squad tally, the match id) is built by the app
 * from the database, so the personality layer stays the only thing the
 * model writes (plan principle 3, section 14).
 *
 * `avatarUrl` is optional: the HTTP interaction payload carries the clicker's
 * avatar hash, and a missing one just drops the thumbnail.
 */
export function buildReactionCard(params: {
  player: CardPlayer;
  match: MatchRow;
  status: Status;
  text: string;
  attendanceRows: AttendanceRow[];
  rosterSize: number;
  avatarUrl?: string | null;
}): { embeds: EmbedBuilder[] } {
  const { player, match, status, attendanceRows, rosterSize } = params;
  const look = LOOK[status];
  const playing = attendanceRows.filter((r) => r.status === "PLAYING").length;

  const embed = new EmbedBuilder()
    .setColor(look.color)
    .setTitle(look.title)
    .setDescription(params.text.slice(0, DESCRIPTION_LIMIT))
    .setAuthor({ name: player.displayName.slice(0, 256), ...(params.avatarUrl ? { iconURL: params.avatarUrl } : {}) });

  if (params.avatarUrl) embed.setThumbnail(params.avatarUrl);

  const fields: Array<{ name: string; value: string; inline: boolean }> = [];
  if (player.role) fields.push({ name: "Role", value: ROLE_LABEL[player.role], inline: true });
  if (player.preferredAgent) fields.push({ name: "Agent", value: escapeMarkdown(player.preferredAgent), inline: true });
  if (rosterSize > 0) {
    fields.push({ name: "Squad", value: `${squadBar(attendanceRows, rosterSize)}\n**${playing}/${rosterSize}** confirmed`, inline: true });
  }
  if (fields.length > 0) embed.addFields(fields);

  return { embeds: [embed.setFooter({ text: `Match #${match.id}` }).setTimestamp(new Date())] };
}

/**
 * The one-off moment the last active player confirms (every roster player
 * PLAYING): a short, fully deterministic celebration — no LLM, so it can
 * never fail with the AI and never says anything untrue (plan section 14).
 * Lists the lineup from the player profiles (plan section 8).
 */
export function buildFullSquadCard(match: MatchRow, lineup: CardPlayer[], kickoffUnixSeconds: number): { embeds: EmbedBuilder[] } {
  const lines = lineup.map((p) => {
    const role = p.role ? `${ROLE_LABEL[p.role].split(" ")[0]} ` : "";
    const agent = p.preferredAgent ? ` · ${escapeMarkdown(p.preferredAgent)}` : "";
    return `${role}**${escapeMarkdown(p.displayName)}**${agent}`;
  });
  const embed = new EmbedBuilder()
    .setColor(0x3bd671)
    .setTitle("🔥  FULL SQUAD LOCKED IN")
    .setDescription(`${SQUARE.PLAYING.repeat(lineup.length)}  **${lineup.length}/${lineup.length}**\n\n${lines.join("\n")}\n\n⏳ Kickoff <t:${kickoffUnixSeconds}:R>\n**Everyone's in. Let's cook.**`.slice(0, DESCRIPTION_LIMIT))
    .setFooter({ text: `Match #${match.id}` })
    .setTimestamp(new Date());
  return { embeds: [embed] };
}
