CREATE TYPE "public"."ai_conversation_end_reason" AS ENUM('COMPLETED', 'TURN_LIMIT', 'ATTENDANCE_CHANGED', 'MATCH_CLOSED', 'IDLE_TIMEOUT', 'AI_FAILURE', 'DM_UNAVAILABLE');--> statement-breakpoint
CREATE TYPE "public"."ai_message_role" AS ENUM('USER', 'ASSISTANT', 'SYSTEM');--> statement-breakpoint
CREATE TYPE "public"."ai_mode" AS ENUM('CELEBRATE', 'ROAST', 'CONSOLE', 'MATCH_HYPE', 'POST_MATCH');--> statement-breakpoint
CREATE TABLE "ai_conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"player_id" integer NOT NULL,
	"match_id" integer NOT NULL,
	"mode" "ai_mode" NOT NULL,
	"dm_channel_id" text,
	"last_seen_message_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" "ai_conversation_end_reason"
);
--> statement-breakpoint
CREATE TABLE "ai_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"role" "ai_message_role" NOT NULL,
	"content" text NOT NULL,
	"source_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_conversation_id_ai_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_conversations_one_open_per_player_match_idx" ON "ai_conversations" USING btree ("player_id","match_id") WHERE ended_at IS NULL;--> statement-breakpoint
CREATE INDEX "ai_conversations_open_idx" ON "ai_conversations" USING btree ("guild_id") WHERE ended_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_messages_conversation_source_ref_idx" ON "ai_messages" USING btree ("conversation_id","source_ref");--> statement-breakpoint
CREATE INDEX "ai_messages_conversation_idx" ON "ai_messages" USING btree ("conversation_id","id");