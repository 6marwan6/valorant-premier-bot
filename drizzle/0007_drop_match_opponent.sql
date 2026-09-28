DROP INDEX "matches_guild_opponent_time_active_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "matches_guild_time_active_idx" ON "matches" USING btree ("guild_id","scheduled_at") WHERE status <> 'CANCELLED';--> statement-breakpoint
ALTER TABLE "matches" DROP COLUMN "opponent";