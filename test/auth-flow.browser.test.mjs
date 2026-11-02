import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../server.mjs';
import {fakeSupabase} from '../testing/fake-supabase.mjs';
import {launchBrowser,recordBrowser} from '../testing/browser.mjs';
test('isolated browser accounts register, keep books/notes/photos private and handle logout and wrong passwords',async()=>{
 const provider=fakeSupabase(),app=createApp({mode:'supabase',url:'https://example.supabase.co',publicKey:'test-public',secretKey:'test-secret',fetcher:provider.fetcher});await new Promise(r=>app.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.address().port}`;let browser;
 try{
  browser=await launchBrowser();const a=await browser.newContext({viewport:{width:390,height:844}}),b=await browser.newContext({viewport:{width:390,height:844}});for(const c of [a,b])await c.route('https://**/*',r=>r.abort());const page=await a.newPage(),other=await b.newPage();
  await recordBrowser('auth-isolation',page,async()=>{
   for(const [p,email]of [[page,'one@example.com'],[other,'two@example.com']]){await p.goto(base);await p.locator('#goSignup').click();await p.locator('[name=email]').fill(email);await p.locator('[name=password]').fill('browser-test-password');await p.locator('[name=confirmation]').fill('browser-test-password');await p.locator('#authForm .primary').click();await p.locator('#overlay').waitFor({state:'hidden'});}
   await page.locator('#add').click();await page.locator('[name=title]').fill('自分の本');await page.locator('[name=tags]').fill('宇宙、読書');
   const image=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=60;c.height=100;return c.toDataURL('image/png').split(',')[1];});await page.locator('#albumPhoto').setInputFiles({name:'test.png',mimeType:'image/png',buffer:Buffer.from(image,'base64')});await page.locator('#photoPreview img').waitFor();await page.locator('#saveBook').click();await page.locator('#addNote').click();await page.locator('[name=text]').fill('この利用者の読書メモ');await page.locator('#noteForm .primary').click();await page.locator('#addNote').waitFor();
   const own=await(await a.request.get(base+'/api/library')).json();assert.equal(own.books[0].notes[0].text,'この利用者の読書メモ');assert.deepEqual((await(await b.request.get(base+'/api/library')).json()).books,[]);assert.equal((await b.request.get(base+own.books[0].cover)).status(),404);
   await page.locator('#close').click();await page.locator('#mobileAccess').click();await page.locator('#logout').click();await page.locator('#authForm').waitFor();assert.equal((await a.request.get(base+'/api/library')).status(),401);
   await page.locator('[name=email]').fill('one@example.com');await page.locator('[name=password]').fill('incorrect-password');await page.locator('#authForm .primary').click();await page.locator('#loginStatus').getByText('メールアドレスまたはパスワードが違います。',{exact:true}).waitFor();assert.equal((await a.request.get(base+'/api/library')).status(),401);
   await page.locator('[name=password]').fill('browser-test-password');await page.locator('#authForm .primary').click();await page.locator('#overlay').waitFor({state:'hidden'});assert.equal((await(await a.request.get(base+'/api/library')).json()).books.length,1);
   assert.ok(provider.calls.every(c=>!c.path.includes('/otp')&&!c.path.includes('/recover')));
  });
 }finally{if(browser)await browser.close();await new Promise(r=>app.close(r));}
});
