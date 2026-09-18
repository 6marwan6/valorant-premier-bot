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
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const db = drizzle(pool, { schema });
  return { db, pool };
}
