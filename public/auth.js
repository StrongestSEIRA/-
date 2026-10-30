// Tokens stay in memory; clear the fragment before making any network requests.
async function completeEmailLink({location=window.location,history=window.history,fetcher=fetch,confirmAccount=async email=>window.confirm(email+' でログインしますか？')}={}) {
 const fragment=new URLSearchParams(location.hash.slice(1));
 const query=new URLSearchParams(location.search);
 const accessToken=fragment.get('access_token');
 const failure=fragment.get('error')||query.get('error');
 if(location.hash||location.search)history.replaceState(null,'',location.pathname);
 if(failure)throw Error('ログインリンクが無効または期限切れです。メールを送り直してください。');
 if(!accessToken){if(query.has('login_state'))throw Error('リンクにログイン情報がありません。新しいメールのリンクを開いてください。');return false;}
 async function request(body){const r=await fetcher('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Error(d.error||'ログインできませんでした。メールを送り直してください。');return d;}
 // Establish the confirmation cookie in the browser opening the email, rather
 // than requiring cookies from the browser/device that requested the email.
 const preview=await request({action:'preview',accessToken});
 if(!await confirmAccount(preview.email))return false;
 await request({accessToken,state:preview.state,confirm:true});
 return fragment.get('type')==='recovery'?{recovery:true}:true;
}
if(typeof module!=='undefined')module.exports={completeEmailLink};
