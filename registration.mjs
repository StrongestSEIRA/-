import {createHash} from 'node:crypto';
// Legacy compatibility does not prove mailbox ownership; verified rollout needs provider confirmation enabled.
export function createRegistration({api,secretKey,policy='legacy'}){
 if(!['legacy','verified','closed'].includes(policy))throw Error('Invalid registration policy');
 const attempts=new Map();let settingsCache;
 const admin=(path,body,method)=>api('/auth/v1/admin/'+path,body,secretKey,secretKey.startsWith('eyJ')?secretKey:undefined,method);
 function limit(email,ip){
  const now=Date.now();for(const [key,value]of attempts)if(value.until<=now)attempts.delete(key);
  for(const [kind,value,max,window]of [['email',email.toLowerCase(),5,15*60000],['ip',ip,15,10*60000]]){
   const key=kind+createHash('sha256').update(value).digest('hex');const entry=attempts.get(key)||{count:0,until:now+window};
   if(entry.count>=max)throw Object.assign(Error('登録の試行が続いています。時間をおいてから再試行してください。'),{status:429,retryAfterSeconds:Math.ceil((entry.until-now)/1000)});
   entry.count++;attempts.set(key,entry);
  }
  if(attempts.size>10000)attempts.delete(attempts.keys().next().value);
 }
 async function settings(fresh=false){if(fresh||!settingsCache||settingsCache.until<Date.now())settingsCache={data:await api('/auth/v1/settings'),until:Date.now()+30000};return settingsCache.data;}
 return async function register(email,password,ip){
  if(policy==='closed')throw Object.assign(Error('現在、新規登録を受け付けていません。'),{status:403});
  limit(email,ip);
  const config=await settings(policy==='verified');if(config.disable_signup===true)throw Object.assign(Error('現在、新規登録を受け付けていません。'),{status:403});
  if(config.external?.email===false)throw Object.assign(Error('メールアドレスでの登録は現在利用できません。'),{status:403});
  if(policy==='verified'){
   if(config.mailer_autoconfirm!==false)throw Object.assign(Error('メール所有確認の設定を確認できないため、新規登録を停止しています。管理者にお問い合わせください。'),{status:503,code:'email_confirmation_configuration'});
   const signup=await api('/auth/v1/signup',{email,password});
   if(signup.access_token)throw Object.assign(Error('認証サービスの確認設定に不整合があります。管理者にお問い合わせください。'),{status:503,code:'email_confirmation_configuration'});
   return signup;
  }
  try{await admin('users',{email,password,email_confirm:true,role:'authenticated'});}
  catch(e){if(!['email_exists','user_already_exists'].includes(e.authCode))throw e;}
  const login=()=>api('/auth/v1/token?grant_type=password',{email,password});
  try{return await login();}
  catch(e){
   if(e.authCode!=='email_not_confirmed')throw e;
   // GoTrue verifies the submitted password BEFORE returning email_not_confirmed.
   // Only that proof permits completing an existing pending registration.
   const data=await admin('users?filter='+encodeURIComponent(email)+'&page=1&per_page=100');
   const matches=(data.users||[]).filter(u=>typeof u.email==='string'&&u.email.toLowerCase()===email.toLowerCase()&&!u.is_sso_user);
   if(matches.length!==1||!matches[0].id)throw Object.assign(Error('登録情報を確認できませんでした。管理者にお問い合わせください。'),{status:409});
   await admin('users/'+encodeURIComponent(matches[0].id),{email_confirm:true},'PUT');
   return login();
  }
 };
}
