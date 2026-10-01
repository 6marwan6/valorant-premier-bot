-- 2026-10-01: /mari-join — an admin tells Mari which voice channel to join and when.
-- Written idempotently, same convention as 0008-0011.
DO $$ BEGIN
 CREATE TYPE "public"."voice_join_status" AS ENUM('PENDING', 'CLAIMED', 'DONE', 'CANCELLED', 'EXPIRED', 'FAILED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "voice_join_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"join_at" timestamp with time zone NOT NULL,
	"status" "voice_join_status" DEFAULT 'PENDING' NOT NULL,
	"requested_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"handled_at" timestamp with time zone
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "voice_join_requests_one_pending_idx" ON "voice_join_requests" USING btree ("guild_id") WHERE status = 'PENDING';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "voice_join_requests_status_join_at_idx" ON "voice_join_requests" USING btree ("status","join_at");
