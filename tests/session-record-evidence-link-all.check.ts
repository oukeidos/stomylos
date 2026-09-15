// Bounded post-extraction linking for all existing original records; no normal DB access.
import {it,expect} from 'vitest';
import {readFileSync,writeFileSync,mkdirSync,openSync,closeSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {OpenRouter,CompletionFailure} from '../src/main/transport';
import {hash} from '../src/main/contracts';
const prompt='For each record, list the IDs of the conversation messages supporting it. Include messages needed to resolve references. Return only a JSON array of [record ID, supporting message IDs] pairs. Use [] for supporting message IDs if unsupported.';
it('links the remaining nonempty sessions once',async()=>{
 const dir='test-results/session-record-evidence-link-all';mkdirSync(dir,{recursive:true,mode:0o700});
 const prior='test-results/session-memory-all-comparison';
 const sessions=JSON.parse(readFileSync(prior+'/inputs.json','utf8'));
 const generations=JSON.parse(readFileSync(prior+'/results.json','utf8'));
 const requests=JSON.parse(readFileSync(prior+'/requests.json','utf8'));
 const tasks:any[]=[];const results:any[]=[];
 for(const session of sessions){
  const generated=generations.find((r:any)=>r.label===session.label&&r.variant==='original');
  expect(generated.status).toBe('completed');
  const saved=requests.find((r:any)=>r.label===session.label&&r.variant==='original');
  const input={conversation:session.conversation.map((m:any,i:number)=>[i+1,m.role,m.content]),records:generated.records.map((text:string,i:number)=>[i+1,text])};
  const body=structuredClone(saved.body);body.messages=[{role:'system',content:prompt},{role:'user',content:JSON.stringify(input)}];delete body.response_format;
  expect(body.model).toBe('openai/gpt-5.6-terra');expect(body.reasoning).toEqual({effort:'medium',exclude:true});
  if(!input.records.length){results.push({label:session.label,status:'empty_no_call',pairs:[],schema_valid:true});continue;}
  if(session.label==='S49'){
   const earlier=JSON.parse(readFileSync('test-results/session-record-evidence-link/request.json','utf8'));expect(body).toEqual(earlier.body);
   results.push({...JSON.parse(readFileSync('test-results/session-record-evidence-link/result.json','utf8')),label:'S49',reused:true});continue;
  }
  tasks.push({label:session.label,input,body,identity:saved.identity});
 }
 expect(tasks).toHaveLength(44);expect(results).toHaveLength(7);
 const env=readFileSync(join(homedir(),'.stomylos/.env'),'utf8');const entries=[...env.matchAll(/^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=\s*(.*?)\s*$/gm)];expect(entries).toHaveLength(1);
 const key=entries[0][1].trim().replace(/^['"]|['"]$/g,'');expect(/^[A-Za-z0-9_.-]{20,}$/.test(key)).toBe(true);
 closeSync(openSync(dir+'/started.json','wx',0o600));writeFileSync(dir+'/started.json',JSON.stringify({at:new Date().toISOString(),calls:44,reused:1,empty:6,body_hash:hash(JSON.stringify(tasks))}),{mode:0o600});
 writeFileSync(dir+'/requests.json',JSON.stringify(tasks,null,2),{mode:0o600});
 const save=()=>writeFileSync(dir+'/results.json',JSON.stringify(results,null,2).replaceAll(key,'[REDACTED]'),{mode:0o600});save();let next=0;const gateway=new OpenRouter(()=>key);
 async function worker(){while(next<tasks.length){
  const t=tasks[next++];const result:any={label:t.label,status:'dispatched'};results.push(result);save();const start=performance.now();
  try{
   const response=await gateway.complete(t.body,t.identity,new AbortController().signal,180000);result.content=response.content;result.metadata=response.metadata;
   const pairs=JSON.parse(response.content);expect(Array.isArray(pairs)).toBe(true);expect(pairs).toHaveLength(t.input.records.length);
   const seen=new Set<number>();for(const pair of pairs){expect(Array.isArray(pair)).toBe(true);expect(pair).toHaveLength(2);const [id,ids]=pair;expect(Number.isInteger(id)).toBe(true);expect(id).toBeGreaterThanOrEqual(1);expect(id).toBeLessThanOrEqual(t.input.records.length);expect(seen.has(id)).toBe(false);seen.add(id);expect(Array.isArray(ids)).toBe(true);for(const mid of ids){expect(Number.isInteger(mid)).toBe(true);expect(mid).toBeGreaterThanOrEqual(1);expect(mid).toBeLessThanOrEqual(t.input.conversation.length);}}
   result.pairs=pairs;result.schema_valid=true;result.status='completed';
  }catch(e:any){result.status='failed';result.error=e.code??e.name;if(e instanceof CompletionFailure){result.content=e.content;result.metadata=e.metadata;}}
  result.elapsed_seconds=(performance.now()-start)/1000;save();
 }}
 await Promise.all([worker(),worker()]);expect(results).toHaveLength(51);
},6000000);
