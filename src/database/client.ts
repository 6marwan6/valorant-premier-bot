import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema/index.js";
import type { Env } from "../config/env.js";
import { logger } from "../config/logger.js";

export type Database = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Creates a Postgres pool + drizzle instance. Kept as a factory (not a
 * module-level singleton) so tests can spin up isolated instances against
 * a test database without import-order headaches.
 */
export function createDatabase(env: Pick<Env, "DATABASE_URL">): {
  db: Database;
  pool: Pool;
} {
  // Diagnostic, not a secret leak: logs which host/database this
  // invocation is actually configured to hit, with the credentials
  // stripped out entirely. Added after a production incident where every
  // symptom (clean 200 ack, zero further logs, infinite "thinking...")
  // was consistent with several different root causes — a stalled
  // connection, a stalled query, or the env var simply not being the
  // value we assumed — with no way to tell which from the logs alone. A
  // malformed connection string still throws here (URL parsing), which
  // itself would have been useful signal previously silently swallowed
  // by the hang further down.
  try {
    const parsed = new URL(env.DATABASE_URL);
    logger.info(
      {
        event: "db.pool.init",
        host: parsed.hostname,
        database: parsed.pathname.replace(/^\//, ""),
        params: parsed.search,
      },
      "Initializing database pool",
    );
  } catch (err) {
    logger.error(
      { event: "db.pool.init.invalidUrl", err: err instanceof Error ? err.message : String(err) },
      "DATABASE_URL is not a parseable URL",
    );
  }

  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    // `pg.Pool` defaults connectionTimeoutMillis to 0 — wait forever if the
    // TCP/TLS handshake stalls. On serverless (Vercel) that means a single
    // bad connection attempt doesn't error, it just hangs the whole function
    // invocation silently until the platform's own maxDuration kills it —
    // dispatchCommand never gets a chance to log command.failed or send the
    // "something went wrong" fallback (plan section 48), so Discord just
    // shows "thinking..." until its own webhook token eventually expires.
    // Failing fast here turns that into a real, loggable error instead.
    connectionTimeoutMillis: 8_000,
    // This alone turned out not to be enough in production: a connection
    // that succeeds (so connectionTimeoutMillis is satisfied) but then a
    // QUERY that never returns — a suspended/misbehaving pooler backend,
    // a lock, a stuck Neon compute wake-up — hangs just as silently and
    // just as permanently, since nothing above guards query execution
    // itself. `query_timeout` (client-side: abort if no response in time)
    // and `statement_timeout` (server-side: Postgres cancels its own
    // long-running statement) close that gap from both ends. Kept at 8s,
    // same as connectionTimeoutMillis, so even the worst case (a slow
    // connect immediately followed by a hung query) still leaves headroom
    // under vercel.json's 15s maxDuration for dispatchCommand's own
    // catch block to log and send the Discord followup before Vercel
    // would kill the invocation anyway.
    query_timeout: 8_000,
    statement_timeout: 8_000,
  });
  const db = drizzle(pool, { schema });
  return { db, pool };
}