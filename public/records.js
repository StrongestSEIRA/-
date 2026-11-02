/* UI adapter: keep versions outside portable book/note data. No credentials or AI calls. */
globalThis.ShioriRecords=function(fetcher){
 let baseline=[],bookVersions=new Map(),noteVersions=new Map();
 const noteKey=(book,id)=>JSON.stringify([book,id]);
 const bookData=({notes,...data})=>data;
 const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
 async function request(path){const response=await fetcher(path),data=await response.json();if(!response.ok)throw Object.assign(Error(data.error),{status:response.status});return data;}
 async function load(){
  for(let attempt=0;attempt<3;attempt++)try{
   const records=[],notes=[];let revision;
   for(const [path,target]of [['books',records],['notes',notes]]){
    let after='',afterBook='';for(;;){const q=new URLSearchParams({limit:'200',after,...(afterBook?{afterBook}:{}),...(revision===undefined?{}:{revision:String(revision)})});const page=await request('/api/'+path+'?'+q);revision=page.revision;target.push(...page.items);if(!page.hasMore)break;const last=page.items.at(-1);after=last.id;afterBook=last.book_id||'';}
   }
   // A final read checks writes that occurred between the last two pages.
   await request('/api/library/usage?revision='+revision);
   bookVersions=new Map(records.map(b=>[b.id,{version:b.version,notesVersion:b.notes_version}]));noteVersions=new Map(notes.map(n=>[noteKey(n.book_id,n.id),n.version]));
   const byBook=new Map();for(const n of notes){if(!byBook.has(n.book_id))byBook.set(n.book_id,[]);byBook.get(n.book_id).push(n);}
   baseline=records.sort((a,b)=>a.position-b.position||a.id.localeCompare(b.id)).map(b=>({...b.data,notes:(byBook.get(b.id)||[]).sort((a,b)=>a.position-b.position||a.id.localeCompare(b.id)).map(n=>n.data)}));return {books:structuredClone(baseline),revision};
  }catch(e){if(e.status!==409||attempt===2)throw e;}
 }
 function prepare(books){
  const oldBooks=new Map(baseline.map(b=>[b.id,b])),newIds=new Set(books.map(b=>b.id)),operations=[];
  // Reverse creation order because new records are prepended in storage.
  for(const b of [...books].reverse()){
   const old=oldBooks.get(b.id),version=bookVersions.get(b.id);
   if(!old||!equal(bookData(b),bookData(old)))operations.push({kind:'book',id:b.id,action:'put',version:version?.version||0,data:bookData(b)});
   const oldNotes=new Map((old?.notes||[]).map(n=>[n.id,n])),newNotes=new Set(b.notes.map(n=>n.id));
   for(const n of [...b.notes].reverse())if(!oldNotes.has(n.id)||!equal(n,oldNotes.get(n.id)))operations.push({kind:'note',bookId:b.id,id:n.id,action:'put',version:noteVersions.get(noteKey(b.id,n.id))||0,data:n});
   for(const n of old?.notes||[])if(!newNotes.has(n.id))operations.push({kind:'note',bookId:b.id,id:n.id,action:'delete',version:noteVersions.get(noteKey(b.id,n.id))});
  }
  for(const b of baseline)if(!newIds.has(b.id))operations.push({kind:'book',id:b.id,action:'delete',...bookVersions.get(b.id)});
  return operations;
 }
 function accept(books,result){
  for(const c of result.changes||[]){if(c.kind==='book'){if(c.action==='delete'){bookVersions.delete(c.id);for(const n of baseline.find(b=>b.id===c.id)?.notes||[])noteVersions.delete(noteKey(c.id,n.id));}else bookVersions.set(c.id,{version:c.version,notesVersion:c.notesVersion});}
   else{const key=noteKey(c.bookId,c.id);if(c.action==='delete')noteVersions.delete(key);else noteVersions.set(key,c.version);const b=bookVersions.get(c.bookId);if(b)b.notesVersion=c.notesVersion;}}
  baseline=structuredClone(books);
 }
 return {load,prepare,accept};
};
