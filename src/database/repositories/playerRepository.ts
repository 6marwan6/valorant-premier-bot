import { and, asc, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { players, type PlayerRow, type NewPlayerRow } from "../schema/players.js";

export type PlayerProfileFields = Pick<
  NewPlayerRow,
  | "displayName"
  | "role"
  | "agents"
  | "preferredAgent"
  | "roastIntensity"
  | "personalReferencesEnabled"
  | "runningJokesEnabled"
  | "valorantReferencesEnabled"
  | "matchHistoryReferencesEnabled"
  | "memoryUsageEnabled"
  | "aiFollowUpsEnabled"
  | "protectedTopics"
>;

/**
 * Repository for `players` — plan section 8/9/10 (Phase 5). Mirrors
 * ServerConfigRepository/MatchRepository's shape: typed reads/writes only,
 * no Discord- or command-facing logic (agent-list parsing, choice
 * validation, permission checks all live in
 * modules/players/playerValidation.ts and the command handlers).
 */
export class PlayerRepository {
  constructor(private readonly db: Database) {}

  /** By primary key — used by the DM conversation flow (Phase 7), which only has a `player_id` from `ai_conversations`. */
  async getById(id: number): Promise<PlayerRow | undefined> {
    const rows = await this.db.select().from(players).where(eq(players.id, id)).limit(1);
    return rows[0];
  }

  async getByDiscordUserId(guildId: string, discordUserId: string): Promise<PlayerRow | undefined> {
    const rows = await this.db
      .select()
      .from(players)
      .where(and(eq(players.guildId, guildId), eq(players.discordUserId, discordUserId)))
      .limit(1);
    return rows[0];
  }

  /**
   * /add-player. If this Discord user already has a row for this guild —
   * including one previously soft-removed (plan section 8: re-adding
   * someone who left and came back) — this updates it in place and
   * reactivates it rather than violating the unique
   * (guild_id, discord_user_id) index with a second row. Returns both the
   * row and whether it was a fresh insert, so the command can reply with
   * an accurate "added" vs. "already existed — updated instead" message.
   */
  async upsertByDiscordUserId(
    guildId: string,
    discordUserId: string,
    values: PlayerProfileFields,
  ): Promise<{ player: PlayerRow; created: boolean }> {
    const existing = await this.getByDiscordUserId(guildId, discordUserId);

    if (!existing) {
      const [inserted] = await this.db
        .insert(players)
        .values({ guildId, discordUserId, ...values })
        .returning();
      if (!inserted) throw new Error(`Failed to insert player ${discordUserId} for guild ${guildId}`);
      return { player: inserted, created: true };
    }

    const [updated] = await this.db
      .update(players)
      .set({ ...values, active: true, updatedAt: new Date() })
      .where(eq(players.id, existing.id))
      .returning();
    if (!updated) throw new Error(`Failed to update player ${discordUserId} for guild ${guildId}`);
    return { player: updated, created: false };
  }

  /**
   * /edit-player. Only fields explicitly passed are changed — same
   * partial-update contract as ServerConfigRepository.upsert /
   * MatchRepository.update, so /edit-player can tweak a single setting
   * (e.g. just roast intensity) without resupplying the whole profile.
   */
  async update(
    guildId: string,
    discordUserId: string,
    values: Partial<PlayerProfileFields>,
  ): Promise<PlayerRow | undefined> {
    const [updated] = await this.db
      .update(players)
      .set({ ...values, updatedAt: new Date() })
      .where(and(eq(players.guildId, guildId), eq(players.discordUserId, discordUserId)))
      .returning();
    return updated;
  }

  /**
   * /remove-player. Soft delete — see schema/players.ts's class doc for
   * why this flips `active` rather than issuing a DELETE. Idempotent:
   * removing an already-inactive (or nonexistent) player just returns
   * undefined instead of erroring, matching plan section 50's "a retry
   * must not corrupt data" posture.
   */
  async deactivate(guildId: string, discordUserId: string): Promise<PlayerRow | undefined> {
    const [updated] = await this.db
      .update(players)
      .set({ active: false, updatedAt: new Date() })
      .where(and(eq(players.guildId, guildId), eq(players.discordUserId, discordUserId), eq(players.active, true)))
      .returning();
    return updated;
  }

  /**
   * The team roster — plan section 16's real "No response" section and
   * `Confirmed: X/Y` denominator (README's flagged Phase 5 debt) both
   * need exactly this: every currently-active player in the guild.
   * Ordered by join order (`id`) so the roster reads the same way each
   * time it's rendered, rather than shuffling on every query.
   */
  async listActiveByGuild(guildId: string): Promise<PlayerRow[]> {
    return this.db
      .select()
      .from(players)
      .where(and(eq(players.guildId, guildId), eq(players.active, true)))
      .orderBy(asc(players.id));
  }
}
