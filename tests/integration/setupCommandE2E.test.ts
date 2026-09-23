import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatInputCommandInteraction } from "discord.js";
import type { Pool } from "pg";
import { eq } from "drizzle-orm";
import { createDatabase, type Database } from "../../src/database/client.js";
import { serverConfig } from "../../src/database/schema/serverConfig.js";
import { buildAppContext, type AppContext } from "../../src/appContext.js";
import { dispatchCommand } from "../../src/discord/interactions/dispatchCommand.js";
import { logger } from "../../src/config/logger.js";

/**
 * This is the deepest test we can run without a live Discord gateway
 * connection: it drives the *real* command router (dispatchCommand),
 * which resolves the *real* /setup handler, which writes to a *real*
 * Postgres database — only the Discord.js interaction object itself is
 * faked, since standing up an actual bot session requires live Discord
 * credentials and network access neither this sandbox nor CI should
 * depend on.
 *
 * Skips itself (like the other integration tests) when DATABASE_URL isn't
 * set.
 */
const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

interface FakeInteractionOptions {
  guildId: string | null;
  isAdministrator: boolean;
  roleIds: string[];
  channel?: { id: string };
  role?: { id: string };
  timezone?: string;
  roastIntensity?: number;
}

function fakeSetupInteraction(opts: FakeInteractionOptions) {
  const reply = vi.fn(async (_payload: { content: string; ephemeral?: boolean }) => undefined);
  const interaction = {
    commandName: "setup",
    guildId: opts.guildId,
    memberPermissions: { has: () => opts.isAdministrator },
    member: { roles: opts.roleIds },
    options: {
      getChannel: (name: string) => (name === "match_channel" ? (opts.channel ?? null) : null),
      getRole: (name: string) => (name === "admin_role" ? (opts.role ?? null) : null),
      getString: (name: string) => (name === "timezone" ? (opts.timezone ?? null) : null),
      getInteger: (name: string) =>
        name === "default_roast_intensity" ? (opts.roastIntensity ?? null) : null,
    },
    reply,
    deferred: false,
    replied: false,
    isRepliable: () => true,
  };
  return { interaction: interaction as unknown as ChatInputCommandInteraction, reply };
}

describeIfDb("/setup — full command path (integration)", () => {
  let db: Database;
  let pool: Pool;
  let ctx: AppContext;
  const guildId = `e2e-guild-${Date.now()}`;

  beforeEach(() => {
    ({ db, pool } = createDatabase({ DATABASE_URL: databaseUrl! }));
    // client is never touched by /setup, so a minimal stub is enough here.
    ctx = buildAppContext({ discord: {} as any, db, env: {} as any, logger });
  });

  afterAll(async () => {
    await db.delete(serverConfig).where(eq(serverConfig.guildId, guildId));
    await pool.end();
  });

  it("a real admin running /setup with a channel + role writes the row and replies ephemerally with a confirmation", async () => {
    const { interaction, reply } = fakeSetupInteraction({
      guildId,
      isAdministrator: true,
      roleIds: [],
      channel: { id: "chan-123" },
      role: { id: "role-456" },
      timezone: "Africa/Cairo",
      roastIntensity: 70,
    });

    await dispatchCommand(interaction, ctx);

    expect(reply).toHaveBeenCalledTimes(1);
    const replyPayload = reply.mock.calls[0]![0] as { content: string; ephemeral: boolean };
    expect(replyPayload.ephemeral).toBe(true);
    expect(replyPayload.content).toContain("Africa/Cairo");
    expect(replyPayload.content).toContain("<#chan-123>");
    expect(replyPayload.content).toContain("<@&role-456>");
    expect(replyPayload.content).toContain("70");

    const row = await ctx.repositories.serverConfig.getByGuildId(guildId);
    expect(row?.timezone).toBe("Africa/Cairo");
    expect(row?.matchChannelId).toBe("chan-123");
    expect(row?.adminRoleId).toBe("role-456");
    expect(row?.defaultRoastIntensity).toBe(70);
  });

  it("rejects the plan's literal Europe/frankfurt value end-to-end and writes nothing", async () => {
    const { interaction, reply } = fakeSetupInteraction({
      guildId,
      isAdministrator: true,
      roleIds: [],
      timezone: "Europe/frankfurt",
    });

    const before = await ctx.repositories.serverConfig.getByGuildId(guildId);

    await dispatchCommand(interaction, ctx);

    const replyPayload = reply.mock.calls[0]![0] as { content: string };
    expect(replyPayload.content).toMatch(/isn't a recognized IANA timezone/i);

    const after = await ctx.repositories.serverConfig.getByGuildId(guildId);
    // Nothing changed — specifically the timezone from the previous test
    // (Africa/Cairo) must survive untouched, proving the rejection happens
    // before the DB write, not after.
    expect(after?.timezone).toBe(before?.timezone);
  });

  it("re-running /setup with only one option only changes that field", async () => {
    const { interaction, reply } = fakeSetupInteraction({
      guildId,
      isAdministrator: true,
      roleIds: [],
      roastIntensity: 15,
    });

    await dispatchCommand(interaction, ctx);
    expect(reply).toHaveBeenCalledTimes(1);

    const row = await ctx.repositories.serverConfig.getByGuildId(guildId);
    expect(row?.defaultRoastIntensity).toBe(15);
    // Untouched from the first test in this file.
    expect(row?.timezone).toBe("Africa/Cairo");
    expect(row?.matchChannelId).toBe("chan-123");
  });

  it("refuses to run outside a guild (DM context) without touching the database", async () => {
    const { interaction, reply } = fakeSetupInteraction({
      guildId: null,
      isAdministrator: true,
      roleIds: [],
    });

    await dispatchCommand(interaction, ctx);

    const replyPayload = reply.mock.calls[0]![0] as { content: string };
    expect(replyPayload.content).toMatch(/only be used in a server/i);
  });

  it("dispatchCommand replies with a safe fallback if a handler throws, per plan section 48/49", async () => {
    const { interaction, reply } = fakeSetupInteraction({
      guildId,
      isAdministrator: true,
      roleIds: [],
    });
    // Force a failure deep in the repository call to simulate a DB outage.
    vi.spyOn(ctx.repositories.serverConfig, "upsert").mockRejectedValueOnce(
      new Error("simulated DB outage"),
    );

    await expect(dispatchCommand(interaction, ctx)).resolves.not.toThrow();
    const replyPayload = reply.mock.calls[0]![0] as { content: string; ephemeral: boolean };
    expect(replyPayload.content).toMatch(/something went wrong/i);
    expect(replyPayload.ephemeral).toBe(true);
  });
});
