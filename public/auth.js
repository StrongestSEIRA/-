// Supabase sends access tokens in the fragment; never put them in request URLs.
async function completeEmailLink({location=window.location,history=window.history,fetcher=fetch}={}) {
 const fragment=new URLSearchParams(location.hash.slice(1));
 const query=new URLSearchParams(location.search);
 const accessToken=fragment.get('access_token');
 const failure=fragment.get('error')||query.get('error');
 const state=query.get('login_state');
 // Remove credentials before any network request or user-visible error.
 if(location.hash||location.search)history.replaceState(null,'',location.pathname);
 if(failure)throw Error('ログインリンクが無効または期限切れです。メールを送り直してください。');
 if(!accessToken)return;
 const response=await fetcher('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accessToken,state})});
 const data=await response.json();
 if(!response.ok)throw Error(data.error||'ログインできませんでした。メールを送り直してください。');
}
if(typeof module!=='undefined')module.exports={completeEmailLink};
