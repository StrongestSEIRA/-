import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../server.mjs';
import {randomUUID} from 'node:crypto';
import {isolatedDatabase,serviceQuery} from '../testing/database.mjs';
test('PostgreSQL CAS serializes independent writers, deduplicates retries and preserves data through rollback',{skip:!process.env.SHIORI_TEST_DATABASE_URL},async()=>{
 const db=await isolatedDatabase();try{
  await db.apply('db/migrations/001_atomic_library.sql');await db.apply('db/migrations/001_atomic_library.sql');
  const cas=async(owner,revision,books,key=randomUUID())=>(await serviceQuery(db.pool,'SELECT public.shiori_library_cas($1,$2,$3,$4) AS result',[owner,revision,JSON.stringify(books),key])).rows[0].result;
  const initial=await Promise.all([cas('owner-a',0,[{id:'a'}]),cas('owner-a',0,[{id:'b'}])]);assert.deepEqual(initial.map(r=>r.status).sort(),['conflict','ok']);
  const concurrent=await Promise.all(Array.from({length:10},(_,i)=>cas('owner-a',1,[{id:'book-'+i}])));assert.equal(concurrent.filter(r=>r.status==='ok').length,1);assert.equal(concurrent.filter(r=>r.status==='conflict').length,9);
  const key=randomUUID(),first=await cas('owner-a',2,[{id:'stable'}],key),retry=await cas('owner-a',2,[{id:'stable'}],key);assert.equal(first.revision,3);assert.equal(retry.replayed,true);assert.equal(retry.revision,3);assert.equal((await cas('owner-a',2,[{id:'different'}],key)).status,'idempotency_mismatch');
  assert.equal((await cas('owner-b',0,[{id:'private'}])).status,'ok');
  const rows=await db.pool.query('SELECT owner,data,version FROM shiori_private.roots ORDER BY owner');assert.equal(rows.rows[0].version,'3');assert.equal(rows.rows[0].data.books[0].id,'stable');assert.equal(rows.rows[1].data.books[0].id,'private');
  const c=await db.pool.connect();try{await c.query('SET ROLE authenticated');await assert.rejects(c.query('SELECT public.shiori_library_cas($1,0,$2,$3)',['owner-a','[]',randomUUID()]),e=>e.code==='42501');}finally{await c.query('RESET ROLE');c.release();}
  let dropResponse=true;
  const fetcher=async(url,init)=>{
   if(url.endsWith('/auth/v1/user'))return Response.json({id:'http-owner',email:'test@example.com'});
   const body=JSON.parse(init.body);const data=(await serviceQuery(db.pool,'SELECT public.shiori_library_cas($1,$2,$3,$4) AS result',[body.p_owner,body.p_revision,JSON.stringify(body.p_books),body.p_request_id])).rows[0].result;
   if(dropResponse){dropResponse=false;throw Error('simulated response lost after DB commit');}return Response.json(data);
  };
  const apps=[createApp({mode:'supabase',url:'https://example.supabase.co',publicKey:'test',secretKey:'test',snapshotWriteMode:'atomic',fetcher}),createApp({mode:'supabase',url:'https://example.supabase.co',publicKey:'test',secretKey:'test',snapshotWriteMode:'atomic',fetcher})];
  for(const app of apps)await new Promise(r=>app.listen(0,'127.0.0.1',r));
  try{const key=randomUUID(),body={books:[],revision:0};const put=(app,value=body)=>fetch(`http://127.0.0.1:${app.address().port}/api/library`,{method:'PUT',headers:{Cookie:'shiori_session=test','Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(value)});
   assert.equal((await put(apps[0])).status,500);const retried=await put(apps[1]);assert.equal(retried.status,200);assert.equal((await retried.json()).replayed,true);assert.equal((await put(apps[1],{books:[],revision:1})).status,409);
  }finally{for(const app of apps)await new Promise(r=>app.close(r));}
  await db.apply('db/rollback/001_atomic_library.sql');assert.deepEqual((await db.pool.query('SELECT data FROM shiori_private.roots WHERE owner=$1',['owner-a'])).rows[0].data.books,[{id:'stable'}]);
 }finally{await db.close();}
});
test('migration can be reapplied by a non-superuser operator and restores temporary role privileges',{skip:!process.env.SHIORI_TEST_DATABASE_URL},async()=>{
 const db=await isolatedDatabase(),role='shiori_operator_'+randomUUID().replaceAll('-','');let created=false;
 try{
  await db.apply('db/migrations/001_atomic_library.sql');
  await db.pool.query(`CREATE ROLE ${role} CREATEROLE; GRANT shiori_gateway_role TO ${role} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE; ALTER SCHEMA shiori_private OWNER TO ${role}; GRANT CREATE ON SCHEMA public TO ${role}; ALTER TABLE shiori_private.library_requests OWNER TO ${role}; ALTER FUNCTION public.shiori_library_cas(text,bigint,jsonb,text) OWNER TO ${role};`);created=true;
  const sql=await(await import('node:fs/promises')).readFile(new URL('../db/migrations/001_atomic_library.sql',import.meta.url),'utf8');const c=await db.pool.connect();
  try{await c.query(`SET ROLE ${role}`);await c.query(sql);await c.query(sql);}finally{await c.query('RESET ROLE');c.release();}
  const rights=await db.pool.query(`SELECT pg_has_role($1,'shiori_gateway_role','SET') AS can_set,has_schema_privilege('shiori_gateway_role','shiori_private','CREATE') AS can_create`,[role]);assert.equal(rights.rows[0].can_set,false);assert.equal(rights.rows[0].can_create,false);
 }finally{if(created){await db.pool.query(`DROP OWNED BY ${role} CASCADE; DROP ROLE ${role};`);}await db.close();}
});
