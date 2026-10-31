import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRegistration} from '../registration.mjs';
const error=code=>Object.assign(Error('provider error'),{authCode:code});
function provider({confirmed=false,disabled=false}={}){
 const user={id:'existing-id',email:'pending@example.com',password:'existing-test-password',confirmed};const calls=[];
 const api=async(path,body,key,token,method)=>{
  calls.push({path,body,key,method});
  if(path==='/auth/v1/settings')return {disable_signup:disabled,external:{email:true},mailer_autoconfirm:false};
  if(path==='/auth/v1/admin/users'&&body)throw error('email_exists');
  if(path==='/auth/v1/token?grant_type=password'){if(body.email!==user.email||body.password!==user.password)throw error('invalid_credentials');if(!user.confirmed)throw error('email_not_confirmed');return {access_token:'access',refresh_token:'refresh',user:{id:user.id}};}
  if(path.startsWith('/auth/v1/admin/users?filter='))return {users:[{id:user.id,email:user.email},{id:'other-id',email:'other@example.com'}]};
  if(path==='/auth/v1/admin/users/'+user.id&&method==='PUT'){assert.deepEqual(body,{email_confirm:true});user.confirmed=true;return {id:user.id};}
  assert.fail('Unexpected provider operation');
 };
 return {user,calls,register:createRegistration({api,secretKey:'test-secret'})};
}
test('pending account is completed only after proof of its existing password, retaining ID and password',async()=>{
 const p=provider();await assert.rejects(p.register(p.user.email,'wrong-password','ip'),e=>e.authCode==='invalid_credentials');assert.equal(p.user.confirmed,false);assert.ok(!p.calls.some(c=>c.method==='PUT'));
 const session=await p.register(p.user.email,p.user.password,'ip');assert.equal(session.user.id,'existing-id');assert.equal(p.user.password,'existing-test-password');assert.equal(p.user.confirmed,true);assert.equal(p.calls.filter(c=>c.method==='PUT').length,1);
});
test('project signup disable switch is respected and new signup attempts are bounded',async()=>{
 const disabled=provider({disabled:true});await assert.rejects(disabled.register(disabled.user.email,disabled.user.password,'ip'),e=>e.status===403);assert.equal(disabled.calls.length,1);
 const p=provider({confirmed:true});for(let i=0;i<5;i++)await p.register(p.user.email,p.user.password,'ip');await assert.rejects(p.register(p.user.email,p.user.password,'ip'),e=>e.status===429&&e.retryAfterSeconds>0);
});
