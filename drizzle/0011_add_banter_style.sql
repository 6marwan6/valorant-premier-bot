-- 2026-09-30: per-player banter style for Mari's personality (neutral / flirty / annoying).
-- Written idempotently, same convention as 0008-0010.
DO $$ BEGIN
 CREATE TYPE "public"."banter_style" AS ENUM('NEUTRAL', 'FLIRTY', 'ANNOYING');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN IF NOT EXISTS "banter_style" "banter_style" DEFAULT 'NEUTRAL' NOT NULL;
