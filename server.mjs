import http from 'node:http';
import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
const root=new URL('./',import.meta.url);
export function createApp({mode='local',url='',publicKey='',secretKey='',dataDir=new URL('.data/',root),fetcher=fetch}={}) {
 if(!['local','supabase'].includes(mode))throw Error('Invalid STORAGE_MODE');
 if(mode==='supabase'&&(!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url)||!publicKey||!secretKey))throw Error('Supabase URL and keys are required');
 let queue=Promise.resolve();
 const send=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
 async function api(path,body,key=publicKey,token){const r=await fetcher(url+path,{method:body===undefined?'GET':'POST',headers:{apikey:key,...(token?{Authorization:`Bearer ${token}`} : {}),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});const d=await r.json();if(!r.ok){const e=Error(d.code==='40001'?'別の画面で更新されました。再読み込みしてください。':'Supabaseへの接続に失敗しました');e.status=d.code==='40001'?409:r.status===401?401:502;throw e;}return d;}
 async function rpc(owner,action,payload={}){return api('/rest/v1/rpc/shiori_gateway',{p_owner:owner,p_action:action,p_payload:payload},secretKey,secretKey.startsWith('eyJ')?secretKey:undefined);}
 async function snapshot(owner){if(mode==='supabase'){const r=await rpc(owner,'root');return {books:r?.data?.books||[],revision:r?.version||0};}try{return JSON.parse(await readFile(new URL('library.json',dataDir),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;return {books:[],revision:0};}}
 return http.createServer(async(req,res)=>{try{
  const path=new URL(req.url,'http://localhost').pathname;
  if(!['GET','HEAD'].includes(req.method)&&req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`&&req.headers.origin!==`https://${req.headers.host}`)return send(res,403,{error:'Origin rejected'});
  let body={};if(['POST','PUT'].includes(req.method)){let chunks=[],size=0;for await(const c of req){size+=c.length;if(size>8*1024*1024)return send(res,413,{error:'データは8MB以下にしてください'});chunks.push(c);}try{body=JSON.parse(Buffer.concat(chunks).toString()||'{}');}catch{return send(res,400,{error:'Invalid JSON'});}}
  if(path==='/health')return send(res,200,{ok:true,storage:mode});
  if(path==='/api/session'&&req.method==='POST'&&mode==='supabase'){
   if(!body.token){await api('/auth/v1/otp',{email:body.email,create_user:true});return send(res,200,{sent:true});}
   const session=await api('/auth/v1/verify',{email:body.email,token:body.token,type:'email'});
   res.setHeader('Set-Cookie',`shiori_session=${encodeURIComponent(session.access_token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${session.expires_in}${req.socket.encrypted||process.env.COOKIE_SECURE==='true'?'; Secure':''}`);return send(res,200,{ok:true});
  }
  if(path==='/api/logout'&&req.method==='POST'){res.setHeader('Set-Cookie','shiori_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return send(res,200,{ok:true});}
  if(path.startsWith('/api/')){
   let user={id:'local-development',name:'ローカル開発（この環境のみ）'};
   if(mode==='supabase'){const token=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('shiori_session='))?.slice(15);if(!token)return send(res,401,{error:'ログインしてください'});const u=await api('/auth/v1/user',undefined,publicKey,decodeURIComponent(token));user={id:u.id,email:u.email,name:u.email};}
   if(path==='/api/account'&&req.method==='GET')return send(res,200,user);
   if(path==='/api/library'&&req.method==='GET')return send(res,200,await snapshot(user.id));
   if(path==='/api/library'&&req.method==='PUT'){
    const safeId=s=>typeof s==='string'&&/^[a-zA-Z0-9_-]{1,200}$/.test(s);
    if(!Number.isSafeInteger(body.revision)||!Array.isArray(body.books)||body.books.length>10000||!body.books.every(b=>b&&safeId(b.id)&&typeof b.title==='string'&&typeof b.author==='string'&&typeof b.date==='string'&&typeof b.summary==='string'&&Array.isArray(b.tags)&&b.tags.every(t=>typeof t==='string')&&Array.isArray(b.notes)&&b.notes.every(n=>n&&safeId(n.id)&&typeof n.text==='string'&&Array.isArray(n.tags)&&n.tags.every(t=>typeof t==='string')&&(!n.links||n.links.every(safeId))))||new Set(body.books.map(b=>b.id)).size!==body.books.length)return send(res,400,{error:'書籍データの形式が正しくありません'});
    const save=async()=>{const old=await snapshot(user.id);if(old.revision!==body.revision)return send(res,409,{error:'別の画面で更新されました。再読み込みしてください。'});const next={books:body.books,revision:old.revision+1};
     if(mode==='supabase')await rpc(user.id,'apply',{operations:[{kind:'roots',action:old.revision?'replace':'create',version:old.revision,data:{books:body.books}}]});
     else{await mkdir(dataDir,{recursive:true});const tmp=new URL(`library-${randomUUID()}.tmp`,dataDir);await writeFile(tmp,JSON.stringify(next),{mode:0o600});await rename(tmp,new URL('library.json',dataDir));}send(res,200,{revision:next.revision});};
    const work=queue.then(save);queue=work.catch(()=>{});await work;return;
   }
   if(path==='/api/metadata'&&req.method==='POST')return send(res,200,{status:'unmatched',checkedAt:new Date().toISOString(),coverChecked:true});
   return send(res,404,{error:'Not found'});
  }
  if(path==='/'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(await readFile(new URL('public/index.html',root)));return;}
  send(res,404,{error:'Not found'});
 }catch(e){const timeout=e.name==='TimeoutError';send(res,timeout?504:e.status||500,{error:timeout?'通信がタイムアウトしました。保存されたか確認するため再読み込みしてください。':e.status?e.message:'処理に失敗しました'});}});
}
if(process.argv[1]===fileURLToPath(import.meta.url)){const mode=process.env.STORAGE_MODE||'local';createApp({mode,url:process.env.SUPABASE_URL,publicKey:process.env.SUPABASE_PUBLIC_KEY,secretKey:process.env.SUPABASE_SECRET_KEY}).listen(Number(process.env.PORT||3000),mode==='local'?'127.0.0.1':'0.0.0.0',()=>console.log(`Shiori started (${mode})`));}
