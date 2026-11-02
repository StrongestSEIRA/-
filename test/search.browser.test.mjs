import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {launchBrowser,recordBrowser} from '../testing/browser.mjs';
import {createApp} from '../server.mjs';
test('catalog candidates can be selected; upstream failure keeps the saved photograph available',async()=>{
 const xml=await readFile(new URL('fixtures/catalog.xml',import.meta.url),'utf8');let fail=false;
 const dir=await mkdtemp(tmpdir()+'/shiori-search-');const app=createApp({dataDir:pathToFileURL(dir+'/'),fetcher:async()=>fail?new Response('unavailable',{status:503}):new Response(xml)});let browser;
 await new Promise(r=>app.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.address().port}`;
 try{
  browser=await launchBrowser();const context=await browser.newContext();await context.route('https://**/*',route=>route.abort());const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await recordBrowser('search',page,async()=>{
  await page.goto(base);await page.locator('#add').click();await page.locator('#optionalSearch').click();await page.locator('#externalQuery').fill('吾輩は猫である');await page.locator('#searchBooksForm button').click();await page.locator('[data-candidate="0"]').click();assert.equal(await page.locator('[name=title]').inputValue(),'吾輩は猫である');await page.locator('#saveBook').click();await page.getByRole('heading',{name:'本の記録',exact:true}).waitFor();
  await page.locator('#editBook').click();
  const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=30;c.height=60;c.getContext('2d').fillRect(0,0,30,60);return c.toDataURL('image/png').split(',')[1];});await page.locator('#albumPhoto').setInputFiles({name:'cover.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});await page.locator('#photoPreview img').waitFor();fail=true;await page.locator('#optionalSearch').click();await page.locator('#searchResults').getByText('書籍検索に接続できませんでした',{exact:false}).waitFor();await page.locator('#manualSearch').click();assert.match(await page.locator('#photoPreview img').getAttribute('src'),/^data:image\/jpeg/);await page.locator('#saveBook').click();await page.getByRole('heading',{name:'本の記録',exact:true}).waitFor();
  const saved=await(await fetch(base+'/api/library')).json();const cover=saved.books[0].cover;
  fail=true;await page.locator('#lookup').click();await page.locator('#searchResults').getByText('書籍検索に接続できませんでした',{exact:false}).waitFor();await page.locator('#manualSearch').click();assert.ok(await page.locator('#photoPreview img').isVisible());
  assert.equal((await(await fetch(base+'/api/library')).json()).books[0].cover,cover);assert.deepEqual(errors,[]);});
 }finally{if(browser)await browser.close();await new Promise(r=>app.close(r));await rm(dir,{recursive:true,force:true});}
});
