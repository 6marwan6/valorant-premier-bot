import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// Points at the individual schema files, excluding ./index.ts, because
// drizzle-kit's CJS-based config loader can't follow the ".js"-suffixed
// relative imports our ESM runtime code uses inside index.ts's re-exports.
// Add new schema files to this glob as they're created in later phases.
export default defineConfig({
  schema: "./src/database/schema/serverConfig.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://placeholder:placeholder@localhost:5432/placeholder",
  },
  verbose: true,
  strict: true,
});
