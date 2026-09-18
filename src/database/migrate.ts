import "dotenv/config";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDatabase } from "./client.js";
import { loadDatabaseEnv } from "../config/env.js";
import { logger } from "../config/logger.js";

async function main() {
  const env = loadDatabaseEnv();
  const { db, pool } = createDatabase(env);
  logger.info({ event: "migrate.start" }, "Running database migrations");
  await migrate(db, { migrationsFolder: "./drizzle" });
  logger.info({ event: "migrate.complete" }, "Migrations complete");
  await pool.end();
}

main().catch((err) => {
  logger.error({ event: "migrate.failed", err: String(err) }, "Migration failed");
  process.exit(1);
});
