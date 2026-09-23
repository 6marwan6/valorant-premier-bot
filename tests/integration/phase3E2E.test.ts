import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChatInputCommandInteraction, ButtonInteraction } from "discord.js";
import type { Pool } from "pg";
import { createDatabase, type Database } from "../../src/database/client.js";
import { buildAppContext, type AppContext } from "../../src/appContext.js";
import type { DiscordRestClient, ReplyPayload } from "../../src/discord/discordRest.js";
import { dispatchCommand } from "../../src/discord/interactions/dispatchCommand.js";
import { dispatchButton } from "../../src/discord/interactions/dispatchButton.js";
import { logger } from "../../src/config/logger.js";

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

/**
 * Fakes DiscordRestClient's flat method surface (plan Phase 3's hosting
 * migration replaced the old gateway-Client channel/message objects with
 * pure REST calls — see src/discord/discordRest.ts). Tracks sent/edited
 * message state in a Map keyed by message id, so "did /cancel-match
 * actually push the CANCELLED content to the right message" is a real
 * assertion against that state, not just a spy call count.
 */
function fakeDiscordRestClient() {
  const messages = new Map<string, ReplyPayload>();
  let nextId = 1;

  const sendChannelMessage = vi.fn(async (_channelId: string, payload: ReplyPayload) => {
    const id = `msg-${nextId++}`;
    messages.set(id, payload);
    return { id };
  });

  const editChannelMessage = vi.fn(async (_channelId: string, messageId: string, payload: ReplyPayload) => {
    if (!messages.has(messageId)) throw new Error("message not found");
    messages.set(messageId, payload);
  });

  return {
    discord: { sendChannelMessage, editChannelMessage } as unknown as DiscordRestClient,
    sendChannelMessage,
    editChannelMessage,
    messages,
  };
}

function fakeSlashInteraction(commandName: string, guildId: string, options: Record<string, string | number>) {
  const reply = vi.fn(async (_payload: { content: string; ephemeral?: boolean }) => undefined);
  const interaction = {
    commandName,
    guildId,
    memberPermissions: { has: () => true },
    member: { roles: [] as string[] },
    options: {
      getString: (name: string) => (options[name] !== undefined ? String(options[name]) : null),
      getInteger: (name: string) => (options[name] !== undefined ? Number(options[name]) : null),
    },
    reply,
    deferred: false,
    replied: false,
    isRepliable: () => true,
  };
  return { interaction: interaction as unknown as ChatInputCommandInteraction, reply };
}

function fakeButtonInteraction(customId: string, guildId: string, userId: string, displayName: string) {
  const update = vi.fn(async (_payload: { content: string; components: unknown[] }) => undefined);
  const reply = vi.fn(async (_payload: { content: string; ephemeral?: boolean }) => undefined);
  const interaction = {
    customId,
    guildId,
    user: { id: userId, username: userId, globalName: displayName },
    member: { displayName },
    update,
    reply,
    deferred: false,
    replied: false,
    isRepliable: () => true,
  };
  return { interaction: interaction as unknown as ButtonInteraction, update, reply };
}

describeIfDb("Phase 3 — /post-match, attendance buttons, announcement sync (integration)", () => {
  let db: Database;
  let pool: Pool;
  let ctx: AppContext;
  let fakeDiscord: ReturnType<typeof fakeDiscordRestClient>;
  const guildId = `phase3-guild-${Date.now()}`;
  const channelId = "channel-abc";

  beforeAll(async () => {
    ({ db, pool } = createDatabase({ DATABASE_URL: databaseUrl! }));
    fakeDiscord = fakeDiscordRestClient();
    ctx = buildAppContext({ discord: fakeDiscord.discord, db, env: {} as any, logger });
    await ctx.repositories.serverConfig.upsert(guildId, {
      timezone: "Europe/Berlin",
      matchChannelId: channelId,
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  async function createMatch(opponent: string, date: string, time: string) {
    await dispatchCommand(
      fakeSlashInteraction("create-match", guildId, { opponent, date, time }).interaction,
      ctx,
    );
    const list = await ctx.services.matches.listMatches(guildId);
    return list.find((m) => m.opponent === opponent)!;
  }

  it("/post-match posts the announcement, opens the match, and stores the message location", async () => {
    const match = await createMatch("Team Post", "25/09/2026", "19:00");

    const { interaction, reply } = fakeSlashInteraction("post-match", guildId, { match_id: match.id });
    await dispatchCommand(interaction, ctx);

    expect(reply.mock.calls[0]![0].content).toMatch(/Posted \*\*Match #\d+\*\*/);
    expect(fakeDiscord.sendChannelMessage).toHaveBeenCalledTimes(1);
    const [sentChannelId, sentPayload] = fakeDiscord.sendChannelMessage.mock.calls[0]!;
    expect(sentChannelId).toBe(channelId);
    expect(sentPayload.content).toContain("Team Post");
    expect(sentPayload.components).toHaveLength(1); // 3 buttons in one row

    const refetched = (await ctx.services.matches.listMatches(guildId)).find((m) => m.id === match.id)!;
    expect(refetched.status).toBe("CONFIRMATION_OPEN");
    expect(refetched.announcementChannelId).toBe(channelId);
    expect(refetched.announcementMessageId).toBeTruthy();
  });

  it("/post-match refuses to double-post an already-open match", async () => {
    const match = await createMatch("Team DoublePost", "26/09/2026", "19:00");
    const callsBefore = fakeDiscord.sendChannelMessage.mock.calls.length;
    await dispatchCommand(
      fakeSlashInteraction("post-match", guildId, { match_id: match.id }).interaction,
      ctx,
    );
    expect(fakeDiscord.sendChannelMessage.mock.calls.length).toBe(callsBefore + 1); // the legitimate first post

    const { interaction, reply } = fakeSlashInteraction("post-match", guildId, { match_id: match.id });
    await dispatchCommand(interaction, ctx);
    expect(reply.mock.calls[0]![0].content).toMatch(/already been posted/);
    expect(fakeDiscord.sendChannelMessage.mock.calls.length).toBe(callsBefore + 1); // NOT called again
  });

  it("a button click records attendance and edits the SAME public message via interaction.update()", async () => {
    const match = await createMatch("Team Button", "27/09/2026", "19:00");
    await dispatchCommand(
      fakeSlashInteraction("post-match", guildId, { match_id: match.id }).interaction,
      ctx,
    );
    const posted = (await ctx.services.matches.listMatches(guildId)).find((m) => m.id === match.id)!;

    const customId = `attendance:${match.id}:PLAYING`;
    const { interaction, update, reply } = fakeButtonInteraction(customId, guildId, "player-a", "Ahmed");
    await dispatchButton(interaction, ctx);

    expect(reply).not.toHaveBeenCalled(); // success path uses update(), not reply()
    expect(update).toHaveBeenCalledTimes(1);
    const payload = update.mock.calls[0]![0];
    expect(payload.content).toContain("Ahmed");
    expect(payload.content).toContain("🟢 Playing");
    expect(payload.content).toContain("Responded: 1");
    expect(payload.components).toHaveLength(1);

    const withAttendance = await ctx.services.attendance.getMatchWithAttendance(guildId, posted.id);
    expect(withAttendance?.attendanceRows).toHaveLength(1);
  });

  it("the same player clicking a different button updates their response, not a duplicate", async () => {
    const match = await createMatch("Team Switch", "28/09/2026", "19:00");
    await dispatchCommand(
      fakeSlashInteraction("post-match", guildId, { match_id: match.id }).interaction,
      ctx,
    );

    await dispatchButton(
      fakeButtonInteraction(`attendance:${match.id}:PLAYING`, guildId, "player-b", "Marwan").interaction,
      ctx,
    );
    const second = fakeButtonInteraction(`attendance:${match.id}:CANNOT_PLAY`, guildId, "player-b", "Marwan");
    await dispatchButton(second.interaction, ctx);

    const withAttendance = await ctx.services.attendance.getMatchWithAttendance(guildId, match.id);
    expect(withAttendance?.attendanceRows).toHaveLength(1);
    expect(withAttendance?.attendanceRows[0]!.status).toBe("CANNOT_PLAY");

    const payload = second.update.mock.calls[0]![0];
    expect(payload.content).toContain("🔴 Can't play");
    expect(payload.content).not.toContain("🟢 Playing"); // section omitted once empty
  });

  it("/cancel-match on an already-posted match disables buttons and refreshes the public message", async () => {
    const match = await createMatch("Team CancelPosted", "29/09/2026", "19:00");
    await dispatchCommand(
      fakeSlashInteraction("post-match", guildId, { match_id: match.id }).interaction,
      ctx,
    );
    await dispatchButton(
      fakeButtonInteraction(`attendance:${match.id}:PLAYING`, guildId, "player-c", "Omar").interaction,
      ctx,
    );

    const posted = (await ctx.services.matches.listMatches(guildId)).find((m) => m.id === match.id)!;
    const messageId = posted.announcementMessageId!;
    const editsBefore = fakeDiscord.editChannelMessage.mock.calls.length;

    await dispatchCommand(
      fakeSlashInteraction("cancel-match", guildId, { match_id: match.id }).interaction,
      ctx,
    );

    const editCallsForThisMessage = fakeDiscord.editChannelMessage.mock.calls.filter(
      ([, id]) => id === messageId,
    );
    expect(fakeDiscord.editChannelMessage.mock.calls.length).toBe(editsBefore + 1);
    expect(editCallsForThisMessage).toHaveLength(1);
    const editedPayload = editCallsForThisMessage[0]![2];
    expect(editedPayload.content).toContain("CANCELLED");
    expect(editedPayload.components).toHaveLength(0);
    // Attendance history stays visible even though the match is cancelled.
    expect(editedPayload.content).toContain("Omar");
    // The tracked message state itself reflects the edit.
    expect(fakeDiscord.messages.get(messageId)?.content).toContain("CANCELLED");
  });

  it("a button click on a cancelled match is rejected privately and the public message is left untouched", async () => {
    const match = await createMatch("Team ClickCancelled", "30/09/2026", "19:00");
    await dispatchCommand(
      fakeSlashInteraction("post-match", guildId, { match_id: match.id }).interaction,
      ctx,
    );
    await dispatchCommand(
      fakeSlashInteraction("cancel-match", guildId, { match_id: match.id }).interaction,
      ctx,
    );

    const { interaction, update, reply } = fakeButtonInteraction(
      `attendance:${match.id}:PLAYING`,
      guildId,
      "player-d",
      "Youssef",
    );
    await dispatchButton(interaction, ctx);

    expect(update).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0]![0].content).toMatch(/isn't accepting responses/);

    const withAttendance = await ctx.services.attendance.getMatchWithAttendance(guildId, match.id);
    expect(withAttendance?.attendanceRows).toHaveLength(0); // nothing was recorded
  });

  it("/edit-match on an already-posted match refreshes the public message header", async () => {
    const match = await createMatch("Team EditPosted", "01/10/2026", "19:00");
    await dispatchCommand(
      fakeSlashInteraction("post-match", guildId, { match_id: match.id }).interaction,
      ctx,
    );
    const posted = (await ctx.services.matches.listMatches(guildId)).find((m) => m.id === match.id)!;
    const messageId = posted.announcementMessageId!;

    await dispatchCommand(
      fakeSlashInteraction("edit-match", guildId, {
        match_id: match.id,
        opponent: "Team EditPosted FC",
      }).interaction,
      ctx,
    );

    expect(fakeDiscord.messages.get(messageId)?.content).toContain("Team EditPosted FC");
  });

  it("a malformed/unrecognized button custom_id is handled gracefully, not thrown", async () => {
    const { interaction, reply, update } = fakeButtonInteraction(
      "some-unrelated-button:x",
      guildId,
      "player-e",
      "Hassan",
    );
    await expect(dispatchButton(interaction, ctx)).resolves.not.toThrow();
    expect(update).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(1);
  });
});
