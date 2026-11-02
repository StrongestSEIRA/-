import {test} from 'node:test';
import assert from 'node:assert/strict';
import {hasRecentOtpProof,clientAddress} from '../auth-security.mjs';
import {createRegistration} from '../registration.mjs';
import {createApp} from '../server.mjs';
const jwt=claims=>'header.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.signature';
test('only a fresh provider-verified OTP authentication method qualifies as password reset proof',()=>{
 const now=Date.now(),timestamp=Math.floor(now/1000);
 assert.equal(hasRecentOtpProof(jwt({amr:[{method:'otp',timestamp}]}),now),true);
 for(const claims of [{amr:[{method:'password',timestamp}]},{iat:timestamp,amr:[{method:'otp',timestamp:timestamp-700}]},{amr:[{method:'otp',timestamp:timestamp+1000}]},{}])assert.equal(hasRecentOtpProof(jwt(claims),now),false);
 assert.equal(hasRecentOtpProof('invalid'),false);
});
test('forwarding headers cannot bypass signup throttling unless the deployment explicitly trusts its proxy',()=>{
 const req={headers:{'x-forwarded-for':'spoofed, real-client'},socket:{remoteAddress:'peer'}};assert.equal(clientAddress(req),'peer');assert.equal(clientAddress(req,true),'real-client');
});
test('verified/closed registration policies avoid administrative account confirmation and preserve legacy default separately',async()=>{
 const calls=[];const api=async(path)=>{calls.push(path);return path.includes('/settings')?{external:{email:true}}:{user:{id:'pending'}};};
 const verified=createRegistration({api,secretKey:'test',policy:'verified'});await verified('a@example.com','test-password','peer');assert.deepEqual(calls,['/auth/v1/settings','/auth/v1/signup']);
 const closed=createRegistration({api,secretKey:'test',policy:'closed'});await assert.rejects(closed('b@example.com','test-password','peer'),e=>e.status===403);assert.equal(calls.length,2);
});
test('cross-site credentialed POST without Origin is denied before any provider call; invalid JSON shape is rejected',async()=>{
 let calls=0;const app=createApp({mode:'supabase',url:'https://example.supabase.co',publicKey:'test',secretKey:'test',fetcher:async()=>{calls++;return Response.json({});}});await new Promise(r=>app.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.address().port}`;
 try{const r=await fetch(base+'/api/password',{method:'POST',headers:{Cookie:'shiori_session=stolen','Sec-Fetch-Site':'cross-site','Content-Type':'application/json'},body:'{}'});assert.equal(r.status,403);assert.equal(calls,0);assert.equal((await fetch(base+'/api/session',{method:'POST',body:'null'})).status,400);}finally{await new Promise(r=>app.close(r));}
});
test('a rejected forged OTP token cannot grant reset privileges after a valid refresh',async()=>{
 const forged=jwt({amr:[{method:'otp',timestamp:Math.floor(Date.now()/1000)}]});let writes=0;
 const app=createApp({mode:'supabase',url:'https://example.supabase.co',publicKey:'test',secretKey:'test',fetcher:async(url,init)=>{
  if(url.includes('grant_type=refresh_token'))return Response.json({access_token:'verified-password-token',refresh_token:'new-refresh'});
  if(init.method==='PUT'){writes++;return Response.json({});}
  return init.headers.Authorization==='Bearer verified-password-token'?Response.json({id:'reader',email:'reader@example.com'}):Response.json({code:'bad_jwt'},{status:401});
 }});await new Promise(r=>app.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.address().port}`,headers={Cookie:'shiori_session='+forged+'; shiori_refresh=valid-refresh'};
 try{const account=await fetch(base+'/api/account',{headers});assert.equal((await account.json()).passwordChangeRequiresCurrent,true);const change=await fetch(base+'/api/password',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({password:'new-long-password'})});assert.equal(change.status,400);assert.equal(writes,0);}finally{await new Promise(r=>app.close(r));}
});
