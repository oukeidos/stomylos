// Explicitly authorized 51-session paired probe; excluded from ordinary tests.
// All private input/output stays in ignored test-results. No normal DB writes/retries.
import {it,expect} from 'vitest';
import Database from 'better-sqlite3';
import {readFileSync,writeFileSync,mkdirSync,openSync,closeSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {OpenRouter,CompletionFailure} from '../src/main/transport';
import {prepareProviderRequest} from '../src/main/provider-policy';
import {sessionMemoryAddBody,addAndFifo} from '../src/main/memory-add';
import {hash} from '../src/main/contracts';
const directory='test-results/session-memory-all-comparison';
const oldOutput='Return only JSON with an "add" array of record strings. Return {"add":[]} if no personal information remains. Do not include metadata or explanations.';
const newOutput='Return only JSON with an "add" array of objects, each containing an "id" (a sequential integer starting at 1), "text" (the record), and "evidence_ids" (the IDs of the conversation messages supporting that record). Return {"add":[]} if no personal information remains. Do not include explanations.';
it('generates once per setting for every nonempty session',async()=>{
 mkdirSync(directory,{recursive:true,mode:0o700});
 const db=new Database(join(homedir(),'.local/share/io.github.oukeidos.stomylos/stomylos.sqlite3'),{readonly:true,fileMustExist:true});
 let sessions:any[]=[];let excluded:any[]=[];
 try{
  db.pragma('query_only=ON');db.exec('BEGIN');
  const all=db.prepare('SELECT id,state,created_at FROM sessions ORDER BY created_at,id').all() as any[];
  for(const s of all){
   const conversation=db.prepare("SELECT role,content FROM messages WHERE session_id=? AND delivery='complete' AND (role='assistant' OR (role='user' AND origin='learner')) ORDER BY sequence").all(s.id) as any[];
   if(!conversation.some(m=>m.role==='user')){excluded.push(s);continue;}
   sessions.push({...s,label:`S${String(sessions.length+1).padStart(2,'0')}`,conversation});
  }
  db.exec('ROLLBACK');
 }finally{db.close();}
 expect(sessions).toHaveLength(51);expect(excluded).toHaveLength(1);
 const identity={allowed_models:['openai/gpt-5.6-terra'],provider:null};
 const tasks:any[]=[];
 for(const [index,s] of sessions.entries()){
  const original=sessionMemoryAddBody({conversation:s.conversation});
  const integer=structuredClone(original);
  expect(integer.messages[0].content).toContain(oldOutput);
  integer.messages[0].content=integer.messages[0].content.replace(oldOutput,newOutput);
  const input={conversation:s.conversation.map((m:any,i:number)=>({id:i+1,...m}))};
  integer.messages[1].content=JSON.stringify(input);
  integer.response_format.json_schema.name='add_evidence_probe_v1';
  integer.response_format.json_schema.schema.properties.add.items={type:'object',properties:{id:{type:'integer',minimum:1},text:{type:'string',minLength:1},evidence_ids:{type:'array',items:{type:'integer',enum:input.conversation.map((m:any)=>m.id)},minItems:1}},required:['id','text','evidence_ids'],additionalProperties:false};
  const normalized=structuredClone(integer);normalized.messages=original.messages;normalized.response_format=original.response_format;expect(normalized).toEqual(original);
  const pair=[{variant:'original',body:original},{variant:'integer',body:integer}];if(index%2)pair.reverse();
  for(const t of pair){const p=prepareProviderRequest(t.body,identity);tasks.push({label:s.label,variant:t.variant,body:p.body,identity:p.identity,message_count:s.conversation.length});}
 }
 // Confirm exact request parity with earlier probe for the shared case.
 const earlier=JSON.parse(readFileSync('test-results/session-memory-evidence-integer-ids/request.json','utf8')).body;
 expect(tasks.some(t=>t.variant==='integer'&&JSON.stringify(t.body)===JSON.stringify(earlier))).toBe(true);
 const env=readFileSync(join(homedir(),'.stomylos/.env'),'utf8');
 const entries=[...env.matchAll(/^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=\s*(.*?)\s*$/gm)];expect(entries).toHaveLength(1);
 const key=entries[0][1].trim().replace(/^['"]|['"]$/g,'');expect(/^[A-Za-z0-9_.-]{20,}$/.test(key)).toBe(true);
 closeSync(openSync(directory+'/started.json','wx',0o600));
 writeFileSync(directory+'/started.json',JSON.stringify({at:new Date().toISOString(),calls:tasks.length,excluded,hash:hash(JSON.stringify(tasks))}),{mode:0o600});
 writeFileSync(directory+'/inputs.json',JSON.stringify(sessions,null,2),{mode:0o600});
 writeFileSync(directory+'/requests.json',JSON.stringify(tasks,null,2),{mode:0o600});
 const results:any[]=[];const gateway=new OpenRouter(()=>key);let next=0;
 const save=()=>writeFileSync(directory+'/results.json',JSON.stringify(results,null,2).replaceAll(key,'[REDACTED]'),{mode:0o600});
 async function worker(){while(next<tasks.length){
  const t=tasks[next++];const row:any={label:t.label,variant:t.variant,status:'dispatched',started_at:new Date().toISOString()};results.push(row);save();const start=performance.now();
  try{
   const result=await gateway.complete(t.body,t.identity,new AbortController().signal,180000);
   row.metadata=result.metadata;row.content=result.content;
   if(t.variant==='original')row.records=addAndFifo({character_id:'shared',revision:0,database_records:[]},result.content,'probe').changes.added.map(x=>x.text);
   else{
    const parsed=JSON.parse(result.content);expect(Object.keys(parsed)).toEqual(['add']);expect(Array.isArray(parsed.add)).toBe(true);row.records=parsed.add;
    for(const [i,r] of parsed.add.entries()){
     expect(Object.keys(r).sort()).toEqual(['evidence_ids','id','text']);expect(r.id).toBe(i+1);expect(typeof r.text).toBe('string');expect(r.text.length).toBeGreaterThan(0);
     expect(Array.isArray(r.evidence_ids)).toBe(true);expect(r.evidence_ids.length).toBeGreaterThan(0);
     for(const id of r.evidence_ids){expect(Number.isInteger(id)).toBe(true);expect(id).toBeGreaterThanOrEqual(1);expect(id).toBeLessThanOrEqual(t.message_count);}
    }
   }
   row.schema_valid=true;row.status='completed';
  }catch(e:any){row.status='failed';row.error=e.code??e.name;if(e instanceof CompletionFailure){row.content=e.content;row.metadata=e.metadata;}}
  row.elapsed_seconds=(performance.now()-start)/1000;save();
  console.log(JSON.stringify({label:t.label,variant:t.variant,status:row.status,records:row.records?.length}));
 }}
 await Promise.all([worker(),worker()]);expect(results).toHaveLength(102);
},12000000);
