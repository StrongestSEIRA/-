import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server.mjs';
const book=id=>({id,title:id,author:'',date:'2026-11-02',summary:'',tags:[],notes:[]});
test('independent local servers preserve exactly one concurrent write and replay unknown-result retries',async()=>{
 const dir=await mkdtemp(tmpdir()+'/shiori-cas-'),dataDir=pathToFileURL(dir+'/');const apps=[createApp({dataDir}),createApp({dataDir})];
 for(const app of apps)await new Promise(r=>app.listen(0,'127.0.0.1',r));const urls=apps.map(a=>`http://127.0.0.1:${a.address().port}`);
 const put=(url,revision,books,key=randomUUID())=>fetch(url+'/api/library',{method:'PUT',headers:{'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify({books,revision})});
 try{
  const first=await Promise.all(urls.map((u,i)=>put(u,0,[book('book-'+i)])));assert.deepEqual(first.map(r=>r.status).sort(),[200,409]);
  const key=randomUUID();assert.equal((await put(urls[0],1,[book('persisted')],key)).status,200);const retry=await put(urls[1],1,[book('persisted')],key);assert.equal(retry.status,200);assert.deepEqual(await retry.json(),{revision:2,replayed:true});assert.equal((await put(urls[1],1,[book('different')],key)).status,409);
  assert.deepEqual(await(await fetch(urls[0]+'/api/library')).json(),{books:[book('persisted')],revision:2});
 }finally{for(const app of apps)await new Promise(r=>app.close(r));await rm(dir,{recursive:true,force:true});}
});
