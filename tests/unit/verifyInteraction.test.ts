import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyDiscordRequest } from "../../src/discord/verifyInteraction.js";

/**
 * Generates a real Ed25519 keypair and signs a payload the same way
 * Discord signs interaction requests (timestamp + raw body, concatenated
 * as bytes), so these tests exercise the actual cryptographic
 * verification path rather than mocking it away — this function is the
 * literal security boundary of the whole app now that there's no gateway
 * session (see verifyInteraction.ts's doc comment).
 */
function signPayload(body: string, timestamp: string) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  const publicKeyHex = spki.subarray(spki.length - 32).toString("hex");

  const message = Buffer.concat([Buffer.from(timestamp, "utf8"), Buffer.from(body, "utf8")]);
  const signatureHex = crypto.sign(null, message, privateKey).toString("hex");

  return { publicKeyHex, signatureHex };
}

describe("verifyDiscordRequest", () => {
  const body = JSON.stringify({ type: 1 });
  const timestamp = String(Math.floor(Date.now() / 1000));

  it("accepts a genuinely valid signature", async () => {
    const { publicKeyHex, signatureHex } = signPayload(body, timestamp);
    const ok = await verifyDiscordRequest({
      rawBody: body,
      signature: signatureHex,
      timestamp,
      publicKey: publicKeyHex,
    });
    expect(ok).toBe(true);
  });

  it("rejects a signature verified against the wrong public key", async () => {
    const { signatureHex } = signPayload(body, timestamp);
    const { publicKeyHex: wrongKey } = signPayload("unrelated", "0");
    const ok = await verifyDiscordRequest({
      rawBody: body,
      signature: signatureHex,
      timestamp,
      publicKey: wrongKey,
    });
    expect(ok).toBe(false);
  });

  it("rejects a signature computed over a different body (tampered payload)", async () => {
    const { publicKeyHex, signatureHex } = signPayload(body, timestamp);
    const ok = await verifyDiscordRequest({
      rawBody: JSON.stringify({ type: 1, tampered: true }),
      signature: signatureHex,
      timestamp,
      publicKey: publicKeyHex,
    });
    expect(ok).toBe(false);
  });

  it("rejects a signature computed over a different timestamp", async () => {
    const { publicKeyHex, signatureHex } = signPayload(body, timestamp);
    const ok = await verifyDiscordRequest({
      rawBody: body,
      signature: signatureHex,
      timestamp: String(Number(timestamp) + 1),
      publicKey: publicKeyHex,
    });
    expect(ok).toBe(false);
  });

  it("rejects when the signature header is missing", async () => {
    const { publicKeyHex } = signPayload(body, timestamp);
    const ok = await verifyDiscordRequest({
      rawBody: body,
      signature: undefined,
      timestamp,
      publicKey: publicKeyHex,
    });
    expect(ok).toBe(false);
  });

  it("rejects when the timestamp header is missing", async () => {
    const { publicKeyHex, signatureHex } = signPayload(body, timestamp);
    const ok = await verifyDiscordRequest({
      rawBody: body,
      signature: signatureHex,
      timestamp: undefined,
      publicKey: publicKeyHex,
    });
    expect(ok).toBe(false);
  });

  it("rejects garbage/malformed signature input without throwing", async () => {
    const { publicKeyHex } = signPayload(body, timestamp);
    await expect(
      verifyDiscordRequest({
        rawBody: body,
        signature: "not-hex-at-all!!",
        timestamp,
        publicKey: publicKeyHex,
      }),
    ).resolves.toBe(false);
  });

  it("handles a header value arriving as an array (some Node HTTP layers do this) by using the first element", async () => {
    const { publicKeyHex, signatureHex } = signPayload(body, timestamp);
    const ok = await verifyDiscordRequest({
      rawBody: body,
      signature: [signatureHex],
      timestamp: [timestamp],
      publicKey: publicKeyHex,
    });
    expect(ok).toBe(true);
  });
});
