CREATE TYPE "public"."attendance_status" AS ENUM('PLAYING', 'CANNOT_PLAY', 'WANTS_TO_BUT_CANNOT');--> statement-breakpoint
CREATE TABLE "attendance" (
	"id" serial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"match_id" integer NOT NULL,
	"discord_user_id" text NOT NULL,
	"discord_display_name" text NOT NULL,
	"status" "attendance_status" NOT NULL,
	"responded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "announcement_channel_id" text;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "announcement_message_id" text;--> statement-breakpoint
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_match_user_idx" ON "attendance" USING btree ("match_id","discord_user_id");--> statement-breakpoint
CREATE INDEX "attendance_match_idx" ON "attendance" USING btree ("match_id");