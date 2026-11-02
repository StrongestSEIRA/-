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
test('signup validates input and creates a no-email account only on the server; wrong password stays generic',async()=>{
 let calls=0,created=false;await running({fetcher:async(url,init)=>{calls++;if(url.endsWith('/settings'))return Response.json({disable_signup:false,external:{email:true},mailer_autoconfirm:false});if(url.endsWith('/admin/users')){assert.equal(init.headers.apikey,config.secretKey);assert.equal(JSON.parse(init.body).email_confirm,true);created=true;return Response.json({id:'new-user'});}if(!created)return Response.json({code:400,error_code:'invalid_credentials'},{status:400});return Response.json({access_token:'new-access',refresh_token:'new-refresh',expires_in:3600});}},async base=>{
  const wrong=await post(base,'/api/session',{action:'login',email:'reader@example.com',password:fixturePassword});assert.equal(wrong.status,401);assert.equal(wrong.headers.getSetCookie().length,0);assert.match((await wrong.json()).error,/メールアドレスまたはパスワード/);
  for(const password of ['short','x'.repeat(73)])assert.equal((await post(base,'/api/session',{action:'signup',email:'reader@example.com',password})).status,400);assert.equal(calls,1);
  const signup=await post(base,'/api/session',{action:'signup',email:'reader@example.com',password:fixturePassword});assert.equal(signup.status,200);assert.deepEqual(await signup.json(),{ok:true});assert.ok(signup.headers.getSetCookie().some(s=>s.startsWith('shiori_refresh=')));assert.equal(calls,4);
 });
});
test('expired session refreshes once for concurrent requests without email or password',async()=>{
 let refreshCount=0;
 await running({fetcher:async(url,init)=>{
  if(url.endsWith('/user'))return init.headers.Authorization==='Bearer new-access'?Response.json({id:'reader',email:'reader@example.com'}):Response.json({code:'bad_jwt'},{status:401});
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
test('password change requires current-password proof and logout clears the rotated session',async()=>{
 const paths=[];await running({fetcher:async(url,init)=>{paths.push(url);assert.equal(init.headers.apikey,config.publicKey);
  if(url.includes('grant_type=password')){assert.equal(JSON.parse(init.body).password,'old-password');return Response.json({access_token:'reauth-token',refresh_token:'reauth-refresh',user:{id:'reader'}});}
  if(url.includes('/logout?'))return new Response(null,{status:204});
  if(init.method==='PUT'){assert.equal(init.headers.Authorization,'Bearer reauth-token');assert.deepEqual(JSON.parse(init.body),{password:fixturePassword});return Response.json({id:'reader'});}
  return Response.json({id:'reader',email:'reader@example.com'});
 }},async base=>{
  assert.equal((await post(base,'/api/password',{password:fixturePassword})).status,401);assert.equal(paths.length,0);
  assert.equal((await post(base,'/api/password',{password:fixturePassword},'shiori_session=current-token')).status,400);assert.ok(!paths.some(p=>p.includes('grant_type=password')));
  assert.equal((await post(base,'/api/password',{password:fixturePassword,currentPassword:'old-password',email:'different@example.com'},'shiori_session=current-token')).status,200);
  const r=await post(base,'/api/logout',{},'shiori_session=current-token; shiori_refresh=current-refresh');assert.equal(r.status,200);assert.ok(paths.some(p=>p.endsWith('/logout?scope=local')));assert.ok(r.headers.getSetCookie().every(s=>s.includes('Max-Age=0')));
 });
});
test('old email-only login pages cannot send additional login mail after password migration',async()=>{
 let calls=0;await running({fetcher:async()=>{calls++;return Response.json({});}},async base=>{
  const r=await post(base,'/api/session',{action:'send',email:'reader@example.com'});assert.equal(r.status,410);assert.match((await r.json()).error,/再読み込み/);assert.equal(calls,0);
 });
});
test('duplicate signup with incorrect password does not overwrite an existing account',async()=>{
 const calls=[];await running({fetcher:async(url,init)=>{calls.push({url,init});if(url.endsWith('/settings'))return Response.json({disable_signup:false,external:{email:true}});if(url.endsWith('/admin/users'))return Response.json({code:422,error_code:'email_exists'},{status:422});return Response.json({code:400,error_code:'invalid_credentials'},{status:400});}},async base=>{
  const r=await post(base,'/api/session',{action:'signup',email:'existing@example.com',password:fixturePassword});assert.equal(r.status,401);assert.equal(r.headers.getSetCookie().length,0);assert.equal(calls.length,3);assert.ok(!calls.some(c=>c.init.method==='PUT'));
 });
});
test('recovery acknowledgement does not claim confirmed mail delivery; unauthorized destination is actionable and redacted',async()=>{
 let reject=false;const calls=[];await running({fetcher:async(url,init)=>{calls.push({url,init});return reject?Response.json({code:'email_address_not_authorized',msg:'private-recipient@example.com is not authorized'},{status:400}):Response.json({});}},async base=>{
  const r=await post(base,'/api/session',{action:'recover',email:'existing@example.com'});assert.equal(r.status,200);assert.deepEqual(await r.json(),{recoveryRequested:true});assert.ok(calls[0].url.includes('/recover?'));assert.deepEqual(JSON.parse(calls[0].init.body),{email:'existing@example.com'});
  reject=true;const denied=await post(base,'/api/session',{action:'recover',email:'other@example.com'});assert.equal(denied.status,400);const error=await denied.json();assert.match(error.error,/この宛先には標準メール配信から送れません/);assert.ok(!error.error.includes('private-recipient'));
 });
});
test('unconfirmed email is reported as confirmation required, not incorrectly as wrong password',async()=>{
 let calls=0;await running({fetcher:async(url)=>{calls++;assert.ok(url.includes('grant_type=password'));return Response.json({code:400,error_code:'email_not_confirmed',msg:'Email not confirmed'},{status:400});}},async base=>{
  const r=await post(base,'/api/session',{action:'login',email:'reader@example.com',password:fixturePassword});assert.equal(r.status,403);assert.match((await r.json()).error,/メールアドレスの確認が必要/);assert.equal(r.headers.getSetCookie().length,0);assert.equal(calls,1);
 });
});

test('numeric HTTP code with Supabase error_code preserves unauthorized email and wrong password diagnostics',async()=>{
 for(const c of [{upstream:{code:400,error_code:'email_address_not_authorized',msg:'private-recipient@example.com is not authorized'},action:'recover',status:400,expected:/この宛先には標準メール配信から送れません/},{upstream:{code:400,error_code:'invalid_credentials',msg:'Invalid login credentials'},action:'login',status:401,expected:/メールアドレスまたはパスワード/}]){
  await running({fetcher:async()=>Response.json(c.upstream,{status:400})},async base=>{const r=await post(base,'/api/session',{action:c.action,email:'reader@example.com',password:fixturePassword});assert.equal(r.status,c.status);const d=await r.json();assert.match(d.error,c.expected);assert.ok(!d.error.includes('private-recipient'));});
 }
});
test('new registration works without changing the project-wide email confirmation setting',async()=>{
 const calls=[];await running({fetcher:async(url,init)=>{calls.push({url,init});if(url.endsWith('/settings'))return Response.json({mailer_autoconfirm:false,disable_signup:false,external:{email:true}});if(url.endsWith('/admin/users')){assert.equal(init.headers.apikey,config.secretKey);assert.equal(JSON.parse(init.body).email_confirm,true);return Response.json({id:'new-reader'});}assert.equal(init.headers.apikey,config.publicKey);if(url.includes('grant_type=password'))return Response.json({access_token:'new-access',refresh_token:'new-refresh',expires_in:3600,user:{id:'new-reader'}});return Response.json({id:'new-reader',email:'reader@example.com'});}},async base=>{
  const r=await post(base,'/api/session',{action:'signup',email:'reader@example.com',password:fixturePassword});assert.equal(r.status,200);assert.deepEqual(await r.json(),{ok:true});const account=await fetch(base+'/api/account',{headers:{Cookie:cookieHeader(r)}});assert.equal(account.status,200);assert.equal((await account.json()).id,'new-reader');assert.ok(calls.every(c=>!c.url.includes('/otp')&&!c.url.includes('/recover')&&!c.url.includes('/signup?')));
 });
});
