CREATE TYPE "public"."reminder_status" AS ENUM('PENDING', 'CLAIMED', 'SENT', 'SKIPPED');--> statement-breakpoint
CREATE TABLE "reminders" (
	"id" serial PRIMARY KEY NOT NULL,
	"match_id" integer NOT NULL,
	"offset_minutes" integer NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"status" "reminder_status" DEFAULT 'PENDING' NOT NULL,
	"discord_channel_id" text,
	"discord_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "server_config" ALTER COLUMN "timezone" SET DEFAULT 'Africa/Cairo';--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reminders_match_offset_idx" ON "reminders" USING btree ("match_id","offset_minutes");--> statement-breakpoint
CREATE INDEX "reminders_status_scheduled_idx" ON "reminders" USING btree ("status","scheduled_at");