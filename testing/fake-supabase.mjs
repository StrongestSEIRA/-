import {randomUUID} from 'node:crypto';
export function fakeSupabase(xml=''){
 const users=new Map(),tokens=new Map(),refreshes=new Map(),roots=new Map(),objects=new Map(),calls=[];
 const response=(value,status=200)=>Response.json(value,{status});
 function session(user){const access=randomUUID(),refresh=randomUUID();tokens.set(access,user);refreshes.set(refresh,{user,access});return {access_token:access,refresh_token:refresh,expires_in:3600,user:{id:user.id,email:user.email}};}
 return {calls,async fetcher(input,init={}){
  const url=new URL(input);calls.push({host:url.hostname,path:url.pathname,method:init.method||'GET'});
  const body=typeof init.body==='string'?JSON.parse(init.body):{};const auth=init.headers?.Authorization?.replace(/^Bearer /,'');
  if(url.hostname==='ndlsearch.ndl.go.jp')return new Response(xml);
  if(url.hostname!=='example.supabase.co')throw Error('Unexpected external host in isolated test');
  const path=url.pathname;
  if(path==='/auth/v1/settings')return response({disable_signup:false,external:{email:true}});
  if(path==='/auth/v1/admin/users'&&init.method==='POST'){if(users.has(body.email))return response({error_code:'email_exists'},422);const user={id:randomUUID(),email:body.email,password:body.password};users.set(user.email,user);return response({id:user.id});}
  if(path==='/auth/v1/token'){
   if(url.searchParams.get('grant_type')==='refresh_token'){const old=refreshes.get(body.refresh_token);if(!old)return response({error_code:'refresh_token_not_found'},400);return response(session(old.user));}
   const user=users.get(body.email);return user&&user.password===body.password?response(session(user)):response({error_code:'invalid_credentials'},400);
  }
  if(path==='/auth/v1/user'){const user=tokens.get(auth);if(!user)return response({error_code:'bad_jwt'},401);if(init.method==='PUT')user.password=body.password;return response({id:user.id,email:user.email});}
  if(path==='/auth/v1/logout'){tokens.delete(auth);for(const [key,s]of refreshes)if(s.access===auth)refreshes.delete(key);return new Response(null,{status:204});}
  if(path==='/rest/v1/rpc/shiori_gateway'){
   const current=roots.get(body.p_owner);if(body.p_action==='root')return response(current||null);
   const op=body.p_payload.operations[0];if(op.action==='create'&&current||op.action!=='create'&&current?.version!==op.version)return response({code:'40001'},409);
   roots.set(body.p_owner,{owner:body.p_owner,data:op.data,version:(current?.version||0)+1});return response({applied:true});
  }
  if(path==='/storage/v1/bucket/shiori-covers')return response({public:false});
  if(path.startsWith('/storage/v1/object/shiori-covers/')&&init.method==='POST'){objects.set(path.slice('/storage/v1/object/shiori-covers/'.length),init.body);return response({ok:true});}
  if(path.startsWith('/storage/v1/object/authenticated/shiori-covers/')){const image=objects.get(path.slice('/storage/v1/object/authenticated/shiori-covers/'.length));return image?new Response(image):response({error:'missing'},404);}
  throw Error('Unmocked provider endpoint: '+path);
 }};
}
