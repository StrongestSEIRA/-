import {randomUUID} from 'node:crypto';
export const recordId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(value);
export function validateOperations(operations){
 if(!Array.isArray(operations)||operations.length<1||operations.length>20000)return false;
 const seen=new Set();return operations.every(o=>{
  if(!o||!['book','note'].includes(o.kind)||!['put','delete'].includes(o.action)||!recordId(o.id)||!Number.isSafeInteger(o.version)||o.version<0||o.kind==='note'&&!recordId(o.bookId))return false;
  const key=JSON.stringify([o.kind,o.bookId||'',o.id]);if(seen.has(key))return false;seen.add(key);
  if(o.action==='delete')return o.version>0&&(o.kind!=='book'||Number.isSafeInteger(o.notesVersion)&&o.notesVersion>=0);
  const d=o.data;return !!d&&typeof d==='object'&&!Array.isArray(d)&&d.id===o.id&&Array.isArray(d.tags)&&d.tags.every(t=>typeof t==='string')&&(o.kind==='book'?['title','author','date','summary'].every(k=>typeof d[k]==='string')&&!Object.hasOwn(d,'notes'):typeof d.text==='string'&&(!Object.hasOwn(d,'links')||Array.isArray(d.links)&&d.links.every(recordId)));
 });
}
export function recordFailure(result){
 if(result.status==='ok')return;
 const codes={conflict:[409,'revision_conflict','別の端末で更新されました。入力を保管してから、最新の本棚を読み込んでください。'],idempotency_mismatch:[409,'idempotency_mismatch','同じ保存要求のIDに異なる内容が指定されました。'],migration_required:[503,'migration_required','保存先の移行が必要です。管理者にお問い合わせください。'],invalid:[400,'invalid_records','書籍・メモのデータ形式が正しくありません。']};
 const [status,code,message]=codes[result.status]||[502,'record_storage_error','保存先から正しい応答を受け取れませんでした。'];throw Object.assign(Error(message),{status,code});
}
export async function handleRecords({req,path,body,user,rpc,send,res}){
 const parsed=new URL(req.url,'http://localhost'),q=parsed.searchParams;
 if(req.method==='GET'){
  let action,payload={};const match=path.match(/^\/api\/books\/([A-Za-z0-9_-]{1,200})(?:\/notes(?:\/([A-Za-z0-9_-]{1,200}))?)?$/);
  if(path==='/api/books')action='books';else if(path==='/api/notes')action='notes';else if(path==='/api/library/usage')action='usage';else if(match){action=path.includes('/notes')?'notes':'books';payload=action==='books'?{id:match[1]}:{bookId:match[1],...(match[2]?{id:match[2]}:{})};}else return false;
  for(const key of ['after','afterBook','tag','q'])if(q.has(key)){if(q.get(key).length>500)throw Object.assign(Error('検索条件が長すぎます。'),{status:400});payload[key]=q.get(key);}
  for(const key of ['revision','limit'])if(q.has(key)){const n=Number(q.get(key));if(!Number.isSafeInteger(n)||n<0||key==='limit'&&(n<1||n>200))throw Object.assign(Error('ページ指定が正しくありません。'),{status:400});payload[key]=n;}
  const result=await rpc(user.id,action,payload);recordFailure(result);
  if(match&&!(action==='notes'&&!match[2])&&!result.items.length){send(res,404,{error:'記録が見つかりません。'});return true;}
  send(res,200,result);return true;
 }
 let operations;
 if(path==='/api/changes'&&req.method==='POST')operations=body.operations;
 else{
  const match=path.match(/^\/api\/books\/([A-Za-z0-9_-]{1,200})(?:\/notes\/([A-Za-z0-9_-]{1,200}))?$/);
  const createBook=path==='/api/books'&&req.method==='POST',createNote=path.match(/^\/api\/books\/([A-Za-z0-9_-]{1,200})\/notes$/);
  if(!createBook&&!(createNote&&req.method==='POST')&&!(match&&['PUT','DELETE'].includes(req.method)))return false;
  const kind=createNote||match?.[2]?'note':'book',id=createBook||createNote?body.data?.id:match[kind==='book'?1:2];
  operations=[{kind,id,...(kind==='note'?{bookId:createNote?.[1]||match[1]}:{}),action:req.method==='DELETE'?'delete':'put',version:req.method==='POST'?0:body.version,notesVersion:body.notesVersion,data:body.data}];
  if(req.method==='PUT'&&body.version===0)throw Object.assign(Error('更新対象の版を指定してください。'),{status:400});
 }
 if(!validateOperations(operations))throw Object.assign(Error('書籍・メモのデータ形式が正しくありません。'),{status:400});
 const requestId=req.headers['idempotency-key']||randomUUID();if(typeof requestId!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(requestId))throw Object.assign(Error('保存要求のIDが正しくありません。'),{status:400});
 const result=await rpc(user.id,'apply',{operations,requestId});recordFailure(result);send(res,200,result);return true;
}
