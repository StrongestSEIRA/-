BEGIN;

DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='shiori_gateway_role') THEN CREATE ROLE shiori_gateway_role NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$;
CREATE SCHEMA shiori_private;
REVOKE ALL ON SCHEMA shiori_private FROM PUBLIC;

CREATE TABLE shiori_private.roots(owner text PRIMARY KEY,data jsonb NOT NULL DEFAULT '{}',version bigint NOT NULL DEFAULT 1);
CREATE TABLE shiori_private.books(owner text NOT NULL,id text NOT NULL,data jsonb NOT NULL,version bigint NOT NULL DEFAULT 1,PRIMARY KEY(owner,id));
CREATE TABLE shiori_private.notes(owner text NOT NULL,book_id text NOT NULL,id text NOT NULL,data jsonb NOT NULL,version bigint NOT NULL DEFAULT 1,PRIMARY KEY(owner,book_id,id),FOREIGN KEY(owner,book_id) REFERENCES shiori_private.books(owner,id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE shiori_private.history(event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,owner text NOT NULL,kind text NOT NULL,before_row jsonb,after_row jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE INDEX history_owner_event ON shiori_private.history(owner,event_id);
CREATE INDEX notes_owner_book ON shiori_private.notes(owner,book_id,id);

DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['roots','books','notes','history'] LOOP
 EXECUTE format('ALTER TABLE shiori_private.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE shiori_private.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY owner_scope ON shiori_private.%I TO shiori_gateway_role USING (owner = current_setting(''shiori.owner'',true)) WITH CHECK (owner = current_setting(''shiori.owner'',true))',t);
 END LOOP;END $$;

GRANT USAGE ON SCHEMA shiori_private TO shiori_gateway_role;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA shiori_private TO shiori_gateway_role;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA shiori_private TO shiori_gateway_role;

CREATE FUNCTION shiori_private.audit_row() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 INSERT INTO shiori_private.history(owner,kind,before_row,after_row) VALUES(coalesce(NEW.owner,OLD.owner),TG_TABLE_NAME,CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END);
 RETURN coalesce(NEW,OLD);
END $$;

CREATE TRIGGER audit_books AFTER INSERT OR UPDATE OR DELETE ON shiori_private.books FOR EACH ROW EXECUTE FUNCTION shiori_private.audit_row();
CREATE TRIGGER audit_notes AFTER INSERT OR UPDATE OR DELETE ON shiori_private.notes FOR EACH ROW EXECUTE FUNCTION shiori_private.audit_row();
CREATE TRIGGER audit_roots AFTER INSERT OR UPDATE OR DELETE ON shiori_private.roots FOR EACH ROW EXECUTE FUNCTION shiori_private.audit_row();

CREATE FUNCTION shiori_private.gateway_impl(p_owner text,p_action text,p_payload jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE o jsonb; d jsonb; result jsonb; changed integer; take integer; op_version bigint;
BEGIN
 IF p_owner IS NULL OR length(p_owner)<1 OR length(p_owner)>500 THEN RAISE EXCEPTION 'invalid owner'; END IF;
 PERFORM set_config('shiori.owner',p_owner,true);
 take:=greatest(1,least(200,coalesce((p_payload->>'limit')::integer,100)));
 IF p_action='restore' THEN RETURN shiori_private.restore_gateway(p_owner,p_payload);
 ELSIF p_action='ui' THEN
  RETURN shiori_private.ui_gateway(p_owner,p_payload->>'action',coalesce(p_payload->'payload','{}'));
 ELSIF p_action='checkpoint' THEN
  RETURN jsonb_build_object('event',(SELECT coalesce(max(event_id),0) FROM shiori_private.history WHERE owner=p_owner));
 ELSIF p_action='list_books' THEN
  SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') INTO result FROM (SELECT * FROM shiori_private.books WHERE owner=p_owner AND id>coalesce(p_payload->>'after','') ORDER BY id LIMIT take) x;RETURN result;
 ELSIF p_action='list_notes' THEN
  SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') INTO result FROM (SELECT * FROM shiori_private.notes WHERE owner=p_owner AND (book_id,id)>(coalesce(p_payload->>'afterBook',''),coalesce(p_payload->>'after','')) AND (NOT(p_payload?'bookId') OR book_id=p_payload->>'bookId') AND (NOT(p_payload?'q') OR position(lower(p_payload->>'q') IN lower(data->>'text'))>0) AND (NOT(p_payload?'tag') OR coalesce(data->'tags','[]') ? (p_payload->>'tag')) ORDER BY book_id,id LIMIT take) x;RETURN result;
 ELSIF p_action='root' THEN
  RETURN coalesce((SELECT to_jsonb(r) FROM shiori_private.roots r WHERE owner=p_owner),'null');
 ELSIF p_action='history' THEN
  SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') INTO result FROM (SELECT * FROM shiori_private.history WHERE owner=p_owner AND event_id>coalesce((p_payload->>'after')::bigint,0) ORDER BY event_id LIMIT take) x;RETURN result;
 ELSIF p_action='usage' THEN
  RETURN jsonb_build_object('books',(SELECT count(*) FROM shiori_private.books WHERE owner=p_owner),'notes',(SELECT count(*) FROM shiori_private.notes WHERE owner=p_owner),'historyEvents',(SELECT count(*) FROM shiori_private.history WHERE owner=p_owner),'logicalBytes',(SELECT coalesce(sum(octet_length(data::text)),0) FROM (SELECT data FROM shiori_private.books WHERE owner=p_owner UNION ALL SELECT data FROM shiori_private.notes WHERE owner=p_owner) x));
 ELSIF p_action<>'apply' THEN RAISE EXCEPTION 'invalid action'; END IF;
 IF jsonb_typeof(p_payload->'operations') IS DISTINCT FROM 'array' OR jsonb_array_length(p_payload->'operations') NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'invalid operations'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_owner,0));
 FOR o IN SELECT value FROM jsonb_array_elements(p_payload->'operations') LOOP
  IF (o->>'kind') NOT IN ('books','notes','roots') OR (o->>'action') NOT IN ('create','patch','replace','delete') OR o->>'kind' IS NULL OR o->>'action' IS NULL THEN RAISE EXCEPTION 'invalid operation'; END IF;
  IF o->>'kind'<>'roots' AND (coalesce(o->>'id','')='' OR length(o->>'id')>200) THEN RAISE EXCEPTION 'invalid id'; END IF;
  d:=o->'data';op_version:=coalesce((o->>'version')::bigint,0);
  IF o->>'action'<>'delete' AND jsonb_typeof(d) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'invalid data';END IF;
  IF o->>'kind'='books' THEN
   IF o->>'action'='create' THEN INSERT INTO shiori_private.books(owner,id,data,version) VALUES(p_owner,o->>'id',d,1);
   ELSIF o->>'action' IN ('patch','replace') THEN UPDATE shiori_private.books SET data=CASE WHEN o->>'action'='replace' THEN d ELSE data||d END,version=version+1 WHERE owner=p_owner AND id=o->>'id' AND version=op_version;
   ELSE DELETE FROM shiori_private.books WHERE owner=p_owner AND id=o->>'id' AND version=op_version; END IF;
  ELSIF o->>'kind'='notes' THEN
   IF coalesce(o->>'bookId','')='' THEN RAISE EXCEPTION 'invalid book'; END IF;
   IF o->>'action'='create' THEN INSERT INTO shiori_private.notes(owner,book_id,id,data,version) VALUES(p_owner,o->>'bookId',o->>'id',d,1);
   ELSIF o->>'action' IN ('patch','replace') THEN UPDATE shiori_private.notes SET data=CASE WHEN o->>'action'='replace' THEN d ELSE data||d END,version=version+1 WHERE owner=p_owner AND book_id=o->>'bookId' AND id=o->>'id' AND version=op_version;
   ELSE DELETE FROM shiori_private.notes WHERE owner=p_owner AND book_id=o->>'bookId' AND id=o->>'id' AND version=op_version; END IF;
  ELSE
   IF o->>'action'='create' THEN INSERT INTO shiori_private.roots VALUES(p_owner,d,1);
   ELSIF o->>'action' IN ('patch','replace') THEN UPDATE shiori_private.roots SET data=CASE WHEN o->>'action'='replace' THEN d ELSE data||d END,version=version+1 WHERE owner=p_owner AND version=op_version;
   ELSE DELETE FROM shiori_private.roots WHERE owner=p_owner AND version=op_version; END IF;
  END IF;
  GET DIAGNOSTICS changed=ROW_COUNT;IF changed<>1 THEN RAISE EXCEPTION 'version conflict' USING ERRCODE='40001';END IF;
 END LOOP;
 RETURN jsonb_build_object('applied',true);
END $$;

REVOKE ALL ON FUNCTION shiori_private.gateway_impl(text,text,jsonb) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.shiori_gateway(p_owner text,p_action text,p_payload jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT shiori_private.gateway_impl(p_owner,p_action,p_payload) $$;
REVOKE ALL ON FUNCTION public.shiori_gateway(text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.shiori_gateway(text,text,jsonb) TO service_role;
GRANT USAGE ON SCHEMA shiori_private TO service_role;
GRANT EXECUTE ON FUNCTION shiori_private.gateway_impl(text,text,jsonb) TO service_role;
REVOKE ALL ON ALL TABLES IN SCHEMA shiori_private FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA shiori_private FROM PUBLIC,anon,authenticated,service_role;

ALTER TABLE shiori_private.books ADD COLUMN position bigint NOT NULL DEFAULT 0, ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE shiori_private.notes ADD COLUMN position bigint NOT NULL DEFAULT 0, ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX books_owner_position ON shiori_private.books(owner,position,id);
CREATE TABLE shiori_private.registered_users(owner text PRIMARY KEY,created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE shiori_private.registered_users ENABLE ROW LEVEL SECURITY;ALTER TABLE shiori_private.registered_users FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_scope ON shiori_private.registered_users TO shiori_gateway_role USING(owner=current_setting('shiori.owner',true)) WITH CHECK(owner=current_setting('shiori.owner',true));
GRANT SELECT,INSERT ON shiori_private.registered_users TO shiori_gateway_role;REVOKE ALL ON shiori_private.registered_users FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE shiori_private.cover_assets(owner text NOT NULL,id text NOT NULL,key text NOT NULL,mime text NOT NULL,bytes bigint NOT NULL,sha256 text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner,id),UNIQUE(owner,key));
CREATE TABLE shiori_private.usage_daily(owner text NOT NULL,day date NOT NULL DEFAULT current_date,kind text NOT NULL,amount bigint NOT NULL,PRIMARY KEY(owner,day,kind));
ALTER TABLE shiori_private.cover_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE shiori_private.cover_assets FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_scope ON shiori_private.cover_assets TO shiori_gateway_role USING(owner=current_setting('shiori.owner',true)) WITH CHECK(owner=current_setting('shiori.owner',true));
ALTER TABLE shiori_private.usage_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE shiori_private.usage_daily FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_scope ON shiori_private.usage_daily TO shiori_gateway_role USING(owner=current_setting('shiori.owner',true)) WITH CHECK(owner=current_setting('shiori.owner',true));
GRANT SELECT,INSERT,UPDATE,DELETE ON shiori_private.cover_assets,shiori_private.usage_daily TO shiori_gateway_role;
REVOKE ALL ON shiori_private.cover_assets,shiori_private.usage_daily FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION shiori_private.normal_text(t text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path='' AS $$ SELECT trim(regexp_replace(lower(normalize(coalesce(t,''),NFKC)),'\s+',' ','g')) $$;
CREATE FUNCTION shiori_private.timestamps() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF current_setting('shiori.restoring',true)='true' THEN RETURN NEW;END IF;
 IF TG_OP='INSERT' THEN
  IF TG_TABLE_NAME='books' THEN SELECT coalesce(max(position),0)+1 INTO NEW.position FROM shiori_private.books WHERE owner=NEW.owner;
  ELSE SELECT coalesce(max(position),0)+1 INTO NEW.position FROM shiori_private.notes WHERE owner=NEW.owner AND book_id=NEW.book_id;END IF;
 ELSE NEW.updated_at:=clock_timestamp();END IF;
 RETURN NEW;
END $$;

CREATE TRIGGER book_timestamps BEFORE INSERT OR UPDATE ON shiori_private.books FOR EACH ROW EXECUTE FUNCTION shiori_private.timestamps();
CREATE TRIGGER note_timestamps BEFORE INSERT OR UPDATE ON shiori_private.notes FOR EACH ROW EXECUTE FUNCTION shiori_private.timestamps();

CREATE FUNCTION shiori_private.prune_deleted_links() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
DECLARE target_book text; target_note text;
BEGIN
 IF current_setting('shiori.restoring',true)='true' THEN RETURN OLD;END IF;
 IF TG_TABLE_NAME='books' THEN target_book:=OLD.id;ELSE target_book:=OLD.book_id;target_note:=OLD.id;END IF;
 IF TG_TABLE_NAME='books' THEN
  UPDATE shiori_private.notes n SET data=jsonb_set(n.data,'{links}',coalesce((SELECT jsonb_agg(v) FROM jsonb_array_elements(coalesce(n.data->'links','[]')) v WHERE v<>to_jsonb(OLD.id)),'[]')),version=version+1 WHERE n.owner=OLD.owner AND coalesce(n.data->'links','[]') ? OLD.id;
 END IF;
 UPDATE shiori_private.notes n SET data=jsonb_set(n.data,'{relatedNotes}',coalesce((SELECT jsonb_agg(v) FROM jsonb_array_elements(coalesce(n.data->'relatedNotes','[]')) v WHERE NOT(v->>'bookId'=target_book AND (target_note IS NULL OR v->>'noteId'=target_note))),'[]')),version=version+1
 WHERE n.owner=OLD.owner AND EXISTS(SELECT FROM jsonb_array_elements(coalesce(n.data->'relatedNotes','[]')) v WHERE v->>'bookId'=target_book AND (target_note IS NULL OR v->>'noteId'=target_note));
 RETURN OLD;
END $$;

CREATE TRIGGER prune_book_links AFTER DELETE ON shiori_private.books FOR EACH ROW EXECUTE FUNCTION shiori_private.prune_deleted_links();
CREATE TRIGGER prune_note_links AFTER DELETE ON shiori_private.notes FOR EACH ROW EXECUTE FUNCTION shiori_private.prune_deleted_links();

CREATE FUNCTION shiori_private.ui_gateway(p_owner text,p_action text,p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE result jsonb; take integer:=greatest(1,least(201,coalesce((p->>'limit')::integer,51))); o jsonb; ref jsonb; key_sort text:=coalesce(p->>'sort','new'); is_desc boolean; old_event bigint;
BEGIN
 IF p_action='register' THEN INSERT INTO shiori_private.registered_users(owner) VALUES(p_owner) ON CONFLICT DO NOTHING;RETURN '{"registered":true}';
 ELSIF p_action='book' THEN SELECT to_jsonb(b)||jsonb_build_object('note_count',(SELECT count(*) FROM shiori_private.notes n WHERE n.owner=p_owner AND n.book_id=b.id)) INTO result FROM shiori_private.books b WHERE owner=p_owner AND id=p->>'id';RETURN coalesce(result,'null');
 ELSIF p_action='note' THEN RETURN coalesce((SELECT to_jsonb(n) FROM shiori_private.notes n WHERE owner=p_owner AND book_id=p->>'bookId' AND id=p->>'id'),'null');
 ELSIF p_action='books' THEN
  is_desc:=key_sort<>'title';
  SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') INTO result FROM (
   SELECT z.* FROM (SELECT b.*,(SELECT count(*) FROM shiori_private.notes n WHERE n.owner=p_owner AND n.book_id=b.id) note_count,
    CASE WHEN key_sort='title' THEN b.data->>'title' WHEN key_sort='date' THEN coalesce(b.data->>'date','') ELSE lpad(b.position::text,20,'0') END sort_key
    FROM shiori_private.books b WHERE b.owner=p_owner
    AND (coalesce(p->>'q','')='' OR position(shiori_private.normal_text(p->>'q') IN shiori_private.normal_text(b.data::text))>0 OR EXISTS(SELECT FROM shiori_private.notes n WHERE n.owner=p_owner AND n.book_id=b.id AND position(shiori_private.normal_text(p->>'q') IN shiori_private.normal_text(n.data->>'text'))>0))
    AND (coalesce(p->>'bookTag','')='' OR EXISTS(SELECT FROM shiori_private.book_tags bt WHERE bt.owner=p_owner AND bt.book_id=b.id AND bt.tag=shiori_private.normal_text(p->>'bookTag')))
    AND (coalesce(p->>'status','すべて')='すべて' OR coalesce(b.data->>'status','未読')=p->>'status')
    AND (coalesce(p->>'tag','')='' OR EXISTS(SELECT FROM jsonb_array_elements_text(coalesce(b.data->'tags','[]')) t WHERE shiori_private.normal_text(t)=shiori_private.normal_text(p->>'tag')) OR EXISTS(SELECT FROM shiori_private.notes n CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(n.data->'tags','[]')) t WHERE n.owner=p_owner AND n.book_id=b.id AND shiori_private.normal_text(t)=shiori_private.normal_text(p->>'tag')))
   ) z WHERE NOT(p?'afterValue') OR (is_desc AND z.sort_key COLLATE "C" < (p->>'afterValue') COLLATE "C") OR (NOT is_desc AND z.sort_key COLLATE "C" > (p->>'afterValue') COLLATE "C") OR (z.sort_key=p->>'afterValue' AND z.id COLLATE "C" > (p->>'afterId') COLLATE "C")
   ORDER BY CASE WHEN is_desc THEN z.sort_key END COLLATE "C" DESC,CASE WHEN NOT is_desc THEN z.sort_key END COLLATE "C" ASC,z.id COLLATE "C" LIMIT take
  ) x;RETURN result;
 ELSIF p_action='notes' OR p_action='related' THEN
  SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') INTO result FROM (
   SELECT n.*,b.data->>'title' book_title FROM shiori_private.notes n JOIN shiori_private.books b ON b.owner=n.owner AND b.id=n.book_id
   WHERE n.owner=p_owner AND (NOT(p?'bookId') OR p_action='related' OR n.book_id=p->>'bookId')
   AND ((n.book_id COLLATE "C",n.id COLLATE "C")>(coalesce(p->>'afterBook','') COLLATE "C",coalesce(p->>'afterId','') COLLATE "C"))
   AND (coalesce(p->>'tag','')='' OR EXISTS(SELECT FROM jsonb_array_elements_text(coalesce(n.data->'tags','[]')) t WHERE shiori_private.normal_text(t)=shiori_private.normal_text(p->>'tag')))
   AND NOT EXISTS(SELECT FROM regexp_split_to_table(shiori_private.normal_text(p->>'q'),' ') term WHERE term<>'' AND position(term IN shiori_private.normal_text(coalesce(n.data->>'text','')||' '||coalesce((n.data->'tags')::text,'')))=0)
   AND (p_action<>'related' OR EXISTS(SELECT FROM jsonb_array_elements(coalesce(n.data->'relatedNotes','[]')) r WHERE r->>'bookId'=p->>'bookId' AND r->>'noteId'=p->>'id') OR EXISTS(SELECT FROM shiori_private.notes src CROSS JOIN LATERAL jsonb_array_elements(coalesce(src.data->'relatedNotes','[]')) r WHERE src.owner=p_owner AND src.book_id=p->>'bookId' AND src.id=p->>'id' AND r->>'bookId'=n.book_id AND r->>'noteId'=n.id))
   ORDER BY n.book_id COLLATE "C",n.id COLLATE "C" LIMIT take
  ) x;RETURN result;
 ELSIF p_action='stats' THEN RETURN jsonb_build_object('books',(SELECT count(*) FROM shiori_private.books WHERE owner=p_owner),'notes',(SELECT count(*) FROM shiori_private.notes WHERE owner=p_owner),'statuses',coalesce((SELECT jsonb_object_agg(status,n) FROM(SELECT coalesce(data->>'status','未読') status,count(*) n FROM shiori_private.books WHERE owner=p_owner GROUP BY 1) s),'{}'));
 ELSIF p_action='book_tag_history' THEN SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') INTO result FROM(SELECT tag,label FROM shiori_private.book_tag_history WHERE owner=p_owner AND tag>coalesce(p->>'after','') ORDER BY tag LIMIT take) x;RETURN result;
 ELSIF p_action='book_tags' THEN SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') INTO result FROM(SELECT h.tag key,h.label,(SELECT count(*) FROM shiori_private.book_tags b WHERE b.owner=h.owner AND b.tag=h.tag) count FROM shiori_private.book_tag_history h WHERE h.owner=p_owner AND position(shiori_private.normal_text(p->>'q') IN h.tag)>0 ORDER BY h.tag LIMIT take) x;RETURN result;
 ELSIF p_action='note_tags' THEN SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') INTO result FROM(SELECT shiori_private.normal_text(label) key,min(label) label,count(DISTINCT(book_id,id)) count FROM(SELECT DISTINCT n.book_id,n.id,t label FROM shiori_private.notes n CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(n.data->'tags','[]')) t WHERE n.owner=p_owner) vals GROUP BY 1 ORDER BY 1) x;RETURN result;
 ELSIF p_action='tags' THEN SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') INTO result FROM (SELECT label,count(*) count FROM (SELECT jsonb_array_elements_text(coalesce(data->'tags','[]')) label FROM shiori_private.books WHERE owner=p_owner UNION ALL SELECT jsonb_array_elements_text(coalesce(data->'tags','[]')) FROM shiori_private.notes WHERE owner=p_owner) t GROUP BY label ORDER BY label) x;RETURN result;
 ELSIF p_action='cover' THEN RETURN coalesce((SELECT data->'coverRef' FROM shiori_private.books WHERE owner=p_owner AND data->'coverRef'->>'id'=p->>'id' AND left(data->'coverRef'->>'key',65)=encode(sha256(convert_to(p_owner,'UTF8')),'hex')||'/' LIMIT 1),'null');
 ELSIF p_action='track' THEN
  IF p->>'kind' NOT IN('cover_upload_bytes','cover_download_bytes','keyword_searches') OR coalesce((p->>'amount')::bigint,0)<0 THEN RAISE EXCEPTION 'invalid counter'; END IF;
  INSERT INTO shiori_private.usage_daily(owner,kind,amount) VALUES(p_owner,p->>'kind',(p->>'amount')::bigint) ON CONFLICT(owner,day,kind) DO UPDATE SET amount=shiori_private.usage_daily.amount+excluded.amount;RETURN '{}';
 ELSIF p_action='usage' THEN RETURN jsonb_build_object('databasePayloadBytes',(SELECT coalesce(sum(octet_length(data::text)),0) FROM(SELECT data FROM shiori_private.books WHERE owner=p_owner UNION ALL SELECT data FROM shiori_private.notes WHERE owner=p_owner) x),'activeImages',(SELECT count(*) FROM shiori_private.books WHERE owner=p_owner AND data->'coverRef'->>'key' IS NOT NULL),'storage',(SELECT jsonb_build_object('retainedImageCount',count(*),'retainedBytes',coalesce(sum(bytes),0)) FROM shiori_private.cover_assets WHERE owner=p_owner),'counters',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM(SELECT * FROM shiori_private.usage_daily WHERE owner=p_owner ORDER BY day DESC,kind LIMIT 365) x),'[]'),'automaticPaidUpgrade',false);
 ELSIF p_action='apply' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_owner,0));SELECT coalesce(max(event_id),0) INTO old_event FROM shiori_private.history WHERE owner=p_owner;
  IF p?'expectedEvent' AND old_event<>(p->>'expectedEvent')::bigint THEN RAISE EXCEPTION 'snapshot changed' USING ERRCODE='40001';END IF;
  result:=shiori_private.gateway_impl(p_owner,'apply',p);
  FOR o IN SELECT value FROM jsonb_array_elements(p->'operations') LOOP
   IF o->>'kind'='books' AND o->>'action'<>'delete' THEN
    SELECT data->'coverRef' INTO ref FROM shiori_private.books WHERE owner=p_owner AND id=o->>'id';
    IF ref->>'id' IS NOT NULL THEN IF left(ref->>'key',65) IS DISTINCT FROM encode(sha256(convert_to(p_owner,'UTF8')),'hex')||'/' OR ref->>'mime' NOT IN('image/png','image/jpeg','image/webp') OR coalesce((ref->>'bytes')::bigint,0) NOT BETWEEN 1 AND 307200 OR coalesce(ref->>'sha256','') !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'invalid cover owner' USING ERRCODE='23503';END IF;INSERT INTO shiori_private.cover_assets(owner,id,key,mime,bytes,sha256) VALUES(p_owner,ref->>'id',ref->>'key',ref->>'mime',(ref->>'bytes')::bigint,ref->>'sha256') ON CONFLICT DO NOTHING;END IF;
   ELSIF o->>'kind'='notes' AND o->>'action'<>'delete' THEN
    IF EXISTS(SELECT FROM shiori_private.notes n CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(n.data->'links','[]')) l WHERE n.owner=p_owner AND n.book_id=o->>'bookId' AND n.id=o->>'id' AND NOT EXISTS(SELECT FROM shiori_private.books b WHERE b.owner=p_owner AND b.id=l)) OR EXISTS(SELECT FROM shiori_private.notes n CROSS JOIN LATERAL jsonb_array_elements(coalesce(n.data->'relatedNotes','[]')) r WHERE n.owner=p_owner AND n.book_id=o->>'bookId' AND n.id=o->>'id' AND NOT EXISTS(SELECT FROM shiori_private.notes t WHERE t.owner=p_owner AND t.book_id=r->>'bookId' AND t.id=r->>'noteId')) THEN RAISE EXCEPTION 'invalid relation' USING ERRCODE='23503';END IF;
   END IF;
  END LOOP;RETURN result;
 END IF;RAISE EXCEPTION 'invalid ui action';
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA shiori_private FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA shiori_private TO shiori_gateway_role;
GRANT EXECUTE ON FUNCTION shiori_private.gateway_impl(text,text,jsonb) TO service_role;

CREATE TABLE shiori_private.book_tag_history(owner text NOT NULL,tag text NOT NULL,label text NOT NULL,first_seen_at timestamptz NOT NULL DEFAULT now(),last_seen_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner,tag));
ALTER TABLE shiori_private.book_tag_history ENABLE ROW LEVEL SECURITY;ALTER TABLE shiori_private.book_tag_history FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_scope ON shiori_private.book_tag_history TO shiori_gateway_role USING(owner=current_setting('shiori.owner',true)) WITH CHECK(owner=current_setting('shiori.owner',true));
REVOKE ALL ON shiori_private.book_tag_history FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE ON shiori_private.book_tag_history TO shiori_gateway_role;
CREATE TABLE shiori_private.book_tags(owner text NOT NULL,book_id text NOT NULL,tag text NOT NULL,label text NOT NULL,PRIMARY KEY(owner,book_id,tag),FOREIGN KEY(owner,book_id) REFERENCES shiori_private.books(owner,id) ON DELETE CASCADE);
CREATE INDEX book_tags_owner_tag ON shiori_private.book_tags(owner,tag,book_id);
ALTER TABLE shiori_private.book_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE shiori_private.book_tags FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_scope ON shiori_private.book_tags TO shiori_gateway_role USING(owner=current_setting('shiori.owner',true)) WITH CHECK(owner=current_setting('shiori.owner',true));
REVOKE ALL ON shiori_private.book_tags FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,DELETE ON shiori_private.book_tags TO shiori_gateway_role;

CREATE FUNCTION shiori_private.sync_book_tags() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
 DELETE FROM shiori_private.book_tags WHERE owner=NEW.owner AND book_id=NEW.id;
 INSERT INTO shiori_private.book_tags(owner,book_id,tag,label)
 SELECT NEW.owner,NEW.id,shiori_private.normal_text(label),label FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(NEW.data->'tags')='array' THEN NEW.data->'tags' ELSE '[]'::jsonb END) label WHERE shiori_private.normal_text(label)<>'' ON CONFLICT DO NOTHING;
 INSERT INTO shiori_private.book_tag_history(owner,tag,label) SELECT owner,tag,label FROM shiori_private.book_tags WHERE owner=NEW.owner AND book_id=NEW.id ON CONFLICT(owner,tag) DO UPDATE SET last_seen_at=now();
 RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION shiori_private.sync_book_tags() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION shiori_private.sync_book_tags() TO shiori_gateway_role;
CREATE TRIGGER sync_book_tags AFTER INSERT OR UPDATE OF data ON shiori_private.books FOR EACH ROW EXECUTE FUNCTION shiori_private.sync_book_tags();

INSERT INTO shiori_private.book_tags(owner,book_id,tag,label)
SELECT b.owner,b.id,shiori_private.normal_text(label),label FROM shiori_private.books b CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(b.data->'tags')='array' THEN b.data->'tags' ELSE '[]'::jsonb END) label WHERE shiori_private.normal_text(label)<>'' ON CONFLICT DO NOTHING;
INSERT INTO shiori_private.book_tag_history(owner,tag,label) SELECT owner,tag,min(label) FROM shiori_private.book_tags GROUP BY owner,tag ON CONFLICT DO NOTHING;

CREATE TABLE shiori_private.restore_sessions(owner text NOT NULL,id text NOT NULL,mode text NOT NULL CHECK(mode IN('append','merge','replace')),expected_event bigint NOT NULL,state text NOT NULL DEFAULT 'uploading',sequence integer NOT NULL DEFAULT -1,chain text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',PRIMARY KEY(owner,id));
CREATE TABLE shiori_private.restore_records(owner text NOT NULL,session_id text NOT NULL,sequence integer NOT NULL,kind text NOT NULL,record_id text NOT NULL DEFAULT '',book_id text NOT NULL DEFAULT '',payload jsonb NOT NULL,PRIMARY KEY(owner,session_id,sequence),UNIQUE(owner,session_id,kind,book_id,record_id),FOREIGN KEY(owner,session_id) REFERENCES shiori_private.restore_sessions(owner,id) ON DELETE CASCADE);

DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['restore_sessions','restore_records'] LOOP
 EXECUTE format('ALTER TABLE shiori_private.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE shiori_private.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY owner_scope ON shiori_private.%I TO shiori_gateway_role USING(owner=current_setting(''shiori.owner'',true)) WITH CHECK(owner=current_setting(''shiori.owner'',true))',t);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON shiori_private.%I TO shiori_gateway_role',t);
 EXECUTE format('REVOKE ALL ON shiori_private.%I FROM PUBLIC,anon,authenticated,service_role',t);
END LOOP;END $$;

CREATE FUNCTION shiori_private.restore_books(u text,s text) RETURNS SETOF shiori_private.restore_records LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT r.* FROM shiori_private.restore_records r JOIN shiori_private.restore_sessions st ON st.owner=r.owner AND st.id=r.session_id WHERE r.owner=u AND r.session_id=s AND r.kind='book' AND (st.mode<>'append' OR (r.payload->>'include')::boolean) $$;
CREATE FUNCTION shiori_private.restore_notes(u text,s text) RETURNS SETOF shiori_private.restore_records LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT n.* FROM shiori_private.restore_records n JOIN shiori_private.restore_books(u,s) b ON b.record_id=n.book_id WHERE n.owner=u AND n.session_id=s AND n.kind='note' $$;

CREATE FUNCTION shiori_private.restore_gateway(u text,p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE a text:=p->>'action';v jsonb:=p->'payload';s shiori_private.restore_sessions%ROWTYPE;item_record jsonb;d jsonb;last_record jsonb;current_event bigint;counts jsonb;preview jsonb;token text;bad bigint;head jsonb;foot jsonb;
BEGIN
 IF a='begin' THEN
  IF v->>'mode' NOT IN('append','merge','replace') THEN RAISE EXCEPTION 'invalid restore mode';END IF;
  SELECT coalesce(max(event_id),0) INTO current_event FROM shiori_private.history WHERE owner=u;
  INSERT INTO shiori_private.restore_sessions(owner,id,mode,expected_event,chain) VALUES(u,v->>'id',v->>'mode',current_event,repeat('0',64));RETURN jsonb_build_object('id',v->>'id','sequence',-1,'chain',repeat('0',64));
 END IF;
 SELECT * INTO s FROM shiori_private.restore_sessions WHERE owner=u AND id=v->>'id' AND expires_at>now() AND state<>'cancelled' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'restore session not found' USING ERRCODE='PT404';END IF;
 IF a='state' THEN RETURN to_jsonb(s)||jsonb_build_object('ready',s.state='ready');
 ELSIF a='cancel' THEN
  IF s.state='committed' THEN RAISE EXCEPTION 'already restored' USING ERRCODE='40001';END IF;
  UPDATE shiori_private.restore_sessions SET state='cancelled' WHERE owner=u AND id=s.id;RETURN '{"cancelled":true}';
 ELSIF a='append' THEN
  IF s.state<>'uploading' OR s.sequence<>(v->>'expectedSequence')::integer OR s.chain<>v->>'expectedChain' THEN RAISE EXCEPTION 'restore sequence changed' USING ERRCODE='40001';END IF;
  IF jsonb_array_length(v->'records') NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'invalid restore chunk';END IF;
  FOR item_record IN SELECT value FROM jsonb_array_elements(v->'records') LOOP
   d:=item_record->'payload';IF d->>'kind'='book' THEN d:=d||jsonb_build_object('include',s.mode<>'append' OR NOT EXISTS(SELECT FROM shiori_private.books WHERE owner=u AND id=d->>'id'));END IF;
   INSERT INTO shiori_private.restore_records VALUES(u,s.id,(item_record->>'sequence')::integer,d->>'kind',CASE WHEN d->>'kind' IN('book','note','bookTag') THEN d->>'id' ELSE '' END,CASE WHEN d->>'kind' IN('note','cover') THEN d->>'bookId' ELSE '' END,d);last_record:=d;
  END LOOP;
  UPDATE shiori_private.restore_sessions SET sequence=(v->>'sequence')::integer,chain=v->>'chain',state=CASE WHEN last_record->>'kind'='end' THEN 'ready' ELSE 'uploading' END WHERE owner=u AND id=s.id;
  RETURN jsonb_build_object('id',s.id,'sequence',v->'sequence','chain',v->>'chain','ready',last_record->>'kind'='end');
 END IF;
 IF a NOT IN('preview','commit') OR s.state<>'ready' THEN RAISE EXCEPTION 'restore not ready' USING ERRCODE='40001';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(u,0));
 SELECT coalesce(max(event_id),0) INTO current_event FROM shiori_private.history WHERE owner=u;
 IF current_event<>s.expected_event THEN RAISE EXCEPTION 'snapshot changed' USING ERRCODE='40001';END IF;
 SELECT payload INTO foot FROM shiori_private.restore_records WHERE owner=u AND session_id=s.id AND kind='end';
 SELECT payload INTO head FROM shiori_private.restore_records WHERE owner=u AND session_id=s.id AND kind='header';
 SELECT jsonb_build_object('books',count(*) FILTER(WHERE kind='book'),'notes',count(*) FILTER(WHERE kind='note'),'covers',count(*) FILTER(WHERE kind='cover'),'bookTags',count(*) FILTER(WHERE kind='bookTag')) INTO counts FROM shiori_private.restore_records WHERE owner=u AND session_id=s.id;
 IF counts->'books' IS DISTINCT FROM foot->'books' OR counts->'notes' IS DISTINCT FROM foot->'notes' OR counts->'covers' IS DISTINCT FROM foot->'covers' OR counts->'bookTags' IS DISTINCT FROM coalesce(foot->'bookTags','0'::jsonb) OR head IS NULL THEN RAISE EXCEPTION 'backup footer mismatch';END IF;
 WITH eb AS(SELECT * FROM shiori_private.restore_books(u,s.id)),en AS(SELECT * FROM shiori_private.restore_notes(u,s.id)),
 fb AS(SELECT record_id id FROM eb UNION SELECT id FROM shiori_private.books WHERE owner=u AND s.mode<>'replace'),
 fn AS(SELECT book_id,record_id id FROM en UNION SELECT n.book_id,n.id FROM shiori_private.notes n WHERE n.owner=u AND s.mode<>'replace' AND NOT EXISTS(SELECT FROM en WHERE en.book_id=n.book_id AND en.record_id=n.id))
 SELECT (SELECT count(*) FROM shiori_private.restore_records r WHERE r.owner=u AND r.session_id=s.id AND r.kind IN('note','cover') AND NOT EXISTS(SELECT FROM shiori_private.restore_records b WHERE b.owner=u AND b.session_id=s.id AND b.kind='book' AND b.record_id=r.book_id))+
 (SELECT count(*) FROM en CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(en.payload->'data'->'links','[]')) l WHERE NOT EXISTS(SELECT FROM fb WHERE fb.id=l))+
 (SELECT count(*) FROM en CROSS JOIN LATERAL jsonb_array_elements(coalesce(en.payload->'data'->'relatedNotes','[]')) r WHERE NOT EXISTS(SELECT FROM fn WHERE fn.book_id=r->>'bookId' AND fn.id=r->>'noteId')) INTO bad;
 IF bad>0 THEN RAISE EXCEPTION 'backup references missing';END IF;
 SELECT counts||jsonb_build_object('mode',s.mode,'added',(SELECT count(*) FROM shiori_private.restore_books(u,s.id) b WHERE NOT EXISTS(SELECT FROM shiori_private.books WHERE owner=u AND id=b.record_id)),'updated',(SELECT count(*) FROM shiori_private.restore_books(u,s.id) b WHERE EXISTS(SELECT FROM shiori_private.books WHERE owner=u AND id=b.record_id)),'removed',(SELECT count(*) FROM shiori_private.books b WHERE owner=u AND s.mode='replace' AND NOT EXISTS(SELECT FROM shiori_private.restore_books(u,s.id) r WHERE r.record_id=b.id)),'notesAdded',(SELECT count(*) FROM shiori_private.restore_notes(u,s.id) n WHERE NOT EXISTS(SELECT FROM shiori_private.notes WHERE owner=u AND book_id=n.book_id AND id=n.record_id)),'notesUpdated',(SELECT count(*) FROM shiori_private.restore_notes(u,s.id) n WHERE EXISTS(SELECT FROM shiori_private.notes WHERE owner=u AND book_id=n.book_id AND id=n.record_id)),'notesRemoved',(SELECT count(*) FROM shiori_private.notes n WHERE owner=u AND s.mode='replace' AND NOT EXISTS(SELECT FROM shiori_private.restore_notes(u,s.id) r WHERE r.book_id=n.book_id AND r.record_id=n.id)),'requiresConfirmation',true) INTO preview;
 token:=encode(sha256(convert_to(u||s.id||s.expected_event::text||s.chain||s.mode,'UTF8')),'hex');
 IF a='preview' THEN RETURN jsonb_build_object('preview',preview,'checksum',token);END IF;
 IF token IS DISTINCT FROM v->>'checksum' THEN RAISE EXCEPTION 'restore preview mismatch' USING ERRCODE='40001';END IF;
 PERFORM set_config('shiori.restoring','true',true);
 IF s.mode='replace' THEN DELETE FROM shiori_private.books WHERE owner=u;END IF;
 INSERT INTO shiori_private.cover_assets(owner,id,key,mime,bytes,sha256) SELECT u,c.payload->'asset'->>'id',c.payload->'asset'->>'key',c.payload->'asset'->>'mime',(c.payload->'asset'->>'bytes')::bigint,c.payload->'asset'->>'sha256' FROM shiori_private.restore_records c JOIN shiori_private.restore_books(u,s.id) b ON b.record_id=c.book_id WHERE c.owner=u AND c.session_id=s.id AND c.kind='cover' ON CONFLICT DO NOTHING;
 INSERT INTO shiori_private.books(owner,id,data,position,created_at,updated_at)
 SELECT u,b.record_id,(b.payload->'data')||CASE WHEN c.payload IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('coverRef',c.payload->'asset','cover','') END,coalesce((b.payload->'meta'->>'position')::bigint,b.sequence),coalesce((b.payload->'meta'->>'createdAt')::timestamptz,now()),coalesce((b.payload->'meta'->>'updatedAt')::timestamptz,now())
 FROM shiori_private.restore_books(u,s.id) b LEFT JOIN shiori_private.restore_records c ON c.owner=u AND c.session_id=s.id AND c.kind='cover' AND c.book_id=b.record_id
 ON CONFLICT(owner,id) DO UPDATE SET data=excluded.data,position=excluded.position,created_at=excluded.created_at,updated_at=excluded.updated_at,version=shiori_private.books.version+1;
 INSERT INTO shiori_private.notes(owner,book_id,id,data,position,created_at,updated_at)
 SELECT u,n.book_id,n.record_id,n.payload->'data',coalesce((n.payload->'meta'->>'position')::bigint,n.sequence),coalesce((n.payload->'meta'->>'createdAt')::timestamptz,now()),coalesce((n.payload->'meta'->>'updatedAt')::timestamptz,now()) FROM shiori_private.restore_notes(u,s.id) n
 ON CONFLICT(owner,book_id,id) DO UPDATE SET data=excluded.data,position=excluded.position,created_at=excluded.created_at,updated_at=excluded.updated_at,version=shiori_private.notes.version+1;
 INSERT INTO shiori_private.book_tag_history(owner,tag,label) SELECT u,record_id,payload->>'label' FROM shiori_private.restore_records WHERE owner=u AND session_id=s.id AND kind='bookTag' ON CONFLICT(owner,tag) DO UPDATE SET last_seen_at=now();
 INSERT INTO shiori_private.roots(owner,data) VALUES(u,CASE WHEN s.mode='replace' THEN head->'root' ELSE coalesce((SELECT data FROM shiori_private.roots WHERE owner=u),'{}')||(head->'root') END) ON CONFLICT(owner) DO UPDATE SET data=excluded.data,version=shiori_private.roots.version+1;
 UPDATE shiori_private.restore_sessions SET state='committed' WHERE owner=u AND id=s.id;
 PERFORM set_config('shiori.restoring','false',true);
 RETURN preview||'{"applied":true}';
END $$;

REVOKE ALL ON FUNCTION shiori_private.restore_books(text,text),shiori_private.restore_notes(text,text),shiori_private.restore_gateway(text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION shiori_private.restore_books(text,text),shiori_private.restore_notes(text,text),shiori_private.restore_gateway(text,jsonb) TO shiori_gateway_role;

CREATE FUNCTION shiori_private.project_usage() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE object_bytes bigint; object_count bigint;
BEGIN
 IF to_regclass('storage.objects') IS NOT NULL THEN
  EXECUTE 'SELECT coalesce(sum(CASE WHEN metadata->>''size'' ~ ''^[0-9]+$'' THEN (metadata->>''size'')::bigint ELSE 0 END),0),count(*) FROM storage.objects WHERE bucket_id=''shiori-covers''' INTO object_bytes,object_count;
 END IF;
 RETURN jsonb_build_object('source','postgresql','users',(SELECT count(*) FROM(SELECT owner FROM shiori_private.registered_users UNION SELECT owner FROM shiori_private.books UNION SELECT owner FROM shiori_private.roots) us),'books',(SELECT count(*) FROM shiori_private.books),'notes',(SELECT count(*) FROM shiori_private.notes),'averageBooksPerUser',(SELECT count(*)::numeric FROM shiori_private.books)/greatest(1,(SELECT count(*) FROM(SELECT owner FROM shiori_private.registered_users UNION SELECT owner FROM shiori_private.books UNION SELECT owner FROM shiori_private.roots) us)),'dailyRegistrations',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM(SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD') period,count(*) count FROM shiori_private.registered_users GROUP BY 1 ORDER BY 1 DESC LIMIT 90) x),'[]'),'monthlyRegistrations',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM(SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM') period,count(*) count FROM shiori_private.registered_users GROUP BY 1 ORDER BY 1 DESC LIMIT 24) x),'[]'),'databaseBytes',pg_database_size(current_database()),'applicationRelationBytes',(SELECT coalesce(sum(pg_total_relation_size(c.oid)),0) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='shiori_private' AND c.relkind='r'),'storageObjectBytes',object_bytes,'storageObjectCount',object_count,'storageSource',CASE WHEN object_bytes IS NULL THEN 'unavailable' ELSE 'storage.objects metadata' END,'billingEgressBytes',NULL,'sampledAt',clock_timestamp());
END $$;

REVOKE ALL ON FUNCTION shiori_private.project_usage() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION shiori_private.project_usage() TO service_role;
CREATE FUNCTION public.shiori_project_usage() RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT shiori_private.project_usage() $$;
REVOKE ALL ON FUNCTION public.shiori_project_usage() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.shiori_project_usage() TO service_role;

GRANT CREATE ON SCHEMA shiori_private TO shiori_gateway_role;

DO $shiori_owner$
DECLARE already_member boolean := pg_has_role(current_user,'shiori_gateway_role','MEMBER');
 modern_roles boolean := current_setting('server_version_num')::integer >= 160000;
 could_set boolean;
BEGIN
 IF modern_roles THEN
  could_set := pg_has_role(current_user,'shiori_gateway_role','SET');
  IF NOT could_set THEN EXECUTE format('GRANT shiori_gateway_role TO %I WITH SET TRUE',current_user); END IF;
 ELSE
  IF NOT already_member THEN EXECUTE format('GRANT shiori_gateway_role TO %I',current_user); END IF;
 END IF;
 ALTER FUNCTION shiori_private.gateway_impl(text,text,jsonb) OWNER TO shiori_gateway_role;
 IF NOT already_member THEN
  EXECUTE format('REVOKE shiori_gateway_role FROM %I',current_user);
 ELSIF modern_roles AND NOT could_set THEN
  EXECUTE format('GRANT shiori_gateway_role TO %I WITH SET FALSE',current_user);
 END IF;
END $shiori_owner$;

REVOKE CREATE ON SCHEMA shiori_private FROM shiori_gateway_role;

INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES('shiori-covers','shiori-covers',false,307200,ARRAY['image/png','image/jpeg','image/webp']);

COMMIT;