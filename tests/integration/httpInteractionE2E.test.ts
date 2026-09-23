import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { InteractionType, InteractionResponseType, ApplicationCommandOptionType } from "discord-api-types/v10";
import { createDatabase, type Database } from "../../src/database/client.js";
import { buildAppContext, type AppContext } from "../../src/appContext.js";
import type { DiscordRestClient, ReplyPayload } from "../../src/discord/discordRest.js";
import { handleDiscordInteraction } from "../../src/discord/handleDiscordInteraction.js";
import { logger } from "../../src/config/logger.js";

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

/** Real Ed25519 signing, matching Discord's actual scheme — see tests/unit/verifyInteraction.test.ts. */
function makeKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  const publicKeyHex = spki.subarray(spki.length - 32).toString("hex");
  return {
    publicKeyHex,
    sign(body: string, timestamp: string) {
      const message = Buffer.concat([Buffer.from(timestamp, "utf8"), Buffer.from(body, "utf8")]);
      return crypto.sign(null, message, privateKey).toString("hex");
    },
  };
}

function fakeDiscordRestClient() {
  const messages = new Map<string, ReplyPayload>();
  const followups: ReplyPayload[] = [];
  const originalEdits: ReplyPayload[] = [];
  let nextId = 1;

  return {
    discord: {
      sendChannelMessage: vi.fn(async (_channelId: string, payload: ReplyPayload) => {
        const id = `msg-${nextId++}`;
        messages.set(id, payload);
        return { id };
      }),
      editChannelMessage: vi.fn(async (_channelId: string, messageId: string, payload: ReplyPayload) => {
        messages.set(messageId, payload);
      }),
      editOriginalInteractionResponse: vi.fn(async (_token: string, payload: ReplyPayload) => {
        originalEdits.push(payload);
      }),
      sendInteractionFollowup: vi.fn(async (_token: string, payload: ReplyPayload) => {
        followups.push(payload);
      }),
    } as unknown as DiscordRestClient,
    messages,
    followups,
    originalEdits,
  };
}

describeIfDb("handleDiscordInteraction — full HTTP flow (integration)", () => {
  let db: Database;
  let pool: Pool;
  const keypair = makeKeypair();
  const guildId = `http-e2e-guild-${Date.now()}`;

  function buildCtx(fakeDiscord: ReturnType<typeof fakeDiscordRestClient>): AppContext {
    return buildAppContext({ discord: fakeDiscord.discord, db, env: {} as any, logger });
  }

  function fakeRequest(body: object) {
    const rawBody = JSON.stringify(body);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = keypair.sign(rawBody, timestamp);
    return { rawBody, signature, timestamp };
  }

  beforeAll(async () => {
    ({ db, pool } = createDatabase({ DATABASE_URL: databaseUrl! }));
    const { ServerConfigRepository } = await import(
      "../../src/database/repositories/serverConfigRepository.js"
    );
    await new ServerConfigRepository(db).upsert(guildId, {
      timezone: "Europe/Berlin",
      matchChannelId: "chan-1",
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("answers Discord's PING handshake without needing a valid ctx at all", async () => {
    const { rawBody, signature, timestamp } = fakeRequest({ type: InteractionType.Ping });
    const responses: Array<{ status: number; body: unknown }> = [];

    await handleDiscordInteraction({
      rawBody,
      signature,
      timestamp,
      publicKey: keypair.publicKeyHex,
      buildCtx: () => {
        throw new Error("buildCtx should never be called for a PING");
      },
      sendInitialResponse: (status, body) => responses.push({ status, body }),
    });

    expect(responses).toEqual([{ status: 200, body: { type: InteractionResponseType.Pong } }]);
  });

  it("rejects a request with an invalid signature before touching the database", async () => {
    const rawBody = JSON.stringify({ type: InteractionType.Ping });
    const responses: Array<{ status: number; body: unknown }> = [];

    await handleDiscordInteraction({
      rawBody,
      signature: "0".repeat(128), // well-formed hex, wrong signature
      timestamp: String(Math.floor(Date.now() / 1000)),
      publicKey: keypair.publicKeyHex,
      buildCtx: () => {
        throw new Error("buildCtx should never be called for an invalid signature");
      },
      sendInitialResponse: (status, body) => responses.push({ status, body }),
    });

    expect(responses).toEqual([{ status: 401, body: { error: "invalid request signature" } }]);
  });

  it("a valid /list-matches command: defers ephemeral immediately, then delivers real content via editOriginalInteractionResponse", async () => {
    const fakeDiscord = fakeDiscordRestClient();
    const { rawBody, signature, timestamp } = fakeRequest({
      type: InteractionType.ApplicationCommand,
      guild_id: guildId,
      token: "interaction-token-abc",
      member: {
        roles: [],
        permissions: String(1 << 3), // Administrator
        user: { id: "admin-1", username: "admin", global_name: "Admin" },
      },
      data: { name: "list-matches", options: [] },
    });

    const responses: Array<{ status: number; body: unknown }> = [];
    await handleDiscordInteraction({
      rawBody,
      signature,
      timestamp,
      publicKey: keypair.publicKeyHex,
      buildCtx: () => buildCtx(fakeDiscord),
      sendInitialResponse: (status, body) => responses.push({ status, body }),
    });

    // The deferred ack was sent first, synchronously, before any DB work.
    expect(responses).toEqual([
      {
        status: 200,
        body: { type: InteractionResponseType.DeferredChannelMessageWithSource, data: { flags: 64 } },
      },
    ]);
    // Then the real content followed via the followup-edit path.
    expect(fakeDiscord.originalEdits).toHaveLength(1);
    expect(fakeDiscord.originalEdits[0]!.content).toMatch(/No matches scheduled yet|#/);
  });

  it("a valid button click: defers as message-update, then edits @original with the refreshed roster", async () => {
    const fakeDiscord = fakeDiscordRestClient();
    const ctx = buildCtx(fakeDiscord);

    // Seed a real, postable match directly through the service layer.
    const created = await ctx.services.matches.createMatch({
      guildId,
      opponent: "Team HTTP Flow",
      dateStr: "25/12/2026",
      timeStr: "19:00",
    });
    if (!created.ok) throw new Error("fixture setup failed");
    const opened = await ctx.services.attendance.prepareAnnouncement(guildId, created.value.id);
    if (!opened.ok) throw new Error("fixture setup failed");
    await ctx.services.attendance.recordAnnouncement(created.value.id, "chan-1", "msg-1");

    const { rawBody, signature, timestamp } = fakeRequest({
      type: InteractionType.MessageComponent,
      guild_id: guildId,
      token: "interaction-token-xyz",
      member: {
        roles: [],
        permissions: "0",
        user: { id: "player-1", username: "ahmed", global_name: "Ahmed" },
      },
      data: { custom_id: `attendance:${created.value.id}:PLAYING`, component_type: 2 },
    });

    const responses: Array<{ status: number; body: unknown }> = [];
    await handleDiscordInteraction({
      rawBody,
      signature,
      timestamp,
      publicKey: keypair.publicKeyHex,
      buildCtx: () => ctx,
      sendInitialResponse: (status, body) => responses.push({ status, body }),
    });

    expect(responses).toEqual([
      { status: 200, body: { type: InteractionResponseType.DeferredMessageUpdate } },
    ]);
    expect(fakeDiscord.originalEdits).toHaveLength(1);
    expect(fakeDiscord.originalEdits[0]!.content).toContain("Ahmed");
    expect(fakeDiscord.followups).toHaveLength(0); // success path never sends a separate followup

    const withAttendance = await ctx.services.attendance.getMatchWithAttendance(guildId, created.value.id);
    expect(withAttendance?.attendanceRows).toHaveLength(1);
  });

  it("command option types (string/integer) survive the full raw-payload round trip correctly", async () => {
    const fakeDiscord = fakeDiscordRestClient();
    const { rawBody, signature, timestamp } = fakeRequest({
      type: InteractionType.ApplicationCommand,
      guild_id: guildId,
      token: "interaction-token-create",
      member: {
        roles: [],
        permissions: String(1 << 3),
        user: { id: "admin-2", username: "admin2", global_name: "Admin2" },
      },
      data: {
        name: "create-match",
        options: [
          { name: "opponent", type: ApplicationCommandOptionType.String, value: "Team RawPayload" },
          { name: "date", type: ApplicationCommandOptionType.String, value: "26/12/2026" },
          { name: "time", type: ApplicationCommandOptionType.String, value: "20:00" },
        ],
      },
    });

    await handleDiscordInteraction({
      rawBody,
      signature,
      timestamp,
      publicKey: keypair.publicKeyHex,
      buildCtx: () => buildCtx(fakeDiscord),
      sendInitialResponse: () => undefined,
    });

    expect(fakeDiscord.originalEdits[0]!.content).toMatch(/Match #\d+ created/);
    expect(fakeDiscord.originalEdits[0]!.content).toContain("Team RawPayload");

    const list = await buildCtx(fakeDiscord).services.matches.listMatches(guildId);
    expect(list.some((m) => m.opponent === "Team RawPayload")).toBe(true);
  });
});
