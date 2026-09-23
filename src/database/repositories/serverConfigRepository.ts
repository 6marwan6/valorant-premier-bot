import { eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { serverConfig, type ServerConfigRow } from "../schema/serverConfig.js";

/**
 * Repository for the single per-guild configuration row (plan section 53).
 * This is the only piece of "application state" that exists before /setup
 * has been run — everything else (players, matches, attendance...) is
 * introduced in later phases.
 */
export class ServerConfigRepository {
  constructor(private readonly db: Database) {}

  async getByGuildId(guildId: string): Promise<ServerConfigRow | undefined> {
    const rows = await this.db
      .select()
      .from(serverConfig)
      .where(eq(serverConfig.guildId, guildId))
      .limit(1);
    return rows[0];
  }

  /**
   * Every configured guild's row — used by the reminders cron job
   * (services/scheduling/reminderCronJob.ts) to know which guild(s) to
   * reconcile reminders for and which reminder_schedule_minutes to apply.
   * V1 is single-server (plan section 54), so in practice this returns
   * zero or one row; looping over "every configured guild" rather than
   * hardcoding a single guild id is just the natural shape of iterating
   * this table, not a multi-tenancy abstraction.
   */
  async listAll(): Promise<ServerConfigRow[]> {
    return this.db.select().from(serverConfig);
  }

  /**
   * Creates the config row on first /setup, or updates the existing one on
   * subsequent runs. Only fields explicitly passed are changed — undefined
   * fields keep their current (or default) value. This keeps /setup safe to
   * re-run for a single field (e.g. just changing the admin role) without
   * clobbering the rest of the configuration.
   */
  async upsert(
    guildId: string,
    values: Partial<
      Pick<
        ServerConfigRow,
        | "timezone"
        | "matchChannelId"
        | "adminRoleId"
        | "reminderScheduleMinutes"
        | "defaultRoastIntensity"
        | "defaultMemoryPolicy"
      >
    >,
  ): Promise<ServerConfigRow> {
    const existing = await this.getByGuildId(guildId);

    if (!existing) {
      const [inserted] = await this.db
        .insert(serverConfig)
        .values({ guildId, ...values })
        .returning();
      if (!inserted) {
        throw new Error(`Failed to insert server_config for guild ${guildId}`);
      }
      return inserted;
    }

    const [updated] = await this.db
      .update(serverConfig)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(serverConfig.guildId, guildId))
      .returning();
    if (!updated) {
      throw new Error(`Failed to update server_config for guild ${guildId}`);
    }
    return updated;
  }
}
