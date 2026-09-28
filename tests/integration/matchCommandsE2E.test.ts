import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChatInputCommandInteraction } from "discord.js";
import type { Pool } from "pg";
import { createDatabase, type Database } from "../../src/database/client.js";
import { buildAppContext, type AppContext } from "../../src/appContext.js";
import { dispatchCommand } from "../../src/discord/interactions/dispatchCommand.js";
import { logger } from "../../src/config/logger.js";
import type { MatchRow } from "../../src/database/schema/matches.js";

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

type OptionValues = Record<string, string | number | undefined>;

function fakeInteraction(commandName: string, guildId: string | null, options: OptionValues) {
  const reply = vi.fn(async (_payload: { content: string; ephemeral?: boolean }) => undefined);
  const interaction = {
    commandName,
    guildId,
    memberPermissions: { has: () => true }, // native admin throughout — permission gating is covered separately in tests/unit/permissions.test.ts
    member: { roles: [] as string[] },
    options: {
      getString: (name: string, required?: boolean) => {
        const v = options[name];
        if (v === undefined) {
          if (required) throw new Error(`missing required string option ${name}`);
          return null;
        }
        return String(v);
      },
      getInteger: (name: string, required?: boolean) => {
        const v = options[name];
        if (v === undefined) {
          if (required) throw new Error(`missing required integer option ${name}`);
          return null;
        }
        return Number(v);
      },
    },
    reply,
    deferred: false,
    replied: false,
    isRepliable: () => true,
  };
  return { interaction: interaction as unknown as ChatInputCommandInteraction, reply };
}

describeIfDb("match commands — full command path (integration)", () => {
  let db: Database;
  let pool: Pool;
  let ctx: AppContext;
  const guildId = `match-e2e-guild-${Date.now()}`;

  beforeAll(async () => {
    ({ db, pool } = createDatabase({ DATABASE_URL: databaseUrl! }));
    ctx = buildAppContext({ discord: {} as any, db, env: {} as any, logger });
    // Match commands require /setup to have run first (requireAdminWithConfig).
    await ctx.repositories.serverConfig.upsert(guildId, { timezone: "Europe/Berlin" });
  });

  afterAll(async () => {
    await pool.end();
  });

  /** No `opponent` to key a freshly-created match on anymore — diff the list before/after instead of hand-computing the exact UTC instant a local date/time + timezone resolves to. */
  async function createMatchAndFind(date: string, time: string): Promise<MatchRow> {
    const before = await ctx.services.matches.listMatches(guildId);
    const beforeIds = new Set(before.map((m) => m.id));
    await dispatchCommand(fakeInteraction("create-match", guildId, { date, time }).interaction, ctx);
    const after = await ctx.services.matches.listMatches(guildId);
    return after.find((m) => !beforeIds.has(m.id))!;
  }

  it("/create-match creates a match end-to-end and replies with its number", async () => {
    const before = await ctx.services.matches.listMatches(guildId);
    const beforeIds = new Set(before.map((m) => m.id));
    const { interaction, reply } = fakeInteraction("create-match", guildId, { date: "18/09/2026", time: "19:00" });

    await dispatchCommand(interaction, ctx);

    expect(reply).toHaveBeenCalledTimes(1);
    const payload = reply.mock.calls[0]![0] as { content: string };
    expect(payload.content).toMatch(/Match #\d+ created/);

    const after = await ctx.services.matches.listMatches(guildId);
    expect(after.some((m) => !beforeIds.has(m.id))).toBe(true);
  });

  it("/create-match rejects an exact duplicate with a specific message", async () => {
    await dispatchCommand(fakeInteraction("create-match", guildId, { date: "19/09/2026", time: "20:00" }).interaction, ctx);

    const { interaction, reply } = fakeInteraction("create-match", guildId, { date: "19/09/2026", time: "20:00" });
    await dispatchCommand(interaction, ctx);

    const payload = reply.mock.calls[0]![0] as { content: string };
    expect(payload.content).toMatch(/already scheduled at that exact time/);
  });

  it("/create-match rejects an invalid date with a specific message, writes nothing", async () => {
    const before = await ctx.services.matches.listMatches(guildId);
    const { interaction, reply } = fakeInteraction("create-match", guildId, { date: "31/02/2026", time: "19:00" });
    await dispatchCommand(interaction, ctx);

    const payload = reply.mock.calls[0]![0] as { content: string };
    expect(payload.content).toMatch(/isn't a real date/);

    const after = await ctx.services.matches.listMatches(guildId);
    expect(after.length).toBe(before.length);
  });

  it("/edit-match changes the scheduled time and blocks an edit that would collide", async () => {
    const created = await createMatchAndFind("20/09/2026", "18:00");

    const { interaction, reply } = fakeInteraction("edit-match", guildId, {
      match_id: created.id,
      date: "20/09/2026",
      time: "19:00",
    });
    await dispatchCommand(interaction, ctx);

    const payload = reply.mock.calls[0]![0] as { content: string };
    expect(payload.content).toMatch(/updated/);

    const refetched = (await ctx.services.matches.listMatches(guildId)).find((m) => m.id === created.id)!;
    expect(refetched.scheduledAt.getTime()).not.toBe(created.scheduledAt.getTime());
    expect(refetched.scheduledAt.getTime()).toBe(created.scheduledAt.getTime() + 60 * 60_000); // 18:00 -> 19:00, one hour later
  });

  it("/edit-match rejects supplying only date without time", async () => {
    const created = await createMatchAndFind("21/09/2026", "18:00");

    const { interaction, reply } = fakeInteraction("edit-match", guildId, {
      match_id: created.id,
      date: "22/09/2026",
      // time intentionally omitted
    });
    await dispatchCommand(interaction, ctx);

    const payload = reply.mock.calls[0]![0] as { content: string };
    expect(payload.content).toMatch(/date and time together/);
  });

  it("/cancel-match cancels, then /edit-match and /cancel-match both refuse the cancelled match", async () => {
    const created = await createMatchAndFind("23/09/2026", "18:00");

    const cancel1 = fakeInteraction("cancel-match", guildId, { match_id: created.id });
    await dispatchCommand(cancel1.interaction, ctx);
    expect((cancel1.reply.mock.calls[0]![0] as { content: string }).content).toMatch(/cancelled/);

    const refetched = (await ctx.services.matches.listMatches(guildId)).find((m) => m.id === created.id)!;
    expect(refetched.status).toBe("CANCELLED");

    // Cancelling again must be rejected, not silently succeed twice.
    const cancel2 = fakeInteraction("cancel-match", guildId, { match_id: created.id });
    await dispatchCommand(cancel2.interaction, ctx);
    expect((cancel2.reply.mock.calls[0]![0] as { content: string }).content).toMatch(/already been cancelled/);

    // Editing a cancelled match must also be rejected (plan section 11).
    const editAfterCancel = fakeInteraction("edit-match", guildId, { match_id: created.id, date: "23/09/2026", time: "20:00" });
    await dispatchCommand(editAfterCancel.interaction, ctx);
    expect((editAfterCancel.reply.mock.calls[0]![0] as { content: string }).content).toMatch(/already been cancelled/);
  });

  it("/edit-match and /cancel-match report a clear error for a nonexistent match_id", async () => {
    const edit = fakeInteraction("edit-match", guildId, { match_id: 999999, date: "01/01/2027", time: "12:00" });
    await dispatchCommand(edit.interaction, ctx);
    expect((edit.reply.mock.calls[0]![0] as { content: string }).content).toMatch(/No match #999999 found/);

    const cancel = fakeInteraction("cancel-match", guildId, { match_id: 999999 });
    await dispatchCommand(cancel.interaction, ctx);
    expect((cancel.reply.mock.calls[0]![0] as { content: string }).content).toMatch(/No match #999999 found/);
  });

  it("/list-matches shows everything created above, with cancelled matches still listed (status shown), not hidden", async () => {
    const { interaction, reply } = fakeInteraction("list-matches", guildId, {});
    await dispatchCommand(interaction, ctx);

    const payload = reply.mock.calls[0]![0] as { content: string };
    expect(payload.content).toMatch(/#\d+/);
    expect(payload.content).toMatch(/CANCELLED/);
  });

  it("match commands run outside a guild (DM) are refused before touching the database", async () => {
    const { interaction, reply } = fakeInteraction("create-match", null, { date: "24/09/2026", time: "18:00" });
    await dispatchCommand(interaction, ctx);
    expect((reply.mock.calls[0]![0] as { content: string }).content).toMatch(/only be used in a server/);
  });

  it("match commands refuse a guild that has never run /setup", async () => {
    const freshGuildId = `never-setup-${Date.now()}`;
    const { interaction, reply } = fakeInteraction("create-match", freshGuildId, { date: "24/09/2026", time: "18:00" });
    await dispatchCommand(interaction, ctx);
    expect((reply.mock.calls[0]![0] as { content: string }).content).toMatch(/Run `\/setup` first/);
  });
});
