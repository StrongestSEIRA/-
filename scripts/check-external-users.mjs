// Manual live integration test. Creates and then removes two temporary users.
// No inbox, project membership, pre-confirmed seed user, or login email is used.
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {chromium} from 'playwright-core';
import {createApp} from '../server.mjs';
const url=process.env.SUPABASE_URL,publicKey=process.env.SUPABASE_PUBLIC_KEY,secretKey=process.env.SUPABASE_SECRET_KEY;
if(!url||!publicKey||!secretKey)throw Error('Configure Supabase bindings first');
const target=process.env.SHIORI_TEST_URL;
let app,browser;
const users=[1,2].map(()=>({email:'shiori-external-'+randomUUID()+'@example.com',password:randomBytes(24).toString('base64url')}));
async function admin(path,method='GET',body){const r=await fetch(url+path,{method,headers:{apikey:secretKey,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});const data=r.status===204?{}:await r.json();if(!r.ok)throw Error('Cleanup/admin request failed: HTTP '+r.status);return data;}
async function rpc(owner,action,payload={}){return admin('/rest/v1/rpc/shiori_gateway','POST',{p_owner:owner,p_action:action,p_payload:payload});}
try{
 let base=target;
 if(!base){app=createApp({mode:'supabase',url,publicKey,secretKey});await new Promise(r=>app.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${app.address().port}`;}
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage'],...(process.env.HTTPS_PROXY?{proxy:{server:process.env.HTTPS_PROXY,bypass:'127.0.0.1,localhost'}}:{})});
 for(const user of users){
  user.context=await browser.newContext({viewport:{width:390,height:844}});await user.context.route('https://fonts.googleapis.com/**',r=>r.abort());await user.context.route('https://fonts.gstatic.com/**',r=>r.abort());user.page=await user.context.newPage();
  await user.page.goto(base,{waitUntil:'domcontentloaded',timeout:60000});await user.page.locator('#goSignup').click();
  await user.page.locator('[name=email]').fill(user.email);await user.page.locator('[name=password]').fill(user.password);await user.page.locator('[name=confirmation]').fill(user.password);
  await user.page.locator('#authForm .primary').click();
  await user.page.locator('#overlay').waitFor({state:'hidden',timeout:30000});
  const account=await user.context.request.get(base+'/api/account');assert.equal(account.status(),200);const info=await account.json();assert.ok(info.id);assert.equal(info.email,user.email);user.id=info.id;
  const initial=await user.context.request.get(base+'/api/library');assert.equal(initial.status(),200);assert.deepEqual((await initial.json()).books,[]);
 }
 assert.notEqual(users[0].id,users[1].id);
 console.log('PASS: two independent browser contexts registered new non-member accounts through the public form without email');
 const a=users[0],b=users[1];
 await a.page.locator('#add').click();
 const data=await a.page.evaluate(()=>{const c=document.createElement('canvas');c.width=180;c.height=300;c.getContext('2d').fillRect(0,0,180,300);return c.toDataURL('image/png').split(',')[1];});
 await a.page.locator('#albumPhoto').setInputFiles({name:'test-cover.png',mimeType:'image/png',buffer:Buffer.from(data,'base64')});await a.page.locator('#savePhoto:enabled').waitFor();await a.page.locator('#savePhoto').click();await a.page.getByRole('heading',{name:'本の記録',exact:true}).waitFor();
 const stateA=await(await a.context.request.get(base+'/api/library')).json();assert.equal(stateA.books.length,1);const cover=stateA.books[0].cover;assert.match(cover,/^\/api\/covers\//);assert.equal((await a.context.request.get(base+cover)).status(),200);
 assert.equal((await b.context.request.get(base+cover)).status(),404);assert.deepEqual((await(await b.context.request.get(base+'/api/library')).json()).books,[]);
 console.log('PASS: registered external user can save and reload a private photo; the other user cannot access it');
 await b.page.locator('#add').click();await b.page.locator('[name=title]').fill('別アカウントのテスト本');await b.page.locator('#saveBook').click();await b.page.getByRole('heading',{name:'本の記録',exact:true}).waitFor();
 assert.equal((await(await a.context.request.get(base+'/api/library')).json()).books.length,1);assert.notEqual((await(await b.context.request.get(base+'/api/library')).json()).books[0].id,stateA.books[0].id);
 await a.page.locator('#close').click();await a.page.locator('#mobileAccess').click();await a.page.locator('#logout').click();await a.page.locator('#authForm').waitFor();assert.equal((await a.context.request.get(base+'/api/library')).status(),401);
 await a.page.locator('[name=email]').fill(a.email);await a.page.locator('[name=password]').fill(a.password);await a.page.locator('#authForm .primary').click();await a.page.locator('#overlay').waitFor({state:'hidden',timeout:30000});assert.equal((await(await a.context.request.get(base+'/api/library')).json()).books[0].cover,cover);
 await a.context.clearCookies({name:'shiori_session'});assert.equal((await a.context.request.get(base+'/api/account')).status(),200);
 console.log('PASS: user data remains separate, logout blocks access, password login and refresh work without email');
}finally{
 if(browser)await browser.close();if(app)await new Promise(r=>app.close(r));
 for(const user of users){
  if(!user.id){const found=await admin('/auth/v1/admin/users?filter='+encodeURIComponent(user.email)+'&per_page=100');user.id=found.users?.find(u=>u.email===user.email)?.id;}
  if(!user.id)continue;
  const root=await rpc(user.id,'root');if(root)await rpc(user.id,'apply',{operations:[{kind:'roots',action:'delete',version:root.version}]});
  const objects=await admin('/storage/v1/object/list/shiori-covers','POST',{prefix:user.id,limit:100});const paths=Array.isArray(objects)?objects.filter(o=>typeof o.name==='string'&&/^[a-f0-9-]+\.jpg$/.test(o.name)).map(o=>user.id+'/'+o.name):[];if(paths.length)await admin('/storage/v1/object/shiori-covers','DELETE',{prefixes:paths});
  await admin('/auth/v1/admin/users/'+encodeURIComponent(user.id),'DELETE');
 }
 console.log('Temporary users, private photographs and library rows removed; audit history retained');
}
