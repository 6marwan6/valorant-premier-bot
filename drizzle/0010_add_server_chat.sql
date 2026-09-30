-- 2026-09-29: server chat (`/mari` / `@Mari` in the server) alongside the DM
-- chat. Written idempotently, same convention as 0008/0009.
ALTER TYPE "public"."ai_mode" ADD VALUE IF NOT EXISTS 'SERVER_CHAT';--> statement-breakpoint
DROP INDEX IF EXISTS "ai_conversations_one_open_direct_chat_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_conversations_one_open_chat_idx" ON "ai_conversations" USING btree ("guild_id","player_id","mode") WHERE match_id IS NULL AND ended_at IS NULL;
