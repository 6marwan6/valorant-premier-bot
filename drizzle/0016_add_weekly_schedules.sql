CREATE TYPE "public"."schedule_poll_status" AS ENUM('OPEN', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."slot_remind_mode" AS ENUM('AUTO', 'ALWAYS', 'NEVER');--> statement-breakpoint
CREATE TABLE "schedule_declines" (
	"id" serial PRIMARY KEY NOT NULL,
	"poll_id" integer NOT NULL,
	"discord_user_id" text NOT NULL,
	"discord_display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_polls" (
	"id" serial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"status" "schedule_poll_status" DEFAULT 'OPEN' NOT NULL,
	"timezone" text NOT NULL,
	"channel_id" text NOT NULL,
	"message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_slots" (
	"id" serial PRIMARY KEY NOT NULL,
	"poll_id" integer NOT NULL,
	"position" integer NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"queue_at" timestamp with time zone,
	"remind_mode" "slot_remind_mode" DEFAULT 'AUTO' NOT NULL,
	"quorum_announced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_votes" (
	"id" serial PRIMARY KEY NOT NULL,
	"poll_id" integer NOT NULL,
	"slot_id" integer NOT NULL,
	"discord_user_id" text NOT NULL,
	"discord_display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slot_reminders" (
	"id" serial PRIMARY KEY NOT NULL,
	"slot_id" integer NOT NULL,
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
ALTER TABLE "server_config" ALTER COLUMN "reminder_schedule_minutes" SET DEFAULT '[300,15]'::jsonb;--> statement-breakpoint
ALTER TABLE "schedule_declines" ADD CONSTRAINT "schedule_declines_poll_id_schedule_polls_id_fk" FOREIGN KEY ("poll_id") REFERENCES "public"."schedule_polls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_polls" ADD CONSTRAINT "schedule_polls_guild_id_server_config_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."server_config"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_slots" ADD CONSTRAINT "schedule_slots_poll_id_schedule_polls_id_fk" FOREIGN KEY ("poll_id") REFERENCES "public"."schedule_polls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_votes" ADD CONSTRAINT "schedule_votes_poll_id_schedule_polls_id_fk" FOREIGN KEY ("poll_id") REFERENCES "public"."schedule_polls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_votes" ADD CONSTRAINT "schedule_votes_slot_id_schedule_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."schedule_slots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_reminders" ADD CONSTRAINT "slot_reminders_slot_id_schedule_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."schedule_slots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_declines_poll_user_idx" ON "schedule_declines" USING btree ("poll_id","discord_user_id");--> statement-breakpoint
CREATE INDEX "schedule_polls_guild_status_idx" ON "schedule_polls" USING btree ("guild_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_slots_poll_position_idx" ON "schedule_slots" USING btree ("poll_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_slots_poll_time_idx" ON "schedule_slots" USING btree ("poll_id","scheduled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_votes_slot_user_idx" ON "schedule_votes" USING btree ("slot_id","discord_user_id");--> statement-breakpoint
CREATE INDEX "schedule_votes_poll_idx" ON "schedule_votes" USING btree ("poll_id");--> statement-breakpoint
CREATE UNIQUE INDEX "slot_reminders_slot_offset_idx" ON "slot_reminders" USING btree ("slot_id","offset_minutes");--> statement-breakpoint
CREATE INDEX "slot_reminders_status_scheduled_idx" ON "slot_reminders" USING btree ("status","scheduled_at");--> statement-breakpoint
-- 2026-10-03: new default reminder schedule is 5h / 15m. Servers still on the old built-in default move to it;
-- a schedule someone customized is left alone.
UPDATE "server_config" SET "reminder_schedule_minutes" = '[300,15]'::jsonb WHERE "reminder_schedule_minutes" = '[180,60,15]'::jsonb;
