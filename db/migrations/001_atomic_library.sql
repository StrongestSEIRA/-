BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS shiori_private.library_requests (
 owner text NOT NULL, request_id text NOT NULL, request_hash text NOT NULL,
 revision bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner,request_id)
);
ALTER TABLE shiori_private.library_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE shiori_private.library_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_scope ON shiori_private.library_requests;
CREATE POLICY owner_scope ON shiori_private.library_requests TO shiori_gateway_role
 USING(owner=current_setting('shiori.owner',true)) WITH CHECK(owner=current_setting('shiori.owner',true));
GRANT SELECT,INSERT ON shiori_private.library_requests TO shiori_gateway_role;
REVOKE ALL ON shiori_private.library_requests FROM PUBLIC,anon,authenticated,service_role;
DO $$ DECLARE had_create boolean:=has_schema_privilege('shiori_gateway_role','shiori_private','CREATE');
 already_member boolean:=pg_has_role(current_user,'shiori_gateway_role','MEMBER');
 modern boolean:=current_setting('server_version_num')::integer>=160000; could_set boolean:=false;
BEGIN
 PERFORM set_config('shiori.migration_operator',current_user,true);
 PERFORM set_config('shiori.migration_had_create',had_create::text,true);
 PERFORM set_config('shiori.migration_was_member',already_member::text,true);
 IF modern THEN could_set:=pg_has_role(current_user,'shiori_gateway_role','SET');END IF;
 PERFORM set_config('shiori.migration_could_set',could_set::text,true);
 IF modern AND NOT could_set THEN EXECUTE format('GRANT shiori_gateway_role TO %I WITH SET TRUE',current_user);
 ELSIF NOT modern AND NOT already_member THEN EXECUTE format('GRANT shiori_gateway_role TO %I',current_user);END IF;
 IF NOT had_create THEN GRANT CREATE ON SCHEMA shiori_private TO shiori_gateway_role; END IF;
END $$;
SET LOCAL ROLE shiori_gateway_role;
CREATE OR REPLACE FUNCTION shiori_private.library_cas(p_owner text,p_revision bigint,p_books jsonb,p_request_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE old_request shiori_private.library_requests%ROWTYPE; v bigint; digest text;
BEGIN
 IF p_owner IS NULL OR length(p_owner) NOT BETWEEN 1 AND 500 OR p_revision IS NULL OR p_revision<0
 OR p_request_id IS NULL OR p_request_id !~ '^[A-Za-z0-9_-]{8,128}$'
 OR jsonb_typeof(p_books) IS DISTINCT FROM 'array' THEN RETURN '{"status":"invalid"}'; END IF;
 digest:=encode(sha256(convert_to(jsonb_build_object('revision',p_revision,'books',p_books)::text,'UTF8')),'hex');
 PERFORM set_config('shiori.owner',p_owner,true);
 PERFORM pg_advisory_xact_lock(hashtextextended(p_owner,0));
 SELECT * INTO old_request FROM shiori_private.library_requests WHERE owner=p_owner AND request_id=p_request_id;
 IF FOUND THEN
  IF old_request.request_hash<>digest THEN RETURN '{"status":"idempotency_mismatch"}'; END IF;
  RETURN jsonb_build_object('status','ok','revision',old_request.revision,'replayed',true);
 END IF;
 IF p_revision=0 THEN
  INSERT INTO shiori_private.roots(owner,data,version) VALUES(p_owner,jsonb_build_object('books',p_books),1)
  ON CONFLICT(owner) DO NOTHING RETURNING version INTO v;
 ELSE
  UPDATE shiori_private.roots SET data=data||jsonb_build_object('books',p_books),version=version+1
  WHERE owner=p_owner AND version=p_revision RETURNING version INTO v;
 END IF;
 IF v IS NULL THEN RETURN jsonb_build_object('status','conflict','revision',coalesce((SELECT version FROM shiori_private.roots WHERE owner=p_owner),0)); END IF;
 INSERT INTO shiori_private.library_requests(owner,request_id,request_hash,revision) VALUES(p_owner,p_request_id,digest,v);
 RETURN jsonb_build_object('status','ok','revision',v,'replayed',false);
END $$;
REVOKE ALL ON FUNCTION shiori_private.library_cas(text,bigint,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION shiori_private.library_cas(text,bigint,jsonb,text) TO service_role;
SELECT set_config('role',current_setting('shiori.migration_operator'),true);
DO $$ BEGIN
 IF NOT current_setting('shiori.migration_had_create')::boolean THEN REVOKE CREATE ON SCHEMA shiori_private FROM shiori_gateway_role;END IF;
 IF NOT current_setting('shiori.migration_was_member')::boolean THEN EXECUTE format('REVOKE shiori_gateway_role FROM %I',current_user);
 ELSIF current_setting('server_version_num')::integer>=160000 AND NOT current_setting('shiori.migration_could_set')::boolean THEN EXECUTE format('GRANT shiori_gateway_role TO %I WITH SET FALSE',current_user);END IF;
END $$;

CREATE OR REPLACE FUNCTION public.shiori_library_cas(p_owner text,p_revision bigint,p_books jsonb,p_request_id text) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT shiori_private.library_cas(p_owner,p_revision,p_books,p_request_id) $$;
REVOKE ALL ON FUNCTION public.shiori_library_cas(text,bigint,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT USAGE ON SCHEMA shiori_private TO service_role;
GRANT EXECUTE ON FUNCTION public.shiori_library_cas(text,bigint,jsonb,text) TO service_role;
COMMIT;
