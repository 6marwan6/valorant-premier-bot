CREATE TYPE "public"."match_status" AS ENUM('SCHEDULED', 'CONFIRMATION_OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "matches" (
	"id" serial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"opponent" text NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"timezone" text NOT NULL,
	"status" "match_status" DEFAULT 'SCHEDULED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_guild_id_server_config_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."server_config"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "matches_guild_scheduled_idx" ON "matches" USING btree ("guild_id","scheduled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "matches_guild_opponent_time_active_idx" ON "matches" USING btree ("guild_id","opponent","scheduled_at") WHERE status <> 'CANCELLED';