import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ComponentType, InteractionResponseType, InteractionType } from "discord-api-types/v10";
import { handleDiscordInteraction } from "../../src/discord/handleDiscordInteraction.js";
import type { AppContext } from "../../src/appContext.js";

function makeKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  return {
    publicKeyHex: spki.subarray(spki.length - 32).toString("hex"),
    sign(body: string, timestamp: string) {
      return crypto.sign(null, Buffer.concat([Buffer.from(timestamp), Buffer.from(body)]), privateKey).toString("hex");
    },
  };
}
const keypair = makeKeypair();

async function run(body: object, buildCtx: () => AppContext) {
  const rawBody = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const responses: Array<{ status: number; body: any }> = [];
  await handleDiscordInteraction({
    rawBody,
    signature: keypair.sign(rawBody, timestamp),
    timestamp,
    publicKey: keypair.publicKeyHex,
    buildCtx,
    sendInitialResponse: (status, b) => responses.push({ status, body: b }),
  });
  return responses;
}

const neverCtx = () => {
  throw new Error("buildCtx must not be called");
};

const dmUser = { id: "user-1", username: "ahmed", global_name: "Ahmed" };

describe("handleDiscordInteraction — Phase 7 routes", () => {
  it("Reply button: answers with the modal immediately, before any ctx/database work (Discord's 3s rule)", async () => {
    const responses = await run(
      {
        type: InteractionType.MessageComponent,
        id: "i-1",
        token: "t",
        user: dmUser,
        channel_id: "dm-1",
        data: { component_type: ComponentType.Button, custom_id: "console:reply:12" },
      },
      neverCtx,
    );
    expect(responses).toHaveLength(1);
    expect(responses[0]!.status).toBe(200);
    expect(responses[0]!.body.type).toBe(InteractionResponseType.Modal);
    expect(responses[0]!.body.data.custom_id).toBe("console:modal:12");
  });

  it("a Reply button with a malformed id gets a private 'not recognized' message, not a crash", async () => {
    const responses = await run(
      {
        type: InteractionType.MessageComponent,
        id: "i-1",
        token: "t",
        user: dmUser,
        data: { component_type: ComponentType.Button, custom_id: "console:reply:nope" },
      },
      neverCtx,
    );
    expect(responses[0]!.body.type).toBe(InteractionResponseType.ChannelMessageWithSource);
    expect(responses[0]!.body.data.content).toMatch(/isn't recognized/);
  });

  it("modal submit: acks with a deferred message update, then hands the raw interaction to the handler", async () => {
    const order: string[] = [];
    const handle = vi.fn(async () => undefined);
    vi.resetModules();
    vi.doMock("../../src/discord/consoleConversation.js", async (orig) => ({
      ...(await orig<typeof import("../../src/discord/consoleConversation.js")>()),
      handleConsoleReplyModal: handle,
    }));
    const { handleDiscordInteraction: handler } = await import("../../src/discord/handleDiscordInteraction.js");

    const body = {
      type: InteractionType.ModalSubmit,
      id: "i-2",
      token: "tok",
      user: dmUser,
      channel_id: "dm-1",
      data: { custom_id: "console:modal:12", components: [] },
    };
    const rawBody = JSON.stringify(body);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const fakeCtx = {} as AppContext;
    await handler({
      rawBody,
      signature: keypair.sign(rawBody, timestamp),
      timestamp,
      publicKey: keypair.publicKeyHex,
      buildCtx: () => fakeCtx,
      sendInitialResponse: (status, b) => {
        order.push(`ack:${status}:${(b as { type: number }).type}`);
      },
    });
    order.push("handled");
    expect(order).toEqual([`ack:200:${InteractionResponseType.DeferredMessageUpdate}`, "handled"]);
    expect(handle).toHaveBeenCalledTimes(1);
    expect((handle.mock.calls[0] as unknown as [{ data: { custom_id: string } }, AppContext])[1]).toBe(fakeCtx);
    vi.doUnmock("../../src/discord/consoleConversation.js");
    vi.resetModules();
  });

  it("an unknown modal is still rejected like any unsupported interaction", async () => {
    const responses = await run(
      {
        type: InteractionType.ModalSubmit,
        id: "i-3",
        token: "t",
        user: dmUser,
        data: { custom_id: "something:else", components: [] },
      },
      neverCtx,
    );
    expect(responses).toEqual([{ status: 400, body: { error: "unsupported interaction type" } }]);
  });
});
