import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
const bucket='shiori-covers';
export const COVER_LIMIT=300*1024;
export function createCoverStore({mode,url,secretKey,dataDir,fetcher=fetch}){
 let ready;
 const error=()=>Object.assign(Error('写真を保存できませんでした。時間をおいて再度お試しください。'),{status:502});
 const headers=()=>({apikey:secretKey,...(secretKey.startsWith('eyJ')?{Authorization:'Bearer '+secretKey}:{})});
 const remote=(path,init={})=>fetcher(url+'/storage/v1/'+path,{...init,headers:{...headers(),...init.headers},signal:AbortSignal.timeout(15000)}).catch(()=>{throw error();});
 async function ensureBucket(){
  if(!ready){ready=(async()=>{let r=await remote('bucket/'+bucket);
   if(r.status===404){const made=await remote('bucket',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:bucket,name:bucket,public:false,file_size_limit:COVER_LIMIT,allowed_mime_types:['image/jpeg']})});if(!made.ok&&![400,409].includes(made.status))throw error();r=await remote('bucket/'+bucket);}
   if(!r.ok||(await r.json()).public!==false)throw error();
  })().catch(e=>{ready=undefined;throw e;});}return ready;
 }
 function objectPath(owner,id){if(!/^[\w-]{1,200}$/.test(owner)||!/^[-a-f0-9]{36}$/.test(id))throw Object.assign(Error('写真が見つかりません。'),{status:404});return owner+'/'+id+'.jpg';}
 return {
  async put(owner,bytes,type){
   if(type!=='image/jpeg'||bytes.length<4||bytes.length>COVER_LIMIT||bytes[0]!==255||bytes[1]!==216||bytes[2]!==255)throw Object.assign(Error('写真をJPEG形式、300KB以下で選び直してください。'),{status:400});
   const id=randomUUID(),path=objectPath(owner,id);
   if(mode==='supabase'){await ensureBucket();const r=await remote('object/'+bucket+'/'+path,{method:'POST',headers:{'Content-Type':'image/jpeg','x-upsert':'false'},body:bytes});if(!r.ok)throw error();}
   else{const directory=new URL('covers/'+owner+'/',dataDir);await mkdir(directory,{recursive:true});await writeFile(new URL(id+'.jpg',directory),bytes,{mode:0o600});}
   return {url:'/api/covers/'+id};
  },
  async get(owner,id){const path=objectPath(owner,id);
   if(mode==='supabase'){const r=await remote('object/authenticated/'+bucket+'/'+path);if(r.status===404||r.status===400)throw Object.assign(Error('写真が見つかりません。'),{status:404});if(!r.ok)throw error();return Buffer.from(await r.arrayBuffer());}
   try{return await readFile(new URL('covers/'+path,dataDir));}catch(e){if(e.code==='ENOENT')throw Object.assign(Error('写真が見つかりません。'),{status:404});throw e;}
  }
 };
}
