import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// Add new schema files to this array as they're created in later phases.
export default defineConfig({
  schema: [
    "./src/database/schema/serverConfig.ts",
    "./src/database/schema/matches.ts",
    "./src/database/schema/attendance.ts",
    "./src/database/schema/reminders.ts",
    "./src/database/schema/players.ts",
  ],
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://placeholder:placeholder@localhost:5432/placeholder",
  },
  verbose: true,
  strict: true,
});
