import {test} from 'node:test';import assert from 'node:assert/strict';
import '../public/records.js';import {validateOperations} from '../records-api.mjs';
const base={id:'book',title:'タイトル',tags:['自由タグ'],notes:[{id:'memo',text:'私的なメモ',tags:['メモタグ']}]};
function provider(){let calls=0,failAt=-1;return {get calls(){return calls},set failAt(value){failAt=value},async fetcher(url){calls++;if(calls===failAt)return Response.json({error:'changed'},{status:409});const path=new URL(url,'http://test').pathname;return Response.json({revision:7,hasMore:false,items:path==='/api/books'?[{id:'book',data:(({notes,...d})=>d)(base),version:3,notes_version:6,position:0}]:path==='/api/notes'?[{id:'memo',book_id:'book',data:base.notes[0],version:6,position:0}]:[]});}};}
test('record UI writes only the changed note/book, carries CAS versions, retries the same diff and keeps backup data portable',async()=>{
 const p=provider(),client=ShioriRecords(p.fetcher);const state=await client.load();assert.deepEqual(state.books,[base]);assert.deepEqual(client.prepare(state.books),[]);
 const books=structuredClone(state.books);books[0].notes[0].text='変更';let ops=client.prepare(books);assert.equal(ops.length,1);assert.equal(ops[0].kind,'note');assert.equal(ops[0].version,6);assert.ok(validateOperations(ops));assert.deepEqual(client.prepare(books),ops);
 client.accept(books,{changes:[{kind:'note',id:'memo',bookId:'book',action:'put',version:8,notesVersion:8}]});assert.deepEqual(client.prepare(books),[]);const removal=client.prepare([]);assert.equal(removal[0].version,3);assert.equal(removal[0].notesVersion,8);
 books[0].title='変更';ops=client.prepare(books);assert.equal(ops.length,1);assert.ok(!('notes' in ops[0].data));assert.equal(ops[0].version,3);
});
test('record UI restarts paged reads if a concurrent write changes the snapshot',async()=>{const p=provider();p.failAt=2;const client=ShioriRecords(p.fetcher);assert.deepEqual((await client.load()).books,[base]);assert.equal(p.calls,5);});
test('record API rejects duplicate targets, embedded notes and unversioned deletes',()=>{
 assert.equal(validateOperations([{kind:'book',id:'book',version:0,action:'put',data:base}]),false);
 assert.equal(validateOperations([{kind:'book',id:'book',version:3,action:'delete'}]),false);
 assert.equal(validateOperations([{kind:'note',id:'memo',bookId:'book',version:0,action:'put',data:{id:'memo',text:'メモ',tags:[],links:'invalid'}}]),false);
 const op={kind:'note',id:'memo',bookId:'book',version:6,action:'delete'};assert.equal(validateOperations([op,op]),false);assert.equal(validateOperations([op]),true);
});
