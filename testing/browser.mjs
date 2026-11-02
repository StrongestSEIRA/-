import {chromium} from 'playwright-core';
import {existsSync} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
export const executablePath=process.env.CHROMIUM_PATH||(existsSync('/usr/bin/chromium')?'/usr/bin/chromium':chromium.executablePath());
export const launchBrowser=()=>chromium.launch({executablePath,args:['--no-sandbox','--disable-dev-shm-usage']});
export async function recordBrowser(name,page,work){
 const context=page.context(),events=[];const attach=p=>{p.on('console',m=>events.push({type:m.type(),text:m.text()}));p.on('pageerror',e=>events.push({type:'pageerror',text:e.message}));};
 for(const p of context.pages())attach(p);context.on('page',attach);await context.tracing.start({screenshots:true,snapshots:true,sources:true});
 try{const result=await work();await context.tracing.stop();return result;}
 catch(e){const folder=join(process.env.TEST_REPORT_DIR||'test-results','browser',name);await mkdir(folder,{recursive:true});await page.screenshot({path:join(folder,'failure.png'),fullPage:true}).catch(()=>{});await context.tracing.stop({path:join(folder,'trace.zip')}).catch(()=>{});await writeFile(join(folder,'console.json'),JSON.stringify(events,null,2));throw e;}
 finally{context.off('page',attach);}
}
