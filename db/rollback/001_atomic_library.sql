-- First switch the app back to SNAPSHOT_WRITE_MODE=legacy and stop new writes.
-- Retain a backup of library_requests before this approved rollback.
BEGIN;
SET LOCAL lock_timeout='5s';
DROP FUNCTION IF EXISTS public.shiori_library_cas(text,bigint,jsonb,text);
DROP FUNCTION IF EXISTS shiori_private.library_cas(text,bigint,jsonb,text);
DROP TABLE IF EXISTS shiori_private.library_requests;
-- Existing roots and all reading data remain untouched.
COMMIT;
