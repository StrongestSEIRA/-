import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {launchBrowser,recordBrowser} from '../testing/browser.mjs';
test('a controlled browser failure preserves screenshot, trace and console without masking the original error',async()=>{
 const dir=await mkdtemp(tmpdir()+'/shiori-evidence-'),before=process.env.TEST_REPORT_DIR;let browser;
 try{process.env.TEST_REPORT_DIR=dir;browser=await launchBrowser();const page=await browser.newPage();await page.setContent('<p>synthetic test page</p>');
  await assert.rejects(recordBrowser('selftest',page,async()=>{await page.evaluate(()=>console.log('synthetic diagnostic'));throw Error('controlled test failure');}),/controlled test failure/);
  const folder=join(dir,'browser','selftest');assert.ok((await stat(join(folder,'failure.png'))).size>0);assert.equal((await readFile(join(folder,'trace.zip'))).subarray(0,2).toString(),'PK');assert.ok(JSON.parse(await readFile(join(folder,'console.json'),'utf8')).some(e=>e.text==='synthetic diagnostic'));
 }finally{if(browser)await browser.close();if(before===undefined)delete process.env.TEST_REPORT_DIR;else process.env.TEST_REPORT_DIR=before;await rm(dir,{recursive:true,force:true});}
});
