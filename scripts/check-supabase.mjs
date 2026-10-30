import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const base=process.env.SUPABASE_URL;
const publicKey=process.env.SUPABASE_PUBLIC_KEY;
const secretKey=process.env.SUPABASE_SECRET_KEY;
if(!base||!publicKey||!secretKey)throw Error('Configure the three SUPABASE variables in environment settings first');
async function request(path,key,body){const r=await fetch(base+path,{method:body?'POST':'GET',headers:{apikey:key,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});return {status:r.status,data:await r.json()};}
const settings=await request('/auth/v1/settings',publicKey);assert.equal(settings.status,200);assert.equal(settings.data.external.email,true);console.log('PASS: public key and email authentication settings');
const owner='shiori-readiness-'+randomUUID();
const rpc=(action,payload={},key=secretKey)=>request('/rest/v1/rpc/shiori_gateway',key,{p_owner:owner,p_action:action,p_payload:payload});
const denied=await rpc('root',{},publicKey);assert.ok([401,403,404].includes(denied.status));console.log('PASS: public key cannot read private library gateway');
assert.equal((await rpc('root')).data,null);console.log('PASS: secret key can read the private gateway');
if(process.argv.includes('--write-check')){
 let created=false;
 const book={id:randomUUID(),title:'一時接続テスト',author:'',date:new Date().toISOString().slice(0,10),summary:'',tags:[],notes:[{id:randomUUID(),text:'一時メモ',tags:[]}]};
 try{
  assert.equal((await rpc('apply',{operations:[{kind:'roots',action:'create',data:{books:[book]}}]})).status,200);created=true;
  const r=await rpc('root');assert.deepEqual(r.data.data.books,[book]);assert.equal(r.data.version,1);
  assert.equal((await rpc('apply',{operations:[{kind:'roots',action:'replace',version:1,data:{books:[]}}]})).status,200);
  const updated=await rpc('root');assert.deepEqual(updated.data.data.books,[]);assert.equal(updated.data.version,2);
  console.log('PASS: live book/note persistence and revision update');
 }finally{if(created){const r=await rpc('root');assert.equal((await rpc('apply',{operations:[{kind:'roots',action:'delete',version:r.data.version}]})).status,200);assert.equal((await rpc('root')).data,null);console.log('PASS: temporary library deleted; audit history remains');}}
}
