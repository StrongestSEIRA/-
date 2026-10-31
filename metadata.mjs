import {XMLParser,XMLValidator} from 'fast-xml-parser';
const parser=new XMLParser({ignoreAttributes:false,removeNSPrefix:true,parseTagValue:false});
const list=value=>value==null?[]:Array.isArray(value)?value:[value];
const text=value=>typeof value==='string'?value:typeof value?.['#text']==='string'?value['#text']:'';
const normalized=s=>s.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu,'');
export function canonicalISBN(value){
 const s=value.replace(/[-\s]/g,'').toUpperCase();
 if(/^\d{9}[\dX]$/.test(s)&&[...s].reduce((sum,c,i)=>sum+(c==='X'?10:Number(c))*(10-i),0)%11===0){const first='978'+s.slice(0,9);const check=(10-[...first].reduce((sum,c,i)=>sum+Number(c)*(i%2?3:1),0)%10)%10;return first+check;}
 if(/^97[89]\d{10}$/.test(s)&&[...s].reduce((sum,c,i)=>sum+Number(c)*(i%2?3:1),0)%10===0)return s;
 return '';
}
export async function searchBooks(input,fetcher=fetch){
 const title=typeof input.title==='string'?input.title.trim():'';
 const author=typeof input.author==='string'?input.author.trim():'';
 const rawISBN=typeof input.isbn==='string'?input.isbn.trim():'';
 if([title,author,rawISBN].some(s=>s.length>300)||(!title&&!rawISBN))throw Object.assign(Error('タイトルまたはISBNを入力してください。'),{status:400});
 const isbn=rawISBN?canonicalISBN(rawISBN):'';
 if(rawISBN&&!isbn)throw Object.assign(Error('ISBNの桁数と数字を確認してください。'),{status:400});
 const url=new URL('https://ndlsearch.ndl.go.jp/api/opensearch');
 url.searchParams.set('cnt','20');url.searchParams.set('mediatype','1');
 if(isbn)url.searchParams.set('isbn',isbn);else url.searchParams.set('title',title);
 if(author)url.searchParams.set('creator',author);
 let response,xml;
 try{response=await fetcher(url,{headers:{Accept:'application/rss+xml, application/xml, text/xml'},signal:AbortSignal.timeout(12000)});if(!response.ok)throw Error();xml=await response.text();if(xml.length>2_000_000||XMLValidator.validate(xml)!==true)throw Error();}catch{throw Object.assign(Error('書籍検索に接続できませんでした。写真や手入力でそのまま登録できます。'),{status:502});}
 const channel=parser.parse(xml)?.rss?.channel;
 if(!channel||typeof channel!=='object')throw Object.assign(Error('書籍検索の応答を読み込めませんでした。写真や手入力で登録できます。'),{status:502});
 const seen=new Set();
 const candidates=list(channel.item).map(item=>{
  const title=text(item.title).trim();
  const identifiers=list(item.identifier).map(text);
  const isbn=identifiers.map(s=>canonicalISBN(s.replace(/^urn:isbn:/i,''))).find(Boolean)||'';
  let sourceUrl=text(item.link);try{const parsed=new URL(sourceUrl);if(parsed.protocol!=='https:'||parsed.hostname!=='ndlsearch.ndl.go.jp')sourceUrl='';}catch{sourceUrl='';}
  return {status:'matched',title,author:list(item.creator||item.author).map(text).filter(Boolean).join(' / '),publisher:list(item.publisher).map(text).filter(Boolean).join(' / '),label:'',isbn,summary:text(item.abstract),cover:'',sourceName:'国立国会図書館サーチ',sourceUrl,checkedAt:new Date().toISOString(),coverChecked:true};
 }).filter(item=>{if(!item.title)return false;const key=JSON.stringify([item.title,item.author,item.publisher,item.isbn]);if(seen.has(key))return false;seen.add(key);return true;});
 const exact=isbn?candidates.filter(c=>c.isbn===isbn):candidates.filter(c=>normalized(c.title)===normalized(title)&&(!author||normalized(c.author).includes(normalized(author))));
 const common={candidates,checkedAt:new Date().toISOString(),coverChecked:true};
 if(exact.length===1)return {...exact[0],...common};
 return {...common,status:candidates.length?'ambiguous':'unmatched'};
}
