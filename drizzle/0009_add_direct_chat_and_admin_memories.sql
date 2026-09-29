-- 2026-09-28: /mari direct chat (plan section 63's `/ai`, pulled forward)
-- and /add-memory (manual starter facts). Written idempotently, same
-- convention as 0008.
ALTER TYPE "public"."ai_mode" ADD VALUE IF NOT EXISTS 'DIRECT_CHAT';--> statement-breakpoint
ALTER TYPE "public"."memory_evidence_source_type" ADD VALUE IF NOT EXISTS 'ADMIN_ENTRY';--> statement-breakpoint
ALTER TABLE "ai_conversations" ALTER COLUMN "match_id" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_conversations_one_open_direct_chat_idx" ON "ai_conversations" USING btree ("guild_id","player_id") WHERE match_id IS NULL AND ended_at IS NULL;
