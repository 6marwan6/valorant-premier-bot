-- 2026-10-01: /mari-join voice options (voice, direction, pitch). NULL = not specified.
-- Written idempotently, same convention as 0008-0012.
ALTER TABLE "voice_join_requests" ADD COLUMN IF NOT EXISTS "voice" text;--> statement-breakpoint
ALTER TABLE "voice_join_requests" ADD COLUMN IF NOT EXISTS "direction" text;--> statement-breakpoint
ALTER TABLE "voice_join_requests" ADD COLUMN IF NOT EXISTS "pitch" real;
