import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {launchBrowser,recordBrowser} from '../testing/browser.mjs';
import {createApp} from '../server.mjs';
test('photo-only registration survives reload, edit and portable backup without OCR or catalog requests',async()=>{
 const dir=await mkdtemp(tmpdir()+'/shiori-photo-');let metadataCalls=0;
 const app=createApp({dataDir:pathToFileURL(dir+'/'),fetcher:async()=>{metadataCalls++;throw Error('Catalog unavailable');}});
 await new Promise(r=>app.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.address().port}`;
 let browser;
 try{
  browser=await launchBrowser();
  const context=await browser.newContext({viewport:{width:390,height:844},acceptDownloads:true});
  await context.route('https://**/*',route=>route.abort());
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await recordBrowser('photo',page,async()=>{
  await page.goto(base);await page.locator('#add').click();
  assert.equal(await page.locator('#bookForm').count(),1);
  // A real browser-generated photo fixture avoids dependence on fonts or OCR assets.
  const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=240;c.height=640;const x=c.getContext('2d');x.fillStyle='#3d4b37';x.fillRect(0,0,c.width,c.height);x.fillStyle='#e7d9ac';x.fillRect(20,20,8,600);return c.toDataURL('image/png').split(',')[1];});
  await page.locator('#albumPhoto').setInputFiles({name:'spine.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
  await page.getByRole('button',{name:'写真だけで登録',exact:true}).waitFor();
  assert.ok(await page.locator('#photoPreview img').isVisible());
  await page.getByRole('button',{name:'この写真を登録',exact:true}).click();
  await page.getByRole('heading',{name:'本の記録',exact:true}).waitFor();
  const stored=await(await fetch(base+'/api/library')).json();assert.equal(stored.books.length,1);assert.equal(stored.books[0].titlePending,true);assert.equal(stored.books[0].autoMetadata,false);assert.match(stored.books[0].cover,/^\/api\/covers\//);assert.equal(metadataCalls,0);
  const image=await fetch(base+stored.books[0].cover);assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/jpeg');assert.ok((await image.arrayBuffer()).byteLength>0);
  await page.reload();await page.locator('.book').click();await page.locator('#editBook').click();
  assert.ok(await page.locator('#photoPreview img').isVisible());
  await page.locator('[name=title]').fill('写真から登録した本');await page.locator('#saveBook').click();await page.getByRole('heading',{name:'本の記録',exact:true}).waitFor();
  const edited=await(await fetch(base+'/api/library')).json();assert.equal(edited.books[0].cover,stored.books[0].cover);assert.equal(edited.books[0].titlePending,false);assert.equal(edited.books[0].title,'写真から登録した本');
  await page.locator('#close').click();
  const downloadPromise=page.waitForEvent('download');await page.locator('#mobileExport').click();const download=await downloadPromise;const backup=JSON.parse(await readFile(await download.path(),'utf8'));assert.match(backup.books[0].cover,/^data:image\/jpeg;base64,/);assert.equal(backup.books[0].title,'写真から登録した本');
  const cleared=await fetch(base+'/api/library',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:edited.revision,books:[]})});assert.equal(cleared.status,200);
  await page.reload();await page.locator('#importFile').setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(backup))});await page.locator('.book').waitFor();
  const restored=await(await fetch(base+'/api/library')).json();assert.equal(restored.books.length,1);assert.equal(restored.books[0].title,'写真から登録した本');assert.match(restored.books[0].cover,/^\/api\/covers\//);assert.notEqual(restored.books[0].cover,stored.books[0].cover);assert.equal((await fetch(base+restored.books[0].cover)).status,200);
  assert.equal(metadataCalls,0);assert.deepEqual(errors,[]);
  });
 }finally{if(browser)await browser.close();await new Promise(r=>app.close(r));await rm(dir,{recursive:true,force:true});}
});
