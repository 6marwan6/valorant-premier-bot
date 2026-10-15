ALTER TABLE "schedule_vote_nudges" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'FIRST' NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS "schedule_vote_nudges_poll_user_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "schedule_vote_nudges_poll_user_kind_idx" ON "schedule_vote_nudges" USING btree ("poll_id","discord_user_id","kind");
