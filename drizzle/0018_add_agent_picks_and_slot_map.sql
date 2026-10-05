CREATE TABLE "agent_picks" (
	"id" serial PRIMARY KEY NOT NULL,
	"slot_id" integer NOT NULL,
	"discord_user_id" text NOT NULL,
	"agent_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_agents" (
	"id" serial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"key" text NOT NULL,
	"display_name" text NOT NULL,
	"role" "player_role" NOT NULL,
	"suggested_by_user_id" text NOT NULL,
	"suggested_by_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "schedule_slots" ADD COLUMN "map" text;--> statement-breakpoint
ALTER TABLE "agent_picks" ADD CONSTRAINT "agent_picks_slot_id_schedule_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."schedule_slots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_agents" ADD CONSTRAINT "custom_agents_guild_id_server_config_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."server_config"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_picks_slot_user_idx" ON "agent_picks" USING btree ("slot_id","discord_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_picks_slot_agent_idx" ON "agent_picks" USING btree ("slot_id","agent_key");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_agents_guild_key_idx" ON "custom_agents" USING btree ("guild_id","key");