// Explicit one-call evidence-ID probe; never included in ordinary npm test.
// All source/response content stays in ignored test-results, never in fixtures.
import { it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OpenRouter, CompletionFailure } from '../src/main/transport';
import { prepareProviderRequest } from '../src/main/provider-policy';
import { hash } from '../src/main/contracts';
const sentence='Return only JSON with an "add" array of objects, each containing an "id" (a sequential integer starting at 1), "text" (the record), and "evidence_ids" (the IDs of the conversation messages supporting that record). Return {"add":[]} if no personal information remains. Do not include explanations.';
it('probes evidence message IDs for the authorized session exactly once',async()=>{
 const directory='test-results/session-memory-evidence-ids';mkdirSync(directory,{recursive:true,mode:0o700});
 const db=new Database(join(homedir(),'.local/share/io.github.oukeidos.stomylos/stomylos.sqlite3'),{readonly:true,fileMustExist:true});
 let saved:any;
 try {
  db.pragma('query_only=ON');db.exec('BEGIN');
  const matches=db.prepare("SELECT DISTINCT session_id FROM messages WHERE lower(content) LIKE '%besame%' OR lower(content) LIKE '%bésame%'").all() as {session_id:string}[];
  expect(matches).toHaveLength(1);
  saved=db.prepare("SELECT j.input_json,j.input_hash,j.config,j.config_hash,a.body,a.body_hash,a.response_content FROM memory_add_jobs j JOIN memory_add_attempts a ON a.job_id=j.ordinal AND a.status='succeeded' WHERE j.session_id=? AND j.source_kind='session' AND j.state='completed'").get(matches[0].session_id);
  expect(saved).toBeTruthy();expect(hash(saved.input_json)).toBe(saved.input_hash);expect(hash(saved.config)).toBe(saved.config_hash);expect(hash(saved.body)).toBe(saved.body_hash);
  db.exec('ROLLBACK');
 } finally {db.close();}
 const config=JSON.parse(saved.config),original=JSON.parse(saved.body),body=structuredClone(original);
 expect(body).toEqual(config.body);expect(body.messages[0].content).toBe(readFileSync('src/main/session-memory-add-prompt.txt','utf8'));
 const oldOutput='Return only JSON with an "add" array of record strings. Return {"add":[]} if no personal information remains. Do not include metadata or explanations.';
 expect(body.messages[0].content).toContain(oldOutput);
 body.messages[0].content=body.messages[0].content.replace(oldOutput,sentence);
 expect(body.messages[0].content).not.toContain('Sort the records');
 const input=JSON.parse(body.messages[1].content);
 input.conversation=input.conversation.map((m:any,i:number)=>({id:`m${String(i+1).padStart(2,'0')}`,...m}));
 body.messages[1].content=JSON.stringify(input);
 body.response_format.json_schema.name='add_evidence_probe_v1';
 body.response_format.json_schema.schema.properties.add.items={type:'object',properties:{id:{type:'integer',minimum:1},text:{type:'string',minLength:1},evidence_ids:{type:'array',items:{type:'string',enum:input.conversation.map((m:any)=>m.id)},minItems:1}},required:['id','text','evidence_ids'],additionalProperties:false};
 const prepared=prepareProviderRequest(body,config.identity);const timeout=config.timeout_ms;
 expect(body.model).toBe('openai/gpt-5.6-terra');expect(body.max_tokens).toBe(128000);expect(timeout).toBe(180000);
 const environment=readFileSync(join(homedir(),'.stomylos/.env'),'utf8');
 const entries=[...environment.matchAll(/^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=\s*(.*?)\s*$/gm)];expect(entries).toHaveLength(1);
 const key=entries[0][1].trim().replace(/^['"]|['"]$/g,'');expect(/^[A-Za-z0-9_.-]{20,}$/.test(key)).toBe(true);
 const marker=openSync(directory+'/started.json','wx',0o600);closeSync(marker);
 writeFileSync(directory+'/started.json',JSON.stringify({at:new Date().toISOString(),calls:1,input_hash:saved.input_hash,body_hash:hash(JSON.stringify(prepared.body)),sentence}));
 writeFileSync(directory+'/request.json',JSON.stringify({original,body:prepared.body,original_output:JSON.parse(saved.response_content)},null,2),{mode:0o600});
 const results:any[]=[];const gateway=new OpenRouter(()=>key);
 for(let i=1;i<=1;i++) {
  const row:any={run:i,status:'dispatched',started_at:new Date().toISOString()};results.push(row);writeFileSync(directory+'/results.json',JSON.stringify(results,null,2),{mode:0o600});
  const start=performance.now();
  try {
   const result=await gateway.complete(prepared.body,prepared.identity!,new AbortController().signal,timeout);
   row.metadata=result.metadata;row.content=result.content;row.status='completed';
   const parsed=JSON.parse(result.content);row.records=parsed.add;
   expect(Object.keys(parsed)).toEqual(['add']);expect(Array.isArray(parsed.add)).toBe(true);
   for(const [index,record] of parsed.add.entries()) {
    expect(Object.keys(record).sort()).toEqual(['evidence_ids','id','text']);expect(record.id).toBe(index+1);
    expect(typeof record.text).toBe('string');expect(record.text.length).toBeGreaterThan(0);
    expect(Array.isArray(record.evidence_ids)).toBe(true);expect(record.evidence_ids.length).toBeGreaterThan(0);
    for(const id of record.evidence_ids) expect(input.conversation.some((m:any)=>m.id===id)).toBe(true);
   }
   row.schema_valid=true;
  }catch(error:any){row.status='failed';row.error=error.code??error.name;if(error instanceof CompletionFailure){row.content=error.content;row.metadata=error.metadata;}}
  row.elapsed_seconds=(performance.now()-start)/1000;
  writeFileSync(directory+'/results.json',JSON.stringify(results,null,2).replaceAll(key,'[REDACTED]'),{mode:0o600});
  console.log(JSON.stringify({run:i,status:row.status,seconds:row.elapsed_seconds,cost:row.metadata?.usage?.cost,records:row.records?.length,error:row.error}));
 }
 expect(results).toHaveLength(1);
},600000);
