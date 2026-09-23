import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema/index.js";
import type { Env } from "../config/env.js";

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
  });
  const db = drizzle(pool, { schema });
  return { db, pool };
}
