-- 2026-10-02: /mari-join language option ("en" | "ar-EG"). NULL = not specified.
-- Written idempotently, same convention as 0008-0014.
ALTER TABLE "voice_join_requests" ADD COLUMN IF NOT EXISTS "language" text;
