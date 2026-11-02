-- Data-preserving feature rollback, AFTER records_admin(owner,'rollback') for EVERY active owner.
-- Stop writes, back up both models, rehydrate current records, then select atomic snapshot mode.
-- Keep record tables, request IDs, source snapshots and history for investigation/recovery.
BEGIN;
SET LOCAL lock_timeout='5s';
-- A role unable to bypass FORCE RLS must fail, never mistake invisible owners for no active owners.
SET LOCAL row_security=off;
DO $$ BEGIN IF EXISTS(SELECT FROM shiori_private.record_state WHERE active) THEN RAISE EXCEPTION 'active record owners remain; stop writes and rehydrate each owner first';END IF;END $$;
REVOKE EXECUTE ON FUNCTION public.shiori_records(text,text,jsonb) FROM service_role;
COMMIT;
