import http from 'node:http';
import {createRegistration} from './registration.mjs';
import {searchBooks} from './metadata.mjs';
import {createCoverStore,COVER_LIMIT} from './covers.mjs';
import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
const root=new URL('./',import.meta.url);
export function createApp({mode='local',url='',publicKey='',secretKey='',dataDir=new URL('.data/',root),appUrl=process.env.RENDER_EXTERNAL_URL||'http://127.0.0.1:3000',fetcher=fetch}={}) {
 if(!['local','supabase'].includes(mode))throw Error('Invalid STORAGE_MODE');
 if(mode==='supabase'&&(!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url)||!publicKey||!secretKey))throw Error('Supabase URL and keys are required');
 let queue=Promise.resolve();
 const refreshes=new Map();
 const covers=createCoverStore({mode,url,secretKey,dataDir,fetcher});
 const send=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
 async function api(path,body,key=publicKey,token,method){
  const r=await fetcher(url+path,{method:method||(body===undefined?'GET':'POST'),headers:{apikey:key,...(token?{Authorization:`Bearer ${token}`} : {}),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});
  const d=r.status===204?{}:await r.json();
  if(!r.ok){
   const code=typeof d.error_code==='string'?d.error_code:typeof d.code==='string'?d.code:undefined;
   let status=502,message='Supabaseへの接続に失敗しました';
   if(code==='40001'){status=409;message='別の画面で更新されました。再読み込みしてください。';}
   else if(r.status===429){
    status=429;
    message='認証サービスがリクエストを制限しています。解除時刻は確認できません。';
    let rateCode='auth_rate_limited';
    const retryHeader=r.headers.get('retry-after');
    let retryAfter=retryHeader&&/^\d+$/.test(retryHeader)?Number(retryHeader):retryHeader?Math.ceil((Date.parse(retryHeader)-Date.now())/1000):undefined;
    const frequency=typeof d.msg==='string'?d.msg:typeof d.message==='string'?d.message:'';
    const seconds=frequency.match(/after\s+(\d+)\s+seconds?/i);
    if(code==='over_email_send_rate_limit'){
     if(seconds){rateCode='email_send_cooldown';message='このメールアドレスへの再送間隔が短すぎます。';if(!Number.isFinite(retryAfter))retryAfter=Number(seconds[1]);}
     else if(/^email rate limit exceeded[.!]?$/i.test(frequency.trim())){rateCode='email_delivery_quota';message='メール配信サービス全体の送信枠に達しました。標準の配信枠は非常に少なく、2回の送信でも上限に達する場合があります。';}
     else{rateCode='email_rate_limited';message='メール配信サービスが送信を制限しています。送信枠と再送間隔のどちらによる制限かは確認できません。';}
    }
    const e=Error(message);e.status=status;e.code=rateCode;
    if(Number.isFinite(retryAfter)&&retryAfter>0&&retryAfter<=86400)e.retryAfterSeconds=Math.ceil(retryAfter);
    throw e;
   }
   else if(code==='invalid_credentials'){status=401;message='メールアドレスまたはパスワードが違います。';}
   else if(code==='email_not_confirmed'){status=403;message='メールアドレスの確認が必要です。確認メールのリンクを開いてからログインしてください。';}
   else if(code==='email_address_not_authorized'){status=400;message='この宛先には標準メール配信から送れません。管理者によるメール配信設定が必要です。';}
   else if(code==='weak_password'){status=400;message='より長く、推測されにくいパスワードを指定してください。';}
   else if(code==='otp_expired'||path.startsWith('/auth/v1/verify')&&[400,401,403,422].includes(r.status)){status=400;message='コードが違うか期限切れです。最後に届いたメールの数字を入力してください。';}
   else if(path.includes('grant_type=refresh_token')&&[400,401,403].includes(r.status)){status=401;message='ログインの有効期限が切れました。再度ログインしてください。';}
   else if(r.status===401){status=401;message='ログインの有効期限が切れました。再度ログインしてください。';}
   const e=Error(message);e.status=status;e.authCode=code;throw e;
  }
  return d;
 }

 const register=createRegistration({api,secretKey});
 async function rpc(owner,action,payload={}){return api('/rest/v1/rpc/shiori_gateway',{p_owner:owner,p_action:action,p_payload:payload},secretKey,secretKey.startsWith('eyJ')?secretKey:undefined);}
 async function snapshot(owner){if(mode==='supabase'){const r=await rpc(owner,'root');return {books:r?.data?.books||[],revision:r?.version||0};}try{return JSON.parse(await readFile(new URL('library.json',dataDir),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;return {books:[],revision:0};}}
 return http.createServer(async(req,res)=>{try{
  const path=new URL(req.url,'http://localhost').pathname;
  const secure=req.socket.encrypted||process.env.COOKIE_SECURE==='true'||appUrl.startsWith('https://')?'; Secure':'';
  const cookie=(name,value,maxAge,path='/')=>`${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=${path}; Max-Age=${maxAge}${secure}`;
  const readCookie=name=>{try{return decodeURIComponent(req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith(name+'='))?.slice(name.length+1)||'');}catch{return '';}};
  function setSession(session){
   if(typeof session.access_token!=='string'||!session.access_token)throw Object.assign(Error('ログイン情報を取得できませんでした。'),{status:502});
   const maxAge=Number.isFinite(session.expires_in)?Math.max(1,Math.min(session.expires_in,3600)):3600;
   res.setHeader('Set-Cookie',[cookie('shiori_session',session.access_token,maxAge),cookie('shiori_refresh',session.refresh_token||'',session.refresh_token?2592000:0,'/api/'),cookie('shiori_login','',0)]);
  }
  const validEmail=email=>typeof email==='string'&&email.length<=320&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const validNewPassword=password=>typeof password==='string'&&password.length>=12&&Buffer.byteLength(password,'utf8')<=72;
  async function currentUser(){
   const token=readCookie('shiori_session'),refreshToken=readCookie('shiori_refresh');
   if(token){try{return await api('/auth/v1/user',undefined,publicKey,token);}catch(e){if(e.status!==401||!refreshToken)throw e;}}
   if(!refreshToken)throw Object.assign(Error('ログインしてください'),{status:401});
   const fingerprint=createHash('sha256').update(refreshToken).digest('hex');
   if(!refreshes.has(fingerprint)){
    const pending=api('/auth/v1/token?grant_type=refresh_token',{refresh_token:refreshToken});refreshes.set(fingerprint,pending);
    pending.then(()=>{setTimeout(()=>refreshes.delete(fingerprint),2000).unref();},()=>refreshes.delete(fingerprint));
   }
   let session;try{session=await refreshes.get(fingerprint);}catch(e){if(e.status===401)res.setHeader('Set-Cookie',[cookie('shiori_session','',0),cookie('shiori_refresh','',0,'/api/')]);throw e;}
   const user=session.user?.id?session.user:await api('/auth/v1/user',undefined,publicKey,session.access_token);
   setSession(session);return user;
  }

  if(!['GET','HEAD'].includes(req.method)&&req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`&&req.headers.origin!==`https://${req.headers.host}`)return send(res,403,{error:'Origin rejected'});
  let body={};if(['POST','PUT'].includes(req.method)&&path!=='/api/covers'){let chunks=[],size=0;for await(const c of req){size+=c.length;if(size>8*1024*1024)return send(res,413,{error:'データは8MB以下にしてください'});chunks.push(c);}try{body=JSON.parse(Buffer.concat(chunks).toString()||'{}');}catch{return send(res,400,{error:'Invalid JSON'});}}
  if(path==='/health')return send(res,200,{ok:true,storage:mode});
  if(path==='/api/session'&&req.method==='POST'&&mode==='supabase'){
   if(body.action==='verify'&&(typeof body.token!=='string'||!/^\d{6,10}$/.test(body.token.trim())))return send(res,400,{error:'メールに記載された数字のコードを入力してください。'});
   let session;
   if(['login','signup','recover'].includes(body.action)){
    if(!validEmail(body.email))return send(res,400,{error:'メールアドレスを入力してください。'});
    if(body.action==='recover'){
     await api('/auth/v1/recover?redirect_to='+encodeURIComponent(new URL('/',appUrl).href),{email:body.email});
     return send(res,200,{recoveryRequested:true});
    }
    if(typeof body.password!=='string'||!body.password||Buffer.byteLength(body.password,'utf8')>1024)return send(res,400,{error:'パスワードを入力してください。'});
    if(body.action==='signup'){
     if(!validNewPassword(body.password))return send(res,400,{error:'パスワードは12文字以上、UTF-8で72バイト以内にしてください。'});
     const forwarded=typeof req.headers['x-forwarded-for']==='string'?req.headers['x-forwarded-for'].split(',').at(-1).trim():'';
     session=await register(body.email,body.password,forwarded||req.socket.remoteAddress||'unknown');
    }else session=await api('/auth/v1/token?grant_type=password',{email:body.email,password:body.password});
   }else if(body.accessToken){
    if(typeof body.accessToken!=='string')return send(res,400,{error:'ログインリンクが無効です。'});
    const fingerprint=createHash('sha256').update(body.accessToken).digest('hex');
    if(body.action==='preview'){
     const user=await api('/auth/v1/user',undefined,publicKey,body.accessToken);
     if(!user.id||!user.email)return send(res,401,{error:'ログインを確認できませんでした。'});
     const nonce=randomUUID();
     res.setHeader('Set-Cookie',cookie('shiori_login',nonce+'.'+fingerprint,600));
     return send(res,200,{email:user.email,state:nonce});
    }
    const expected=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('shiori_login='))?.slice(13);
    if(body.confirm!==true||!expected||typeof body.state!=='string'||expected!==body.state+'.'+fingerprint)return send(res,400,{error:'ログイン確認を完了できませんでした。Cookieを許可したブラウザでメールのリンクを開き直してください。'});
    const user=await api('/auth/v1/user',undefined,publicKey,body.accessToken);
    if(!user.id)return send(res,401,{error:'ログインを確認できませんでした。'});
    session={access_token:body.accessToken,expires_in:3600};
   }else if(!body.token){
    return send(res,410,{error:'メールアドレスとパスワードでのログインに変更されました。ページを再読み込みしてください。'});
   }else{
    session=await api('/auth/v1/verify',{email:body.email,token:typeof body.token==='string'?body.token.trim():body.token,type:'email'});
   }
   if(typeof session.access_token!=='string')return send(res,502,{error:'ログイン情報を取得できませんでした。'});
   setSession(session);return send(res,200,{ok:true});
  }
  if(path==='/api/logout'&&req.method==='POST'){
   const clear=()=>res.setHeader('Set-Cookie',[cookie('shiori_session','',0),cookie('shiori_refresh','',0,'/api/'),cookie('shiori_login','',0)]);
   try{if(mode==='supabase'&&(readCookie('shiori_session')||readCookie('shiori_refresh'))){await currentUser();const sessionCookie=res.getHeader('Set-Cookie')?.find(s=>s.startsWith('shiori_session='));const token=sessionCookie?decodeURIComponent(sessionCookie.split(';')[0].slice(15)):readCookie('shiori_session');await api('/auth/v1/logout?scope=local',{},publicKey,token);}}
   catch(e){if(e.status!==401){clear();throw e;}}
   if(readCookie('shiori_refresh'))refreshes.delete(createHash('sha256').update(readCookie('shiori_refresh')).digest('hex'));
   clear();return send(res,200,{ok:true});
  }
  if(path.startsWith('/api/')){
   let user={id:'local-development',name:'ローカル開発（この環境のみ）'};
   if(mode==='supabase'){const u=await currentUser();user={id:u.id,email:u.email,name:u.email};}
   if(path==='/api/password'&&req.method==='POST'&&mode==='supabase'){
    if(!validNewPassword(body.password))return send(res,400,{error:'パスワードは12文字以上、UTF-8で72バイト以内にしてください。'});
    const renewed=res.getHeader('Set-Cookie')?.find(s=>s.startsWith('shiori_session='));const token=renewed?decodeURIComponent(renewed.split(';')[0].slice(15)):readCookie('shiori_session');
    await api('/auth/v1/user',{password:body.password},publicKey,token,'PUT');return send(res,200,{ok:true});
   }
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
   if(path==='/api/covers'&&req.method==='POST'){
    const chunks=[];let size=0;for await(const c of req){size+=c.length;if(size>COVER_LIMIT)return send(res,413,{error:'写真は300KB以下で保存してください。'});chunks.push(c);}
    return send(res,201,await covers.put(user.id,Buffer.concat(chunks),req.headers['content-type']));
   }
   if(path.startsWith('/api/covers/')&&req.method==='GET'){
    const bytes=await covers.get(user.id,path.slice('/api/covers/'.length));res.writeHead(200,{'Content-Type':'image/jpeg','Content-Length':bytes.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(bytes);return;
   }
   if(path==='/api/metadata'&&req.method==='POST')return send(res,200,await searchBooks(body,fetcher));
   return send(res,404,{error:'Not found'});
  }
  if(path==='/auth.js'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-store'});res.end(await readFile(new URL('public/auth.js',root)));return;}
  if(path==='/'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(await readFile(new URL('public/index.html',root)));return;}
  send(res,404,{error:'Not found'});
 }catch(e){const timeout=e.name==='TimeoutError';if(e.retryAfterSeconds)res.setHeader('Retry-After',String(e.retryAfterSeconds));send(res,timeout?504:e.status||500,{error:timeout?'通信がタイムアウトしました。保存されたか確認するため再読み込みしてください。':e.status?e.message:'処理に失敗しました',...(e.code?{code:e.code}:{}),...(e.retryAfterSeconds?{retryAfterSeconds:e.retryAfterSeconds}:{})});}});
}
if(process.argv[1]===fileURLToPath(import.meta.url)){const mode=process.env.STORAGE_MODE||'local';createApp({mode,url:process.env.SUPABASE_URL,publicKey:process.env.SUPABASE_PUBLIC_KEY,secretKey:process.env.SUPABASE_SECRET_KEY}).listen(Number(process.env.PORT||3000),mode==='local'?'127.0.0.1':'0.0.0.0',()=>console.log(`Shiori started (${mode})`));}
