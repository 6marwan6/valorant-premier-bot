ALTER TABLE "schedule_polls" ADD COLUMN "agent_board_message_id" text;--> statement-breakpoint
ALTER TABLE "schedule_polls" ADD COLUMN "agent_board_claimed_at" timestamp with time zone;
