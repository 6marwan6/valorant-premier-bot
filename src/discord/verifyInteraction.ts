import { verifyKey } from "discord-interactions";

/**
 * Verifies that an incoming HTTP request genuinely came from Discord, per
 * Discord's HTTP Interactions documentation: every request carries an
 * `X-Signature-Ed25519` and `X-Signature-Timestamp` header, signed over
 * `timestamp + rawBody` using a key Discord derives from the bot's public
 * key (`DISCORD_PUBLIC_KEY`, a new env var — distinct from the bot token).
 *
 * This MUST run against the raw, unparsed request body — signing is
 * byte-exact, so if the HTTP framework already parsed JSON, re-serializing
 * it wouldn't byte-for-byte match what Discord signed. The Vercel handler
 * (api/interactions.ts) disables automatic body parsing specifically so
 * this function gets the untouched bytes.
 *
 * Plan section 55/56 treat all external input as untrusted by default;
 * this is the literal front door of the whole application now that
 * there's no gateway session implicitly authenticating the connection —
 * every single request must prove it's really Discord before anything
 * else runs.
 */
export async function verifyDiscordRequest(params: {
  rawBody: string;
  signature: string | string[] | undefined;
  timestamp: string | string[] | undefined;
  publicKey: string;
}): Promise<boolean> {
  if (!params.signature || !params.timestamp) return false;
  const signature = Array.isArray(params.signature) ? params.signature[0] : params.signature;
  const timestamp = Array.isArray(params.timestamp) ? params.timestamp[0] : params.timestamp;
  if (!signature || !timestamp) return false;

  return verifyKey(params.rawBody, signature, timestamp, params.publicKey);
}
