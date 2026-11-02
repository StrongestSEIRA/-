import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
export async function isolatedDatabase(){
 const value=process.env.SHIORI_TEST_DATABASE_URL;if(!value)throw Error('SHIORI_TEST_DATABASE_URL is required');const target=new URL(value);
 if(!['127.0.0.1','localhost','postgres'].includes(target.hostname)||!target.pathname.startsWith('/shiori_test'))throw Error('Only an explicitly named local test database is allowed');
 const admin=new pg.Client({connectionString:value});await admin.connect();
 await admin.query('SELECT pg_advisory_lock(72904180)');
 try{await admin.query(`DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$; DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$; DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$; DO $$ BEGIN CREATE ROLE shiori_gateway_role NOLOGIN NOSUPERUSER NOBYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);}finally{await admin.query('SELECT pg_advisory_unlock(72904180)');}
 const name='shiori_test_'+randomUUID().replaceAll('-','');await admin.query('CREATE DATABASE "'+name+'"');const database=new URL(value);database.pathname='/'+name;const pool=new pg.Pool({connectionString:database.href,max:20});
 try{
  await pool.query(`DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$; DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$; DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
   CREATE SCHEMA storage; CREATE TABLE storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`);
  await pool.query(await readFile(new URL('../db/schema.sql',import.meta.url),'utf8'));
  return {pool,async apply(file){const c=await pool.connect();try{await c.query(await readFile(new URL('../'+file,import.meta.url),'utf8'));}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}},async close(){await pool.end();await admin.query('DROP DATABASE "'+name+'"');await admin.end();}};
 }catch(e){await pool.end();await admin.query('DROP DATABASE "'+name+'"');await admin.end();throw e;}
}
export async function serviceQuery(pool,sql,params=[]){const c=await pool.connect();try{await c.query('BEGIN');await c.query('SET LOCAL ROLE service_role');const result=await c.query(sql,params);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
