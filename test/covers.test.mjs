import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../server.mjs';
const image=Buffer.from([255,216,255,224,0,2,255,217]);
test('photo API is private, scopes downloads by verified owner and rejects non-image payloads',async()=>{
 const objects=new Map();let uploadCalls=0;
 const app=createApp({mode:'supabase',url:'https://example.supabase.co',publicKey:'public',secretKey:'secret',fetcher:async(url,init)=>{
  if(url.endsWith('/auth/v1/user'))return Response.json({id:init.headers.Authorization==='Bearer a'?'owner-a':'owner-b'});
  assert.equal(init.headers.apikey,'secret');
  if(url.endsWith('/bucket/shiori-covers'))return Response.json({public:false});
  if(init.method==='POST'){uploadCalls++;objects.set(url.split('/object/shiori-covers/')[1],init.body);return Response.json({ok:true});}
  const key=url.split('/object/authenticated/shiori-covers/')[1];return objects.has(key)?new Response(objects.get(key)):Response.json({error:'missing'},{status:404});
 }});
 await new Promise(r=>app.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.address().port}`;
 try{
  assert.equal((await fetch(base+'/api/covers',{method:'POST',body:image,headers:{'Content-Type':'image/jpeg'}})).status,401);
  assert.equal(uploadCalls,0);
  const bad=await fetch(base+'/api/covers',{method:'POST',body:'<script>bad</script>',headers:{Cookie:'shiori_session=a','Content-Type':'image/jpeg'}});assert.equal(bad.status,400);
  const r=await fetch(base+'/api/covers',{method:'POST',body:image,headers:{Cookie:'shiori_session=a','Content-Type':'image/jpeg'}});assert.equal(r.status,201);const {url}=await r.json();
  const own=await fetch(base+url,{headers:{Cookie:'shiori_session=a'}});assert.equal(own.status,200);assert.deepEqual(Buffer.from(await own.arrayBuffer()),image);assert.equal(own.headers.get('cache-control'),'no-store');
  assert.equal((await fetch(base+url,{headers:{Cookie:'shiori_session=b'}})).status,404);
  assert.equal((await fetch(base+url)).status,401);assert.equal(uploadCalls,1);
 }finally{await new Promise(r=>app.close(r));}
});
