-- 2026-10-01 (b): /mari-join `listen` option (auto | name | always). NULL = not specified.
-- Written idempotently, same convention as 0008-0013.
ALTER TABLE "voice_join_requests" ADD COLUMN IF NOT EXISTS "listen" text;
