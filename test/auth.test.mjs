import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../public/auth.js',import.meta.url),'utf8');
const context={module:{exports:{}},URLSearchParams};vm.runInNewContext(source,context);
const {completeEmailLink}=context.module.exports;
test('email links scrub URL, preview verified email and require confirmation before logging in',async()=>{
 const events=[];
 const result=await completeEmailLink({location:{hash:'#access_token=good-token&refresh_token=never-send',search:'',pathname:'/'},history:{replaceState(...args){events.push({type:'scrub',url:args[2]});}},confirmAccount:async email=>{events.push({type:'confirm',email});return true;},fetcher:async(path,options)=>{const body=JSON.parse(options.body);events.push({type:'request',path,body});return Response.json(body.action==='preview'?{email:'reader@example.com',state:'new-state'}:{ok:true});}});
 assert.equal(result,true);
 assert.deepEqual(events,[{type:'scrub',url:'/'},{type:'request',path:'/api/session',body:{action:'preview',accessToken:'good-token'}},{type:'confirm',email:'reader@example.com'},{type:'request',path:'/api/session',body:{accessToken:'good-token',state:'new-state',confirm:true}}]);
});
test('cancelling email account confirmation never creates a session',async()=>{
 let requests=0;
 const result=await completeEmailLink({location:{hash:'#access_token=good-token',search:'',pathname:'/'},history:{replaceState(){}},confirmAccount:async()=>false,fetcher:async(_,options)=>{requests++;assert.equal(JSON.parse(options.body).action,'preview');return Response.json({email:'reader@example.com',state:'state'});}});
 assert.equal(result,false);assert.equal(requests,1);
});
test('expired email links show a recoverable error and never attempt a session exchange',async()=>{
 let scrubbed=false;
 await assert.rejects(completeEmailLink({location:{hash:'#error=access_denied&error_description=expired',search:'',pathname:'/'},history:{replaceState(){scrubbed=true;}},fetcher:async()=>{assert.fail('Must not exchange expired links');}}),/期限切れ/);
 assert.equal(scrubbed,true);
});
