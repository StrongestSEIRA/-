import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../server.mjs';
const fixturePassword='test-only-password-12345';
const config={mode:'supabase',url:'https://example.supabase.co',publicKey:'public-fixture',secretKey:'server-secret-fixture',appUrl:'https://book-s-marker.onrender.com'};
async function running(options,work){const app=createApp({...config,...options});await new Promise(r=>app.listen(0,'127.0.0.1',r));try{await work(`http://127.0.0.1:${app.address().port}`);}finally{await new Promise(r=>app.close(r));}}
const post=(base,path,body,cookie='')=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(body)});
const cookieHeader=response=>response.headers.getSetCookie().filter(s=>!s.includes('Max-Age=0')).map(s=>s.split(';')[0]).join('; ');
test('password login uses public auth API, returns only HttpOnly secure cookies and sends no email',async()=>{
 const paths=[];
 await running({fetcher:async(url,init)=>{paths.push(url);assert.equal(init.headers.apikey,config.publicKey);
  if(url.includes('grant_type=password')){assert.deepEqual(JSON.parse(init.body),{email:'reader@example.com',password:fixturePassword});return Response.json({access_token:'access-fixture',refresh_token:'refresh-fixture',expires_in:3600,user:{id:'reader'}});}
  assert.ok(url.endsWith('/auth/v1/user'));assert.equal(init.headers.Authorization,'Bearer access-fixture');return Response.json({id:'reader',email:'reader@example.com'});
 }},async base=>{
  const r=await post(base,'/api/session',{action:'login',email:'reader@example.com',password:fixturePassword});assert.equal(r.status,200);assert.deepEqual(await r.json(),{ok:true});
  const cookies=r.headers.getSetCookie();for(const value of cookies){assert.match(value,/HttpOnly/);assert.match(value,/Secure/);assert.match(value,/SameSite=Lax/);assert.ok(!value.includes(fixturePassword));}
  assert.ok(cookies.some(s=>s.startsWith('shiori_refresh=refresh-fixture;')&&s.includes('Path=/api/')));
  const account=await fetch(base+'/api/account',{headers:{Cookie:cookieHeader(r)}});assert.equal(account.status,200);assert.equal((await account.json()).id,'reader');
  const html=await(await fetch(base+'/')).text();assert.ok(!html.includes(config.secretKey));assert.ok(!html.includes(fixturePassword));assert.ok(!html.includes('refresh-fixture'));
  assert.ok(paths.every(p=>!p.includes('/otp')&&!p.includes('/recover')&&!p.includes('/signup')));
 });
});
test('wrong password is rejected generically; signup validates before public signup and preserves email confirmation',async()=>{
 let calls=0;await running({fetcher:async(url,init)=>{calls++;if(url.includes('grant_type=password'))return Response.json({code:'invalid_credentials'},{status:400});assert.ok(url.includes('/auth/v1/signup?'));assert.equal(init.headers.apikey,config.publicKey);assert.ok(!('email_confirm' in JSON.parse(init.body)));return Response.json({id:'new-user'});}},async base=>{
  const wrong=await post(base,'/api/session',{action:'login',email:'reader@example.com',password:fixturePassword});assert.equal(wrong.status,401);assert.equal(wrong.headers.getSetCookie().length,0);assert.match((await wrong.json()).error,/メールアドレスまたはパスワード/);
  for(const password of ['short','x'.repeat(73)])assert.equal((await post(base,'/api/session',{action:'signup',email:'reader@example.com',password})).status,400);
  assert.equal(calls,1);
  const signup=await post(base,'/api/session',{action:'signup',email:'reader@example.com',password:fixturePassword});assert.deepEqual(await signup.json(),{confirmationRequired:true});assert.equal(signup.headers.getSetCookie().length,0);assert.equal(calls,2);
 });
});
test('expired session refreshes once for concurrent requests without email or password',async()=>{
 let refreshCount=0;
 await running({fetcher:async(url,init)=>{
  if(url.endsWith('/user'))return Response.json({code:'bad_jwt'},{status:401});
  assert.ok(url.includes('grant_type=refresh_token'));assert.deepEqual(JSON.parse(init.body),{refresh_token:'old-refresh'});refreshCount++;await new Promise(r=>setTimeout(r,20));return Response.json({access_token:'new-access',refresh_token:'new-refresh',expires_in:3600,user:{id:'reader',email:'reader@example.com'}});
 }},async base=>{
  const results=await Promise.all([1,2].map(()=>fetch(base+'/api/account',{headers:{Cookie:'shiori_session=expired; shiori_refresh=old-refresh'}})));
  for(const r of results){assert.equal(r.status,200);assert.equal((await r.json()).id,'reader');assert.ok(r.headers.getSetCookie().some(s=>s.startsWith('shiori_refresh=new-refresh;')));}assert.equal(refreshCount,1);
 });
});
test('revoked refresh token clears cookies, rather than retrying or mailing',async()=>{
 let calls=0;await running({fetcher:async(url)=>{calls++;assert.ok(url.includes('grant_type=refresh_token'));return Response.json({code:'refresh_token_not_found'},{status:400});}},async base=>{
  const r=await fetch(base+'/api/account',{headers:{Cookie:'shiori_refresh=revoked'}});assert.equal(r.status,401);assert.equal(calls,1);assert.ok(r.headers.getSetCookie().every(s=>s.includes('Max-Age=0')));
 });
});
test('password change requires authenticated user and uses user-scoped PUT; logout revokes refresh session',async()=>{
 const paths=[];await running({fetcher:async(url,init)=>{paths.push(url);assert.equal(init.headers.apikey,config.publicKey);assert.equal(init.headers.Authorization,'Bearer current-token');
  if(url.includes('/logout?'))return new Response(null,{status:204});
  if(init.method==='PUT'){assert.deepEqual(JSON.parse(init.body),{password:fixturePassword});return Response.json({id:'reader'});}
  return Response.json({id:'reader',email:'reader@example.com'});
 }},async base=>{
  assert.equal((await post(base,'/api/password',{password:fixturePassword})).status,401);assert.equal(paths.length,0);
  assert.equal((await post(base,'/api/password',{password:fixturePassword,email:'different@example.com'},'shiori_session=current-token')).status,200);
  const r=await post(base,'/api/logout',{},'shiori_session=current-token; shiori_refresh=current-refresh');assert.equal(r.status,200);assert.ok(paths.some(p=>p.endsWith('/logout?scope=local')));assert.ok(r.headers.getSetCookie().every(s=>s.includes('Max-Age=0')));
 });
});
test('old email-only login pages cannot send additional login mail after password migration',async()=>{
 let calls=0;await running({fetcher:async()=>{calls++;return Response.json({});}},async base=>{
  const r=await post(base,'/api/session',{action:'send',email:'reader@example.com'});assert.equal(r.status,410);assert.match((await r.json()).error,/再読み込み/);assert.equal(calls,0);
 });
});
