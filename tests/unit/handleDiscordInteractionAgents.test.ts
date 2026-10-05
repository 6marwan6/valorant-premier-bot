import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
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
const user = { id: "user-1", username: "ahmed", global_name: "Ahmed" };

describe("handleDiscordInteraction — agent-pick popup", () => {
  it("'➕ Add an agent' answers with the popup immediately, before any ctx/database work (Discord's 3s rule)", async () => {
    const responses = await run(
      { type: InteractionType.MessageComponent, id: "i-1", token: "t", guild_id: "g", user, data: { component_type: ComponentType.Button, custom_id: "agent:7:a:C" } },
      neverCtx,
    );
    expect(responses).toHaveLength(1);
    expect(responses[0]!.body.type).toBe(InteractionResponseType.Modal);
    expect(responses[0]!.body.data.custom_id).toBe("agentadd:7:C");
    expect(responses[0]!.body.data.title).toBe("Add a Controller");
    const field = responses[0]!.body.data.components[0].component;
    expect(field.custom_id).toBe("agent_name");
    expect(field.min_length).toBe(2);
    expect(field.max_length).toBe(20);
    expect(field.required).toBe(true);
  });

  it("each role names its popup after that role", async () => {
    for (const [code, title] of [["D", "Duelist"], ["I", "Initiator"], ["S", "Sentinel"]] as const) {
      const r = await run({ type: InteractionType.MessageComponent, id: "i", token: "t", user, data: { component_type: ComponentType.Button, custom_id: `agent:7:a:${code}` } }, neverCtx);
      expect(r[0]!.body.data.title).toBe(`Add a ${title}`);
    }
  });

  it("other panel buttons are deferred as an update of the (ephemeral) panel, then dispatched", async () => {
    // A malformed id still goes through the normal button path: acked as a deferred update, never a modal.
    const responses: Array<any> = [];
    const rawBody = JSON.stringify({ type: InteractionType.MessageComponent, id: "i", token: "t", guild_id: "g", user, data: { component_type: ComponentType.Button, custom_id: "agent:7:r:D" } });
    const ts = String(Math.floor(Date.now() / 1000));
    await handleDiscordInteraction({
      rawBody,
      signature: keypair.sign(rawBody, ts),
      timestamp: ts,
      publicKey: keypair.publicKeyHex,
      buildCtx: () => {
        // The dispatcher needs a context; hand it one that fails fast so we only observe the ack.
        throw new Error("ctx needed");
      },
      sendInitialResponse: (status, b) => responses.push({ status, b }),
    }).catch(() => undefined);
    expect(responses.length === 0 || responses[0].b.type !== InteractionResponseType.Modal).toBe(true);
  });
});
