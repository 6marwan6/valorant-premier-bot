CREATE TYPE "public"."memory_candidate_status" AS ENUM('PENDING', 'APPROVED', 'DECLINED');--> statement-breakpoint
CREATE TYPE "public"."memory_type" AS ENUM('PLAYER_PREFERENCE', 'PERSONALITY_TRAIT', 'RUNNING_JOKE', 'VALORANT_PREFERENCE', 'TEAM_JOKE', 'MATCH_EVENT', 'ACHIEVEMENT', 'HABIT', 'TEAM_HISTORY');--> statement-breakpoint
CREATE TYPE "public"."memory_visibility" AS ENUM('PUBLIC', 'TEAM', 'PRIVATE', 'PROTECTED');--> statement-breakpoint
CREATE TYPE "public"."memory_evidence_source_type" AS ENUM('AI_CONVERSATION', 'DISCORD_MESSAGE');--> statement-breakpoint
CREATE TABLE "memories" (
	"id" serial PRIMARY KEY NOT NULL,
	"player_id" integer NOT NULL,
	"type" "memory_type" NOT NULL,
	"content" text NOT NULL,
	"confidence" real DEFAULT 1 NOT NULL,
	"importance" integer DEFAULT 50 NOT NULL,
	"visibility" "memory_visibility" DEFAULT 'PRIVATE' NOT NULL,
	"ai_usable" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "memory_evidence" (
	"id" serial PRIMARY KEY NOT NULL,
	"memory_id" integer NOT NULL,
	"source_type" "memory_evidence_source_type" NOT NULL,
	"source_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_messages" ADD COLUMN "memory_candidate" jsonb;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD COLUMN "memory_candidate_status" "memory_candidate_status";--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_evidence" ADD CONSTRAINT "memory_evidence_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memories_player_idx" ON "memories" USING btree ("player_id","id");--> statement-breakpoint
CREATE INDEX "memory_evidence_memory_idx" ON "memory_evidence" USING btree ("memory_id");