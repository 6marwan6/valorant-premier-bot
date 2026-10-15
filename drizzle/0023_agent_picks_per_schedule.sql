-- One squad per schedule (2026-10-15): picks move from "per slot" to "per schedule" - a MAIN agent and an optional
-- SECOND agent per player, the same for every slot that week.
ALTER TABLE "agent_picks" ADD COLUMN IF NOT EXISTS "poll_id" integer;
--> statement-breakpoint
ALTER TABLE "agent_picks" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'MAIN' NOT NULL;
--> statement-breakpoint
-- Only runs while the old slot_id column still exists (the migration is safe to re-run on a half-migrated database).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_picks' AND column_name = 'slot_id') THEN
    UPDATE "agent_picks" p SET "poll_id" = s."poll_id" FROM "schedule_slots" s WHERE s."id" = p."slot_id" AND p."poll_id" IS NULL;

    -- Fold each player's per-slot picks into at most two: the pick for their earliest slot becomes the MAIN, the first
    -- *different* agent from another slot becomes the SECOND, and everything else (repeats of the same agent in other
    -- slots, a third agent...) is dropped.
    CREATE TEMP TABLE "agent_picks_keep" ON COMMIT DROP AS
    WITH ordered AS (
      SELECT p."id", p."poll_id", p."discord_user_id",
             ROW_NUMBER() OVER (PARTITION BY p."poll_id", p."discord_user_id", p."agent_key" ORDER BY s."position", p."id") AS same_agent_rn,
             s."position" AS pos
      FROM "agent_picks" p JOIN "schedule_slots" s ON s."id" = p."slot_id"
    )
    SELECT "id", ROW_NUMBER() OVER (PARTITION BY "poll_id", "discord_user_id" ORDER BY pos, "id") AS n
    FROM ordered WHERE same_agent_rn = 1;

    UPDATE "agent_picks" p SET "kind" = CASE k.n WHEN 1 THEN 'MAIN' ELSE 'SECOND' END
    FROM "agent_picks_keep" k WHERE k."id" = p."id" AND k.n <= 2;

    DELETE FROM "agent_picks" p WHERE NOT EXISTS (SELECT 1 FROM "agent_picks_keep" k WHERE k."id" = p."id" AND k.n <= 2);
  END IF;
END $$;
--> statement-breakpoint
-- A MAIN agent can be held by one player per schedule: where two players held the same agent in different slots, the earlier pick keeps it.
DELETE FROM "agent_picks" p USING (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "poll_id", "agent_key" ORDER BY "id") AS rn FROM "agent_picks" WHERE "kind" = 'MAIN'
) d WHERE d."id" = p."id" AND d.rn > 1;
--> statement-breakpoint
-- A SECOND needs a MAIN: drop any that lost theirs above.
DELETE FROM "agent_picks" p WHERE p."kind" = 'SECOND' AND NOT EXISTS (
  SELECT 1 FROM "agent_picks" m WHERE m."poll_id" = p."poll_id" AND m."discord_user_id" = p."discord_user_id" AND m."kind" = 'MAIN'
);
--> statement-breakpoint
DROP INDEX IF EXISTS "agent_picks_slot_user_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "agent_picks_slot_agent_idx";
--> statement-breakpoint
ALTER TABLE "agent_picks" DROP COLUMN IF EXISTS "slot_id";
--> statement-breakpoint
ALTER TABLE "agent_picks" ALTER COLUMN "poll_id" SET NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_picks" ADD CONSTRAINT "agent_picks_poll_id_schedule_polls_id_fk" FOREIGN KEY ("poll_id") REFERENCES "public"."schedule_polls"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_picks_poll_user_kind_idx" ON "agent_picks" USING btree ("poll_id","discord_user_id","kind");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_picks_poll_main_agent_idx" ON "agent_picks" USING btree ("poll_id","agent_key") WHERE "agent_picks"."kind" = 'MAIN';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_picks_poll_user_agent_idx" ON "agent_picks" USING btree ("poll_id","discord_user_id","agent_key");
