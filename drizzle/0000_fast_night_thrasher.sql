CREATE TABLE "server_config" (
	"guild_id" text PRIMARY KEY NOT NULL,
	"timezone" text DEFAULT 'Europe/Berlin' NOT NULL,
	"match_channel_id" text,
	"admin_role_id" text,
	"reminder_schedule_minutes" jsonb DEFAULT '[180,60,15]'::jsonb NOT NULL,
	"default_roast_intensity" integer DEFAULT 50 NOT NULL,
	"default_memory_policy" text DEFAULT 'CONSERVATIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
