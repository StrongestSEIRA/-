import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createApp} from '../server.mjs';
import {launchBrowser,recordBrowser} from '../testing/browser.mjs';
test('book and note CRUD, cross-book tags, conflict preservation and retry without duplicate writes',async()=>{
 const dir=await mkdtemp(tmpdir()+'/shiori-crud-'),app=createApp({dataDir:pathToFileURL(dir+'/')});await new Promise(r=>app.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.address().port}`;let browser;
 try{
  browser=await launchBrowser();const context=await browser.newContext({acceptDownloads:true});await context.route('https://**/*',r=>r.abort());const page=await context.newPage();
  await recordBrowser('library-crud-conflict',page,async()=>{
   await page.goto(base);await page.locator('#add').click();await page.locator('[name=title]').fill('最初の本');await page.locator('[name=tags]').fill('共通タグ');await page.locator('#saveBook').click();await page.locator('#editBook').waitFor();
   await page.locator('#addNote').click();await page.locator('[name=text]').fill('残すメモ');await page.locator('[name=tags]').fill('考察');await page.locator('#noteForm .primary').click();await page.locator('#addNote').waitFor();await page.locator('#close').click();
   const stale=await context.newPage();await stale.goto(base);await stale.locator('#add').click();await stale.locator('[name=title]').fill('競合した入力');
   await page.locator('#add').click();await page.locator('[name=title]').fill('二冊目');await page.locator('[name=tags]').fill('共通タグ');await page.locator('#saveBook').click();await page.locator('#editBook').waitFor();
   await stale.locator('#saveBook').click();await stale.locator('#saveConflict').waitFor();assert.equal(await stale.locator('[name=title]').inputValue(),'競合した入力');const downloadPromise=stale.waitForEvent('download');await stale.locator('#saveConflict button').click();const draft=JSON.parse(await readFile(await(await downloadPromise).path(),'utf8'));assert.ok(draft.books.some(b=>b.title==='競合した入力'));
   await page.locator('#close').click();await page.locator('.book').filter({hasText:'最初の本'}).click();await page.locator('#editBook').click();await page.locator('[name=title]').fill('編集した本');
   await page.route('**/api/library',async route=>{if(route.request().method()!=='PUT')return route.continue();await route.fetch();await route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'simulated lost response'})});},{times:1});
   await page.locator('#saveBook').click();await page.getByRole('status').filter({hasText:'simulated lost response'}).waitFor();assert.equal(await page.locator('[name=title]').inputValue(),'編集した本');const before=await(await fetch(base+'/api/library')).json();await page.locator('#saveBook').click();await page.locator('#editBook').waitFor();const after=await(await fetch(base+'/api/library')).json();assert.equal(after.revision,before.revision);assert.equal(after.books.length,2);
   await page.locator('[data-del-note]').click();await page.locator('#confirmDeleteNote').click();await page.locator('#addNote').waitFor();assert.equal((await(await fetch(base+'/api/library')).json()).books.find(b=>b.title==='編集した本').notes.length,0);
   await page.locator('#close').click();await page.locator('[data-view=tags]').click();await page.locator('[data-tag="共通タグ"]').first().click();assert.equal(await page.locator('.book').count(),2);
   await page.locator('.book').filter({hasText:'二冊目'}).click();await page.locator('#editBook').click();await page.locator('#deleteBook').click();await page.locator('#yesDelete').click();await page.locator('#overlay').waitFor({state:'hidden'});assert.equal((await(await fetch(base+'/api/library')).json()).books.length,1);
  });
 }finally{if(browser)await browser.close();await new Promise(r=>app.close(r));await rm(dir,{recursive:true,force:true});}
});
