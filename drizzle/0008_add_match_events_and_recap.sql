-- Phase 10 (plan sections 39/40). Renumbered from a second "0007" that the
-- journal never listed. Written to be idempotent so it is safe both on a
-- database that never ran the old file and on one that already did.
DO $$ BEGIN
	CREATE TYPE "public"."match_result" AS ENUM('WIN', 'LOSS');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	CREATE TYPE "public"."match_event_type" AS ENUM('CLUTCH', 'MVP', 'TOP_FRAG', 'FUNNY_MOMENT', 'ACHIEVEMENT', 'TEAM_EVENT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
ALTER TYPE "public"."memory_evidence_source_type" ADD VALUE IF NOT EXISTS 'MATCH_EVENT';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "match_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"match_id" integer NOT NULL,
	"player_id" integer,
	"type" "match_event_type" NOT NULL,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN IF NOT EXISTS "result" "match_result";--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN IF NOT EXISTS "notes" text;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN IF NOT EXISTS "completed_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "match_events" ADD CONSTRAINT "match_events_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "match_events" ADD CONSTRAINT "match_events_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "match_events_match_idx" ON "match_events" USING btree ("match_id");
