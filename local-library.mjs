import {mkdir,readFile,rename,rmdir,open} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export function localLibrary(dataDir){
 const file=new URL('library.json',dataDir),lock=new URL('library.lock/',dataDir);
 async function read(){try{return JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return {books:[],revision:0};throw e;}}
 return {async snapshot(){const d=await read();return {books:d.books,revision:d.revision};},async save(books,revision,key){
  await mkdir(dataDir,{recursive:true});let acquired=false;const deadline=Date.now()+5000;
  while(!acquired){try{await mkdir(lock);acquired=true;}catch(e){if(e.code!=='EEXIST')throw e;if(Date.now()>deadline)throw Object.assign(Error('別の保存処理を待っています。時間をおいて再試行してください。'),{status:503});await sleep(10);}}
  try{const current=await read(),hash=createHash('sha256').update(JSON.stringify({revision,books})).digest('hex');const requests=current.requests||{};
   if(requests[key])return requests[key].hash===hash?{status:'ok',revision:requests[key].revision,replayed:true}:{status:'idempotency_mismatch'};
   if(current.revision!==revision)return {status:'conflict',revision:current.revision};
   requests[key]={hash,revision:revision+1};const entries=Object.entries(requests).slice(-256);
   const next={books,revision:revision+1,requests:Object.fromEntries(entries)};const tmp=new URL('library-'+randomUUID()+'.tmp',dataDir);const handle=await open(tmp,'wx',0o600);try{await handle.writeFile(JSON.stringify(next));await handle.sync();}finally{await handle.close();}await rename(tmp,file);const directory=await open(dataDir,'r');try{await directory.sync();}finally{await directory.close();}return {status:'ok',revision:next.revision,replayed:false};
  }finally{await rmdir(lock);}
 }};
}
