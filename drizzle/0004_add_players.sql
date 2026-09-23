CREATE TYPE "public"."player_role" AS ENUM('DUELIST', 'INITIATOR', 'CONTROLLER', 'SENTINEL');--> statement-breakpoint
CREATE TABLE "players" (
	"id" serial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"discord_user_id" text NOT NULL,
	"display_name" text NOT NULL,
	"role" "player_role" NOT NULL,
	"agents" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"preferred_agent" text,
	"roast_intensity" integer DEFAULT 50 NOT NULL,
	"personal_references_enabled" boolean DEFAULT true NOT NULL,
	"running_jokes_enabled" boolean DEFAULT true NOT NULL,
	"valorant_references_enabled" boolean DEFAULT true NOT NULL,
	"match_history_references_enabled" boolean DEFAULT true NOT NULL,
	"memory_usage_enabled" boolean DEFAULT true NOT NULL,
	"ai_follow_ups_enabled" boolean DEFAULT true NOT NULL,
	"protected_topics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_guild_id_server_config_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."server_config"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "players_guild_discord_user_idx" ON "players" USING btree ("guild_id","discord_user_id");--> statement-breakpoint
CREATE INDEX "players_guild_active_idx" ON "players" USING btree ("guild_id","active");