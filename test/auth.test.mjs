import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../public/auth.js',import.meta.url),'utf8');
const context={module:{exports:{}},URLSearchParams};vm.runInNewContext(source,context);
const {completeEmailLink}=context.module.exports;
test('magic link exchanges fragment token after scrubbing URL, without sending refresh tokens',async()=>{
 const events=[];
 await completeEmailLink({location:{hash:'#access_token=good-token&refresh_token=never-send',search:'?login_state=state',pathname:'/'},history:{replaceState(...args){events.push({type:'scrub',url:args[2]});}},fetcher:async(path,options)=>{events.push({type:'request',path,body:JSON.parse(options.body)});return Response.json({ok:true});}});
 assert.deepEqual(events,[{type:'scrub',url:'/'},{type:'request',path:'/api/session',body:{accessToken:'good-token',state:'state'}}]);
});
test('expired email links show a recoverable error and never attempt a session exchange',async()=>{
 let scrubbed=false;
 await assert.rejects(completeEmailLink({location:{hash:'#error=access_denied&error_description=expired',search:'',pathname:'/'},history:{replaceState(){scrubbed=true;}},fetcher:async()=>{assert.fail('Must not exchange expired links');}}),/期限切れ/);
 assert.equal(scrubbed,true);
});
