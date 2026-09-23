import { describe, expect, it, afterEach } from "vitest";
import { createDatabase } from "../../src/database/client.js";

/**
 * Regression test for a real production incident: `pg.Pool` defaults
 * `connectionTimeoutMillis` to 0 (wait forever). On serverless hosting
 * that turns any stalled DB handshake (bad connection string, a network
 * hiccup between Vercel and Neon, Neon's pooler behaving unexpectedly)
 * into a silent, unbounded hang — the whole function invocation just
 * sits there with no error to log, "M.A.R.I. is thinking..." forever in
 * Discord, until the platform (or Discord's own webhook-token expiry)
 * eventually kills it. `dispatchCommand`'s try/catch (and its
 * user-facing fallback message) can only run once something actually
 * throws — which needs a real timeout configured here.
 */
describe("createDatabase", () => {
  let pool: ReturnType<typeof createDatabase>["pool"] | undefined;

  afterEach(async () => {
    await pool?.end().catch(() => undefined);
  });

  it("sets a finite connectionTimeoutMillis, never the pg default of 0 (wait forever)", () => {
    ({ pool } = createDatabase({ DATABASE_URL: "postgres://user:pass@localhost:5432/db" }));
    const timeout = (pool as unknown as { options: { connectionTimeoutMillis?: number } }).options
      .connectionTimeoutMillis;
    expect(timeout).toBeGreaterThan(0);
  });
});
