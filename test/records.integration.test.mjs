import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {isolatedDatabase,serviceQuery} from '../testing/database.mjs';
import {createApp} from '../server.mjs';
const book=(id,title=id)=>({id,title,author:'著者',date:'2026-11-02',summary:'記録',tags:['自由タグ'],cover:'/api/covers/00000000-0000-4000-8000-000000000000',notes:[],custom:{preserve:true}});
const note=id=>({id,text:'考察 日本語検索 luminous stars',tags:['メモタグ'],links:[],custom:'保持'});
const put=(kind,data,version=0,extra={})=>({kind,id:data.id,data,version,action:'put',...extra});
const setup=async()=>{const db=await isolatedDatabase();await db.apply('db/migrations/001_atomic_library.sql');await db.apply('db/migrations/002_record_storage.sql');return db;};
const rpcFor=db=>async(owner,action,payload={})=>(await serviceQuery(db.pool,'SELECT public.shiori_records($1,$2,$3) result',[owner,action,JSON.stringify(payload)])).rows[0].result;
const admin=(db,owner,direction)=>db.pool.query('SELECT shiori_private.records_admin($1,$2) result',[owner,direction]);
test('record migration preserves IDs, notes, tags, photo references and unknown fields; rollback includes later edits',{skip:!process.env.SHIORI_TEST_DATABASE_URL},async()=>{
 const db=await setup();try{
  const rpc=rpcFor(db),source=[{...book('first'),notes:[note('n')]},book('second')];
  await db.pool.query('INSERT INTO shiori_private.roots(owner,data,version) VALUES($1,$2,7)',['old',JSON.stringify({books:source,customRoot:'保持'})]);
  assert.equal((await rpc('old','books')).status,'migration_required');await admin(db,'old','migrate');assert.equal((await admin(db,'old','migrate')).rows[0].result.status,'already_active');
  const books=await rpc('old','books');assert.equal(books.items.length,2);assert.deepEqual(books.items[0].data,Object.fromEntries(Object.entries(source[0]).filter(([k])=>k!=='notes')));assert.deepEqual((await rpc('old','notes')).items[0].data,source[0].notes[0]);
  await assert.rejects(serviceQuery(db.pool,'SELECT public.shiori_library_cas($1,7,$2,$3)',['old','[]',randomUUID()]),e=>e.code==='PT409');
  const data={...books.items[0].data,title:'移行後の編集'};const changed=await rpc('old','apply',{requestId:randomUUID(),operations:[put('book',data,1)]});assert.equal(changed.status,'ok');
  await assert.rejects(db.apply('db/rollback/002_record_storage.sql'),/active record owners remain/);await admin(db,'old','rollback');const root=(await db.pool.query('SELECT data FROM shiori_private.roots WHERE owner=$1',['old'])).rows[0].data;assert.equal(root.customRoot,'保持');assert.deepEqual(root.books,[{...source[0],title:'移行後の編集'},source[1]]);assert.equal((await rpc('old','books')).status,'migration_required');
  assert.deepEqual((await db.pool.query('SELECT source_data FROM shiori_private.record_state WHERE owner=$1',['old'])).rows[0].source_data.books,source);
  const invalid=[{...book('duplicate'),notes:[note('same'),note('same')]}];await db.pool.query('INSERT INTO shiori_private.roots(owner,data) VALUES($1,$2)',['invalid',JSON.stringify({books:invalid})]);await assert.rejects(admin(db,'invalid','migrate'),e=>e.code==='23505');assert.equal((await db.pool.query('SELECT count(*) FROM shiori_private.record_books WHERE owner=$1',['invalid'])).rows[0].count,'0');
  await db.apply('db/rollback/002_record_storage.sql');await assert.rejects(rpc('old','books'),e=>e.code==='42501');await db.apply('db/migrations/002_record_storage.sql');assert.deepEqual((await db.pool.query('SELECT data FROM shiori_private.roots WHERE owner=$1',['old'])).rows[0].data,root);
 }finally{await db.close();}
});
test('record transactions merge independent writers, reject stale records/deletes and retry once across HTTP instances',{skip:!process.env.SHIORI_TEST_DATABASE_URL},async()=>{
 const db=await setup();try{
  const rpc=rpcFor(db),initial=await rpc('a','apply',{requestId:randomUUID(),operations:['one','two'].map(id=>put('book',(({notes,...d})=>d)(book(id))))});assert.equal(initial.status,'ok');
  const initialRecords=(await rpc('a','books')).items;
  const independent=await Promise.all(initialRecords.map(b=>rpc('a','apply',{requestId:randomUUID(),operations:[put('book',{...b.data,title:'編集 '+b.id},b.version)]})));assert.ok(independent.every(x=>x.status==='ok'));
  const latest=(await rpc('a','books')).items[0];const races=await Promise.all(Array.from({length:10},(_,i)=>rpc('a','apply',{requestId:randomUUID(),operations:[put('book',{...latest.data,title:'競合 '+i},latest.version)]})));assert.equal(races.filter(x=>x.status==='ok').length,1);
  const current=(await rpc('a','books')).items[0],before=await rpc('a','usage');
  assert.equal((await rpc('a','apply',{requestId:randomUUID(),operations:[put('book',{...current.data,title:'ロールバック対象'},current.version),put('note',note('bad'),999,{bookId:current.id})]})).status,'conflict');assert.equal((await rpc('a','usage')).revision,before.revision);assert.deepEqual((await rpc('a','books')).items[0].data,current.data);
  assert.equal((await rpc('a','apply',{requestId:randomUUID(),operations:[put('note',note('n'),0,{bookId:current.id})]})).status,'ok');
  assert.equal((await rpc('a','apply',{requestId:randomUUID(),operations:[{kind:'book',id:current.id,version:current.version,notesVersion:current.notes_version,action:'delete'}]})).status,'conflict');
  const withNote=(await rpc('a','books')).items[0];assert.equal((await rpc('a','apply',{requestId:randomUUID(),operations:[{kind:'book',id:withNote.id,version:withNote.version,notesVersion:withNote.notes_version,action:'delete'}]})).status,'ok');assert.equal((await rpc('a','notes')).items.length,0);
  const deleted=withNote.id;const recreated=await rpc('a','apply',{requestId:randomUUID(),operations:[put('book',withNote.data)]});assert.equal(recreated.status,'ok');assert.ok(recreated.changes[0].version>withNote.version);assert.equal((await rpc('a','apply',{requestId:randomUUID(),operations:[put('book',{...withNote.data,title:'古い版の再利用'},withNote.version)]})).status,'conflict');
  const {notes:unused,...clean}=book('http');let lost=true;
  const fetcher=async(url,init)=>{if(url.endsWith('/auth/v1/user'))return Response.json({id:init.headers.Authorization==='Bearer b'?'b':'http',email:'synthetic@example.com'});if(!url.endsWith('/rest/v1/rpc/shiori_records'))throw Error('Unexpected endpoint');const body=JSON.parse(init.body),result=await rpc(body.p_owner,body.p_action,body.p_payload);if(body.p_action==='apply'&&lost){lost=false;throw Error('lost committed response')}return Response.json(result);};
  const apps=[0,1].map(()=>createApp({mode:'supabase',url:'https://example.supabase.co',publicKey:'fake',secretKey:'fake',fetcher,libraryStorage:'records'}));for(const app of apps)await new Promise(r=>app.listen(0,'127.0.0.1',r));
  try{const key=randomUUID(),request=(app,path,method='GET',body,token='a')=>fetch(`http://127.0.0.1:${app.address().port}`+path,{method,headers:{Cookie:'shiori_session='+token,'Idempotency-Key':key,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
   assert.equal((await request(apps[0],'/api/books','POST',{data:clean})).status,500);const retry=await request(apps[1],'/api/books','POST',{data:clean});assert.equal(retry.status,200);assert.equal((await retry.json()).replayed,true);
   assert.equal((await request(apps[0],'/api/books/http')).status,200);assert.equal((await request(apps[1],'/api/books/http','GET',undefined,'b')).status,404);assert.equal((await request(apps[0],'/api/library','PUT',{books:[],revision:0})).status,410);
   const changed=await request(apps[0],'/api/books/http','PUT',{version:1,data:{...clean,title:'キー改変'}});assert.equal(changed.status,409);
  }finally{for(const app of apps)await new Promise(r=>app.close(r));}
  const c=await db.pool.connect();try{await c.query('SET ROLE authenticated');await assert.rejects(c.query("SELECT public.shiori_records('a','books','{}')"),e=>e.code==='42501');await assert.rejects(c.query('SELECT * FROM shiori_private.record_notes'),e=>e.code==='42501');await c.query('SET ROLE service_role');await assert.rejects(c.query("SELECT shiori_private.records_admin('a','rollback')"),e=>e.code==='42501');}finally{await c.query('ROLLBACK');try{await c.query('RESET ROLE');}finally{c.release();}}
 }finally{await db.close()}
});
test('1,000 books / 10,000 notes migrate, page, search and update without rewriting unrelated records',{skip:!process.env.SHIORI_TEST_DATABASE_URL,timeout:60000},async t=>{
 const db=await setup();try{
  const rpc=rpcFor(db),books=Array.from({length:1000},(_,i)=>({...book('b'+String(i).padStart(4,'0')),notes:Array.from({length:10},(_,j)=>note('n'+j))}));const text=JSON.stringify({books});
  await db.pool.query('INSERT INTO shiori_private.roots(owner,data,version) VALUES($1,$2,5)',['scale',text]);let start=performance.now();await admin(db,'scale','migrate');const migrationMs=performance.now()-start;assert.ok(migrationMs<30000);
  const usage=await rpc('scale','usage');assert.equal(usage.books,1000);assert.equal(usage.notes,10000);assert.ok(usage.logicalBytes<8*1024*1024);
  let after='',count=0;start=performance.now();for(;;){const page=await rpc('scale','books',{limit:200,after,revision:usage.revision});count+=page.items.length;if(!page.hasMore)break;after=page.items.at(-1).id;}assert.equal(count,1000);const listMs=performance.now()-start;
  start=performance.now();const tags=await rpc('scale','books',{tag:'自由タグ',limit:200}),found=await rpc('scale','notes',{q:'日本語検索',limit:200}),memoTags=await rpc('scale','books',{tag:'メモタグ',limit:200});assert.equal(tags.items.length,200);assert.equal(found.items.length,200);assert.equal(memoTags.items.length,200);const searchMs=performance.now()-start;
  const untouched=await db.pool.query("SELECT xmin::text FROM shiori_private.record_books WHERE owner='scale' AND id='b0999'");const target=(await rpc('scale','books',{id:'b0000'})).items[0];start=performance.now();const update=await rpc('scale','apply',{requestId:randomUUID(),operations:[put('book',{...target.data,title:'一冊だけ編集'},target.version)]});const updateMs=performance.now()-start;assert.equal(update.changes.length,1);const relationBytes=Number((await db.pool.query("SELECT sum(pg_total_relation_size(c.oid)) bytes FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='shiori_private' AND c.relkind='r'")).rows[0].bytes);assert.equal((await db.pool.query("SELECT xmin::text FROM shiori_private.record_books WHERE owner='scale' AND id='b0999'")).rows[0].xmin,untouched.rows[0].xmin);assert.equal((await db.pool.query("SELECT data FROM shiori_private.roots WHERE owner='scale'")).rows[0].data.books[0].title,books[0].title);assert.equal((await rpc('scale','books',{revision:usage.revision})).status,'conflict');
  assert.ok(listMs<10000&&searchMs<10000&&updateMs<5000);t.diagnostic(JSON.stringify({books:1000,notes:10000,sourceBytes:Buffer.byteLength(text),relationBytes,logicalBytes:usage.logicalBytes,migrationMs:Math.round(migrationMs),listMs:Math.round(listMs),searchMs:Math.round(searchMs),updateMs:Math.round(updateMs)}));
 }finally{await db.close()}
});
test('record migration is reentrant for a non-superuser operator without retaining role/schema elevation',{skip:!process.env.SHIORI_TEST_DATABASE_URL},async()=>{
 const db=await setup(),role='record_operator_'+randomUUID().replaceAll('-','');let created=false;try{
  await db.pool.query(`CREATE ROLE ${role} CREATEROLE; GRANT shiori_gateway_role TO ${role} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE; ALTER SCHEMA shiori_private OWNER TO ${role}; GRANT CREATE ON SCHEMA public TO ${role}; ALTER TABLE shiori_private.roots OWNER TO ${role}; ALTER FUNCTION shiori_private.audit_row() OWNER TO ${role}; ALTER FUNCTION public.shiori_records(text,text,jsonb) OWNER TO ${role};`);created=true;
  for(const table of ['record_state','record_books','record_notes','record_requests'])await db.pool.query(`ALTER TABLE shiori_private.${table} OWNER TO ${role}`);
  const sql=await(await import('node:fs/promises')).readFile(new URL('../db/migrations/002_record_storage.sql',import.meta.url),'utf8'),c=await db.pool.connect();try{await c.query(`SET ROLE ${role}`);await c.query(sql);await c.query(sql);assert.equal((await c.query("SELECT shiori_private.records_admin('operator-fixture','migrate') result")).rows[0].result.status,'ok');await assert.rejects(c.query(await(await import('node:fs/promises')).readFile(new URL('../db/rollback/002_record_storage.sql',import.meta.url),'utf8')),e=>e.code==='42501');}finally{await c.query('ROLLBACK');try{await c.query('RESET ROLE');}finally{c.release();}}
  const rights=(await db.pool.query(`SELECT pg_has_role($1,'shiori_gateway_role','SET') AS elevated,has_schema_privilege('shiori_gateway_role','shiori_private','CREATE') AS create_schema`,[role])).rows[0];assert.deepEqual(rights,{elevated:false,create_schema:false});
 }finally{if(created)await db.pool.query(`DROP OWNED BY ${role} CASCADE; DROP ROLE ${role}`);await db.close();}
});
