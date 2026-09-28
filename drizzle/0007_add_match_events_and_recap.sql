CREATE TYPE "public"."match_result" AS ENUM('WIN', 'LOSS');--> statement-breakpoint
CREATE TYPE "public"."match_event_type" AS ENUM('CLUTCH', 'MVP', 'TOP_FRAG', 'FUNNY_MOMENT', 'ACHIEVEMENT', 'TEAM_EVENT');--> statement-breakpoint
ALTER TYPE "public"."memory_evidence_source_type" ADD VALUE 'MATCH_EVENT';--> statement-breakpoint
CREATE TABLE "match_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"match_id" integer NOT NULL,
	"player_id" integer,
	"type" "match_event_type" NOT NULL,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "result" "match_result";--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "match_events" ADD CONSTRAINT "match_events_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_events" ADD CONSTRAINT "match_events_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "match_events_match_idx" ON "match_events" USING btree ("match_id");