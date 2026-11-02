BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE IF NOT EXISTS shiori_private.record_state(owner text PRIMARY KEY,active boolean NOT NULL DEFAULT false,revision bigint NOT NULL DEFAULT 0,source_revision bigint NOT NULL DEFAULT 0,source_data jsonb NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS shiori_private.record_books(owner text NOT NULL,id text NOT NULL,data jsonb NOT NULL,version bigint NOT NULL,notes_version bigint NOT NULL DEFAULT 0,position bigint NOT NULL DEFAULT 0,PRIMARY KEY(owner,id));
CREATE TABLE IF NOT EXISTS shiori_private.record_notes(owner text NOT NULL,book_id text NOT NULL,id text NOT NULL,data jsonb NOT NULL,version bigint NOT NULL,position bigint NOT NULL DEFAULT 0,PRIMARY KEY(owner,book_id,id),FOREIGN KEY(owner,book_id) REFERENCES shiori_private.record_books(owner,id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS shiori_private.record_requests(owner text NOT NULL,request_id text NOT NULL,request_hash text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner,request_id));
CREATE INDEX IF NOT EXISTS record_books_order ON shiori_private.record_books(owner,position,id);
CREATE INDEX IF NOT EXISTS record_notes_text ON shiori_private.record_notes USING gin(to_tsvector('simple',coalesce(data->>'text','')));
CREATE INDEX IF NOT EXISTS record_books_tags ON shiori_private.record_books USING gin((data->'tags'));
CREATE INDEX IF NOT EXISTS record_notes_tags ON shiori_private.record_notes USING gin((data->'tags'));
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['record_state','record_books','record_notes','record_requests'] LOOP
 EXECUTE format('ALTER TABLE shiori_private.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE shiori_private.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('DROP POLICY IF EXISTS owner_scope ON shiori_private.%I',t);
 EXECUTE format('CREATE POLICY owner_scope ON shiori_private.%I TO shiori_gateway_role USING(owner=current_setting(''shiori.owner'',true)) WITH CHECK(owner=current_setting(''shiori.owner'',true))',t);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON shiori_private.%I TO shiori_gateway_role',t);
 EXECUTE format('REVOKE ALL ON shiori_private.%I FROM PUBLIC,anon,authenticated,service_role',t);
END LOOP;END $$;
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
CREATE OR REPLACE FUNCTION shiori_private.valid_record(d jsonb,kind text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT coalesce(jsonb_typeof(d)='object' AND d->>'id' ~ '^[A-Za-z0-9_-]{1,200}$' AND
 jsonb_typeof(d->'tags')='array' AND NOT EXISTS(SELECT FROM jsonb_array_elements(CASE WHEN jsonb_typeof(d->'tags')='array' THEN d->'tags' ELSE '[]' END) x WHERE jsonb_typeof(x)<>'string') AND
 CASE WHEN kind='book' THEN jsonb_typeof(d->'title')='string' AND jsonb_typeof(d->'author')='string' AND jsonb_typeof(d->'date')='string' AND jsonb_typeof(d->'summary')='string' AND NOT(d?'notes') ELSE jsonb_typeof(d->'text')='string' AND (NOT(d?'links') OR jsonb_typeof(d->'links')='array' AND NOT EXISTS(SELECT FROM jsonb_array_elements(CASE WHEN jsonb_typeof(d->'links')='array' THEN d->'links' ELSE '[]' END) x WHERE jsonb_typeof(x)<>'string' OR (x#>>'{}') !~ '^[A-Za-z0-9_-]{1,200}$')) END,false)
$$;
CREATE OR REPLACE FUNCTION shiori_private.records_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM set_config('shiori.owner',coalesce(NEW.owner,OLD.owner),true);
 PERFORM pg_advisory_xact_lock(hashtextextended(coalesce(NEW.owner,OLD.owner),0));
 IF EXISTS(SELECT FROM shiori_private.record_state WHERE owner=coalesce(NEW.owner,OLD.owner) AND active) THEN RAISE EXCEPTION 'record storage is active; reload the app' USING ERRCODE='PT409';END IF;
 RETURN coalesce(NEW,OLD);
END $$;
CREATE OR REPLACE FUNCTION shiori_private.records_admin(p_owner text,p_direction text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r shiori_private.roots%ROWTYPE;b jsonb;n jsonb;bi bigint:=0;ni bigint;v bigint;restored jsonb;
BEGIN
 IF p_owner IS NULL OR length(p_owner) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'invalid owner';END IF;
 PERFORM set_config('shiori.owner',p_owner,true);PERFORM pg_advisory_xact_lock(hashtextextended(p_owner,0));
 IF p_direction='migrate' THEN
  IF EXISTS(SELECT FROM shiori_private.record_state WHERE owner=p_owner AND active) THEN RETURN '{"status":"already_active"}';END IF;
  IF EXISTS(SELECT FROM shiori_private.record_state WHERE owner=p_owner) THEN RAISE EXCEPTION 'previous migration exists; operator review required';END IF;
  SELECT * INTO r FROM shiori_private.roots WHERE owner=p_owner;
  IF NOT FOUND THEN r.data:='{"books":[]}';r.version:=0;END IF;
  IF jsonb_typeof(r.data->'books') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'invalid source books';END IF;
  INSERT INTO shiori_private.record_state(owner,active,revision,source_revision,source_data) VALUES(p_owner,false,1,r.version,r.data);
  FOR b IN SELECT value FROM jsonb_array_elements(r.data->'books') LOOP
   IF NOT shiori_private.valid_record(b-'notes','book') OR jsonb_typeof(b->'notes') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'invalid source book';END IF;
   INSERT INTO shiori_private.record_books VALUES(p_owner,b->>'id',b-'notes',1,1,bi);bi:=bi+1;ni:=0;
   FOR n IN SELECT value FROM jsonb_array_elements(b->'notes') LOOP
    IF NOT shiori_private.valid_record(n,'note') THEN RAISE EXCEPTION 'invalid source note';END IF;
    INSERT INTO shiori_private.record_notes VALUES(p_owner,b->>'id',n->>'id',n,1,ni);ni:=ni+1;
   END LOOP;
  END LOOP;
  UPDATE shiori_private.record_state SET active=true WHERE owner=p_owner;
  RETURN jsonb_build_object('status','ok','books',bi);
 ELSIF p_direction='rollback' THEN
  IF NOT EXISTS(SELECT FROM shiori_private.record_state WHERE owner=p_owner AND active) THEN RAISE EXCEPTION 'no active migration';END IF;
  SELECT coalesce(jsonb_agg(x.data||jsonb_build_object('notes',coalesce((SELECT jsonb_agg(n.data ORDER BY n.position,n.id) FROM shiori_private.record_notes n WHERE n.owner=p_owner AND n.book_id=x.id),'[]')) ORDER BY x.position,x.id),'[]') INTO restored FROM shiori_private.record_books x WHERE x.owner=p_owner;
  UPDATE shiori_private.record_state SET active=false WHERE owner=p_owner RETURNING revision INTO v;
  INSERT INTO shiori_private.roots(owner,data,version) SELECT p_owner,source_data||jsonb_build_object('books',restored),greatest(source_revision,revision)+1 FROM shiori_private.record_state WHERE owner=p_owner
   ON CONFLICT(owner) DO UPDATE SET data=excluded.data,version=greatest(shiori_private.roots.version,excluded.version)+1;
  RETURN jsonb_build_object('status','ok','books',jsonb_array_length(restored));
 END IF;
 RAISE EXCEPTION 'invalid direction';
END $$;
CREATE OR REPLACE FUNCTION shiori_private.records_rpc(p_owner text,p_action text,p_payload jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s shiori_private.record_state%ROWTYPE;old_request shiori_private.record_requests%ROWTYPE;digest text;o jsonb;d jsonb;kind text;bid text;rid text;ver bigint;nv bigint;v bigint;affected integer;changes jsonb:='[]';items jsonb;result jsonb;take integer;pos bigint;after_book text;after_id text;tag text;q text;
BEGIN
 IF p_owner IS NULL OR length(p_owner) NOT BETWEEN 1 AND 500 OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN RETURN '{"status":"invalid"}';END IF;
 PERFORM set_config('shiori.owner',p_owner,true);PERFORM pg_advisory_xact_lock(hashtextextended(p_owner,0));
 SELECT * INTO s FROM shiori_private.record_state WHERE owner=p_owner;
 IF NOT FOUND THEN
  IF EXISTS(SELECT FROM shiori_private.roots WHERE owner=p_owner AND data IS DISTINCT FROM '{"books":[]}'::jsonb) THEN RETURN '{"status":"migration_required"}';END IF;
  INSERT INTO shiori_private.record_state(owner,active) VALUES(p_owner,true) RETURNING * INTO s;
 END IF;
 IF NOT s.active THEN RETURN '{"status":"migration_required"}';END IF;
 IF p_payload?'revision' AND (p_payload->>'revision')::bigint<>s.revision THEN RETURN '{"status":"conflict"}';END IF;
 take:=greatest(1,least(200,coalesce((p_payload->>'limit')::integer,100)));
 after_book:=coalesce(p_payload->>'afterBook','');after_id:=coalesce(p_payload->>'after','');tag:=p_payload->>'tag';q:=p_payload->>'q';
 IF p_action='books' THEN
  SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') INTO items FROM (
   SELECT id,data,version,notes_version,position FROM shiori_private.record_books b WHERE owner=p_owner AND id>after_id
   AND (NOT(p_payload?'id') OR id=p_payload->>'id')
   AND (tag IS NULL OR coalesce(data->'tags','[]')?tag OR EXISTS(SELECT FROM shiori_private.record_notes n WHERE n.owner=p_owner AND n.book_id=b.id AND coalesce(n.data->'tags','[]')?tag))
   AND (q IS NULL OR position(lower(q) IN lower(coalesce(data->>'title','')||' '||coalesce(data->>'author','')))>0)
   ORDER BY id LIMIT take) x;
 ELSIF p_action='notes' THEN
  SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY book_id,id),'[]') INTO items FROM (
   SELECT book_id,id,data,version,position FROM shiori_private.record_notes WHERE owner=p_owner AND (book_id,id)>(after_book,after_id)
   AND (NOT(p_payload?'bookId') OR book_id=p_payload->>'bookId') AND (NOT(p_payload?'id') OR id=p_payload->>'id')
   AND (tag IS NULL OR coalesce(data->'tags','[]')?tag) AND (q IS NULL OR position(lower(q) IN lower(data->>'text'))>0)
   ORDER BY book_id,id LIMIT take) x;
 ELSIF p_action='usage' THEN
  RETURN jsonb_build_object('status','ok','revision',s.revision,'books',(SELECT count(*) FROM shiori_private.record_books WHERE owner=p_owner),'notes',(SELECT count(*) FROM shiori_private.record_notes WHERE owner=p_owner),'logicalBytes',(SELECT coalesce(sum(octet_length(data::text)),0) FROM(SELECT data FROM shiori_private.record_books WHERE owner=p_owner UNION ALL SELECT data FROM shiori_private.record_notes WHERE owner=p_owner)x));
 ELSIF p_action='apply' THEN
  IF jsonb_typeof(p_payload->'operations') IS DISTINCT FROM 'array' OR jsonb_array_length(p_payload->'operations') NOT BETWEEN 1 AND 20000 OR coalesce(p_payload->>'requestId','') !~ '^[A-Za-z0-9_-]{8,128}$' THEN RETURN '{"status":"invalid"}';END IF;
  digest:=encode(sha256(convert_to((p_payload->'operations')::text,'UTF8')),'hex');
  SELECT * INTO old_request FROM shiori_private.record_requests WHERE owner=p_owner AND request_id=p_payload->>'requestId';
  IF FOUND THEN
   IF old_request.request_hash<>digest THEN RETURN '{"status":"idempotency_mismatch"}';END IF;
   RETURN old_request.result||'{"replayed":true}';
  END IF;
  v:=s.revision+1;
  BEGIN
   FOR o IN SELECT value FROM jsonb_array_elements(p_payload->'operations') LOOP
    kind:=o->>'kind';rid:=o->>'id';bid:=o->>'bookId';d:=o->'data';ver:=(o->>'version')::bigint;
    IF kind IS NULL OR kind NOT IN('book','note') OR rid IS NULL OR rid !~ '^[A-Za-z0-9_-]{1,200}$' OR ver IS NULL OR ver<0 OR o->>'action' IS NULL OR o->>'action' NOT IN('put','delete') OR (kind='note' AND (bid IS NULL OR bid !~ '^[A-Za-z0-9_-]{1,200}$')) THEN RAISE EXCEPTION 'invalid' USING ERRCODE='PT400';END IF;
    IF o->>'action'='put' AND (NOT shiori_private.valid_record(d,kind) OR d->>'id' IS DISTINCT FROM rid) THEN RAISE EXCEPTION 'invalid' USING ERRCODE='PT400';END IF;
    IF o->>'action'='delete' AND ver=0 THEN RAISE EXCEPTION 'invalid' USING ERRCODE='PT400';END IF;
    IF kind='book' THEN
     IF o->>'action'='delete' THEN
      DELETE FROM shiori_private.record_books WHERE owner=p_owner AND id=rid AND version=ver AND notes_version=(o->>'notesVersion')::bigint;
     ELSIF ver=0 THEN
      SELECT coalesce(min(position),0)-1 INTO pos FROM shiori_private.record_books WHERE owner=p_owner;
      INSERT INTO shiori_private.record_books VALUES(p_owner,rid,d,v,0,pos) ON CONFLICT DO NOTHING;
     ELSE
      UPDATE shiori_private.record_books SET data=d,version=v WHERE owner=p_owner AND id=rid AND version=ver;
     END IF;
     GET DIAGNOSTICS affected=ROW_COUNT;
    ELSE
     IF NOT EXISTS(SELECT FROM shiori_private.record_books WHERE owner=p_owner AND id=bid) THEN RAISE EXCEPTION 'conflict' USING ERRCODE='PT409';END IF;
     IF o->>'action'='delete' THEN DELETE FROM shiori_private.record_notes WHERE owner=p_owner AND book_id=bid AND id=rid AND version=ver;
     ELSIF ver=0 THEN
      SELECT coalesce(min(position),0)-1 INTO pos FROM shiori_private.record_notes WHERE owner=p_owner AND book_id=bid;
      INSERT INTO shiori_private.record_notes VALUES(p_owner,bid,rid,d,v,pos) ON CONFLICT DO NOTHING;
     ELSE UPDATE shiori_private.record_notes SET data=d,version=v WHERE owner=p_owner AND book_id=bid AND id=rid AND version=ver;
     END IF;
     GET DIAGNOSTICS affected=ROW_COUNT;
     UPDATE shiori_private.record_books SET notes_version=v WHERE owner=p_owner AND id=bid;
    END IF;
    IF affected<>1 THEN RAISE EXCEPTION 'conflict' USING ERRCODE='PT409';END IF;
    SELECT notes_version INTO nv FROM shiori_private.record_books WHERE owner=p_owner AND id=CASE WHEN kind='book' THEN rid ELSE bid END;
    changes:=changes||jsonb_build_array(jsonb_build_object('kind',kind,'id',rid,'bookId',bid,'action',o->>'action','version',v,'notesVersion',nv));
   END LOOP;
   UPDATE shiori_private.record_state SET revision=v WHERE owner=p_owner;
  EXCEPTION WHEN SQLSTATE 'PT409' THEN RETURN '{"status":"conflict"}';WHEN SQLSTATE 'PT400' OR invalid_text_representation OR numeric_value_out_of_range OR check_violation THEN RETURN '{"status":"invalid"}';END;
  result:=jsonb_build_object('status','ok','revision',v,'changes',changes);
  INSERT INTO shiori_private.record_requests(owner,request_id,request_hash,result) VALUES(p_owner,p_payload->>'requestId',digest,result);
  RETURN result;
 ELSE RETURN '{"status":"invalid"}';END IF;
 RETURN jsonb_build_object('status','ok','revision',s.revision,'items',items,'hasMore',jsonb_array_length(items)=take);
END $$;
REVOKE ALL ON FUNCTION shiori_private.valid_record(jsonb,text),shiori_private.records_guard(),shiori_private.records_admin(text,text),shiori_private.records_rpc(text,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION shiori_private.records_rpc(text,text,jsonb) TO service_role;
DO $$ BEGIN EXECUTE format('GRANT EXECUTE ON FUNCTION shiori_private.records_admin(text,text),shiori_private.records_guard() TO %I',current_setting('shiori.migration_operator'));END $$;
SELECT set_config('role',current_setting('shiori.migration_operator'),true);
DO $$ BEGIN
 IF NOT current_setting('shiori.migration_had_create')::boolean THEN REVOKE CREATE ON SCHEMA shiori_private FROM shiori_gateway_role;END IF;
 IF NOT current_setting('shiori.migration_was_member')::boolean THEN EXECUTE format('REVOKE shiori_gateway_role FROM %I',current_user);
 ELSIF current_setting('server_version_num')::integer>=160000 AND NOT current_setting('shiori.migration_could_set')::boolean THEN EXECUTE format('GRANT shiori_gateway_role TO %I WITH SET FALSE',current_user);END IF;
END $$;


DROP TRIGGER IF EXISTS audit_record_books ON shiori_private.record_books;
CREATE TRIGGER audit_record_books AFTER INSERT OR UPDATE OF data OR DELETE ON shiori_private.record_books FOR EACH ROW EXECUTE FUNCTION shiori_private.audit_row();
DROP TRIGGER IF EXISTS audit_record_notes ON shiori_private.record_notes;
CREATE TRIGGER audit_record_notes AFTER INSERT OR UPDATE OR DELETE ON shiori_private.record_notes FOR EACH ROW EXECUTE FUNCTION shiori_private.audit_row();
DROP TRIGGER IF EXISTS guard_record_storage ON shiori_private.roots;
CREATE TRIGGER guard_record_storage BEFORE INSERT OR UPDATE OR DELETE ON shiori_private.roots FOR EACH ROW EXECUTE FUNCTION shiori_private.records_guard();
CREATE OR REPLACE FUNCTION public.shiori_records(p_owner text,p_action text,p_payload jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT shiori_private.records_rpc(p_owner,p_action,p_payload) $$;
REVOKE ALL ON FUNCTION public.shiori_records(text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.shiori_records(text,text,jsonb) TO service_role;
COMMIT;
