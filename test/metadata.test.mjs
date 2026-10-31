import {test} from 'node:test';
import assert from 'node:assert/strict';
import {searchBooks,canonicalISBN} from '../metadata.mjs';
import {readFile} from 'node:fs/promises';
const catalogXML=await readFile(new URL('fixtures/catalog.xml',import.meta.url),'utf8');
test('title search queries the real NDL API contract and returns a selectable catalog result',async()=>{
 const result=await searchBooks({title:'吾輩は猫である'},async(url,init)=>{assert.equal(url.origin,'https://ndlsearch.ndl.go.jp');assert.equal(url.pathname,'/api/opensearch');assert.equal(url.searchParams.get('title'),'吾輩は猫である');assert.equal(init.headers.apikey,undefined);return new Response(catalogXML);});
 assert.equal(result.status,'matched');assert.equal(result.title,'吾輩は猫である');assert.equal(result.author,'夏目漱石');assert.equal(result.candidates.length,1);assert.equal(result.sourceName,'国立国会図書館サーチ');
});
test('ISBN checksums, empty catalog results and ambiguous editions are distinguished from upstream failures',async()=>{
 assert.equal(canonicalISBN('4-10-101013-7'),'9784101010137');assert.equal(canonicalISBN('9784101010138'),'');
 const empty=await searchBooks({title:'未収録の本'},async()=>new Response('<rss><channel><title>NDL</title></channel></rss>'));assert.equal(empty.status,'unmatched');assert.deepEqual(empty.candidates,[]);
 const editions=catalogXML.replace('</channel>','<item><title>吾輩は猫である</title><dc:creator>夏目漱石</dc:creator><dc:publisher>別の出版社</dc:publisher></item></channel>');
 const ambiguous=await searchBooks({title:'吾輩は猫である'},async()=>new Response(editions));assert.equal(ambiguous.status,'ambiguous');assert.equal(ambiguous.candidates.length,2);
 for(const response of [new Response('unavailable',{status:503}),new Response('<html>error</html>'),new Response('broken xml')])await assert.rejects(searchBooks({title:'こころ'},async()=>response),e=>e.status===502);
});
