CREATE TYPE "public"."player_kind" AS ENUM('PLAYER', 'MEMBER');--> statement-breakpoint
CREATE TYPE "public"."schedule_ai_kind" AS ENUM('VOTE', 'DECLINE');--> statement-breakpoint
CREATE TABLE "schedule_ai_reactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"poll_id" integer NOT NULL,
	"discord_user_id" text NOT NULL,
	"kind" "schedule_ai_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "players" ALTER COLUMN "role" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "kind" "player_kind" DEFAULT 'PLAYER' NOT NULL;--> statement-breakpoint
ALTER TABLE "schedule_ai_reactions" ADD CONSTRAINT "schedule_ai_reactions_poll_id_schedule_polls_id_fk" FOREIGN KEY ("poll_id") REFERENCES "public"."schedule_polls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_ai_reactions_poll_user_kind_idx" ON "schedule_ai_reactions" USING btree ("poll_id","discord_user_id","kind");