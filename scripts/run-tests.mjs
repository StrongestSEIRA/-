import {readdir,mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
const group=process.argv[2]||'all';
if(!['all','unit','browser','db'].includes(group))throw Error('Unknown test group');
if(group==='db'&&!process.env.SHIORI_TEST_DATABASE_URL)throw Error('SHIORI_TEST_DATABASE_URL must explicitly name a local test database');
const files=(await readdir('test')).filter(f=>f.endsWith('.test.mjs')&&(
 group==='all'||group==='browser'&&f.endsWith('.browser.test.mjs')||group==='db'&&f.endsWith('.integration.test.mjs')||group==='unit'&&!f.endsWith('.browser.test.mjs')&&!f.endsWith('.integration.test.mjs')
)).sort().map(f=>'test/'+f);
if(!files.length)throw Error('No tests selected');
const args=['--test','--test-reporter=spec','--test-reporter-destination=stdout'];
if(process.env.TEST_REPORT_DIR){await mkdir(process.env.TEST_REPORT_DIR,{recursive:true});args.push('--test-reporter=junit','--test-reporter-destination='+join(process.env.TEST_REPORT_DIR,group+'.xml'));}
const env={...process.env};for(const name of ['SUPABASE_URL','SUPABASE_PUBLIC_KEY','SUPABASE_SECRET_KEY','RENDER_EXTERNAL_URL','AUTH_REGISTRATION_POLICY','SNAPSHOT_WRITE_MODE','TRUST_PROXY','COOKIE_SECURE','RENDER'])delete env[name];
const child=spawn(process.execPath,[...args,...files],{stdio:'inherit',env});child.on('error',e=>{console.error(e.message);process.exitCode=1;});child.on('exit',(code,signal)=>{process.exitCode=signal?1:code??1;});
