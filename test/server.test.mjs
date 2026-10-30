import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createApp} from '../server.mjs';
test('local library persists books and notes, rejects stale writes and invalid input',async()=>{
 const dir=await mkdtemp(tmpdir()+'/shiori-');const config={dataDir:pathToFileURL(dir+'/')};let app=createApp(config);
 const start=async()=>{await new Promise(r=>app.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${app.address().port}`};let base=await start();
 try{assert.equal((await fetch(base+'/')).status,200);assert.equal((await (await fetch(base+'/api/account')).json()).id,'local-development');
 const put=data=>fetch(base+'/api/library',{method:'PUT',body:JSON.stringify(data)});
 assert.deepEqual(await (await fetch(base+'/api/library')).json(),{books:[],revision:0});
 const book={id:'book1',title:'テスト本',author:'著者',date:'2026-10-30',summary:'',tags:['文学'],notes:[{id:'note1',text:'引用',tags:['言葉']}]};
 assert.equal((await put({books:[book],revision:0})).status,200);
 assert.equal((await put({books:[],revision:0})).status,409);
 assert.equal((await put({books:[{...book,id:'" onclick="bad'}],revision:1})).status,400);
 assert.equal((await fetch(base+'/api/library',{method:'PUT',headers:{Origin:'https://evil.example'},body:'{}'})).status,403);
 await new Promise(r=>app.close(r));app=createApp(config);base=await start();
 assert.deepEqual(await (await fetch(base+'/api/library')).json(),{books:[book],revision:1});
 assert.equal((await put({books:[],revision:1})).status,200);
 assert.deepEqual(await (await fetch(base+'/api/library')).json(),{books:[],revision:2});
 }finally{await new Promise(r=>app.close(r));await rm(dir,{recursive:true,force:true});}
});
test('supabase requires authentication and verifies user with Supabase',async()=>{
 const calls=[];const app=createApp({mode:'supabase',url:'https://example.supabase.co',publicKey:'public',secretKey:'secret',fetcher:async(url,init)=>{calls.push({url,init});return Response.json({id:'verified-user',email:'reader@example.com'});}});
 await new Promise(r=>app.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.address().port}`;
 try{assert.equal((await fetch(base+'/api/library')).status,401);assert.equal(calls.length,0);const r=await fetch(base+'/api/account',{headers:{Cookie:'shiori_session=test-token'}});assert.equal((await r.json()).id,'verified-user');assert.equal(calls[0].init.headers.Authorization,'Bearer test-token');}finally{await new Promise(r=>app.close(r));}
});
test('Supabase gateway uses verified owner and root revision when saving',async()=>{
 const calls=[];let stored=null;
 const app=createApp({mode:'supabase',url:'https://example.supabase.co',publicKey:'public-placeholder',secretKey:'secret-placeholder',fetcher:async(url,init)=>{
  if(url.endsWith('/auth/v1/user'))return Response.json({id:'verified-owner',email:'reader@example.com'});
  const body=JSON.parse(init.body);calls.push({body,headers:init.headers});
  assert.equal(body.p_owner,'verified-owner');
  if(body.p_action==='root')return Response.json(stored);
  const op=body.p_payload.operations[0];assert.equal(op.kind,'roots');
  stored={data:op.data,version:stored?stored.version+1:1};return Response.json({applied:true});
 }});
 await new Promise(r=>app.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.address().port}`;
 const headers={Cookie:'shiori_session=token','Content-Type':'application/json'};
 try{
  const book={id:'test-book',title:'本',author:'',date:'2026-10-30',summary:'',tags:[],notes:[]};
  let r=await fetch(base+'/api/library',{method:'PUT',headers,body:JSON.stringify({owner:'attacker',books:[book],revision:0})});
  assert.deepEqual(await r.json(),{revision:1});
  r=await fetch(base+'/api/library',{headers});assert.deepEqual(await r.json(),{books:[book],revision:1});
  r=await fetch(base+'/api/library',{method:'PUT',headers,body:JSON.stringify({books:[],revision:0})});assert.equal(r.status,409);
  assert.equal(calls.find(c=>c.body.p_action==='apply').headers.apikey,'secret-placeholder');
  assert.equal(calls.find(c=>c.body.p_action==='apply').body.p_payload.operations[0].action,'create');
 }finally{await new Promise(r=>app.close(r));}
});
test('email links use the deployed URL and require both login state and a verified Supabase token',async()=>{
 const calls=[];
 const app=createApp({mode:'supabase',url:'https://example.supabase.co',publicKey:'public',secretKey:'secret',appUrl:'https://book-s-marker.onrender.com',fetcher:async(url,init)=>{
  calls.push({url,init});
  if(url.includes('/otp?'))return Response.json({});
  if(init.headers.Authorization==='Bearer good-token')return Response.json({id:'verified-reader'});
  return Response.json({code:'invalid_token'},{status:401});
 }});
 await new Promise(r=>app.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.address().port}`;
 const post=(body,cookie='')=>fetch(base+'/api/session',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(body)});
 try{
  const sent=await post({email:'reader@example.com'});assert.equal(sent.status,200);
  const loginCookie=sent.headers.getSetCookie()[0].split(';')[0];const state=loginCookie.split('=')[1];
  const redirect=new URL(new URL(calls[0].url).searchParams.get('redirect_to'));
  assert.equal(redirect.origin,'https://book-s-marker.onrender.com');assert.equal(redirect.searchParams.get('login_state'),state);
  assert.equal((await post({accessToken:'good-token',state:'wrong'},loginCookie)).status,400);
  assert.equal((await post({accessToken:'good-token',state})).status,400);
  assert.equal(calls.length,1);
  assert.equal((await post({accessToken:'bad-token',state},loginCookie)).status,401);
  const loggedIn=await post({accessToken:'good-token',state},loginCookie);assert.equal(loggedIn.status,200);
  const cookies=loggedIn.headers.getSetCookie();assert.ok(cookies.some(s=>s.startsWith('shiori_session=good-token;')&&s.includes('HttpOnly')));
  assert.ok(cookies.some(s=>s.startsWith('shiori_login=;')&&s.includes('Max-Age=0')));
 }finally{await new Promise(r=>app.close(r));}
});
