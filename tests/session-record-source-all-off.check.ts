// Authorized four-model full-sample source-location comparison; no extraction or production writes.
import {it,expect} from 'vitest';
import {readFileSync,writeFileSync,mkdirSync,openSync,closeSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {OpenRouter,CompletionFailure} from '../src/main/transport';
import {prepareProviderRequest} from '../src/main/provider-policy';
import {hash} from '../src/main/contracts';
const prompt='For each record, identify the conversation messages it was derived from, including messages needed to resolve references. Return each record ID with its source message IDs.';
it('locates sources for all nonempty samples with four models and no reasoning',async()=>{
 const dir='test-results/session-record-source-all-off';mkdirSync(dir,{recursive:true,mode:0o700});
 const prior='test-results/session-memory-all-comparison';const sessions=JSON.parse(readFileSync(prior+'/inputs.json','utf8'));const outputs=JSON.parse(readFileSync(prior+'/results.json','utf8'));
 const configs=[
  {model:'google/gemma-4-31b-it',reasoning:{enabled:false,exclude:true}},
  {model:'openai/gpt-5.6-luna',reasoning:{effort:'none',exclude:true}},
  {model:'xiaomi/mimo-v2.5',reasoning:{enabled:false,exclude:true}},
  {model:'qwen/qwen3.8-flash',reasoning:{enabled:false,exclude:true}}
 ];const tasks:any[]=[];const skipped:string[]=[];
 for(const s of sessions){
  const label=s.label;const records=outputs.find((r:any)=>r.label===label&&r.variant==='original').records;
  if(records.length===0){skipped.push(label);continue;}
  const input={conversation:s.conversation.map((m:any,i:number)=>[i+1,m.role,m.content]),records:records.map((t:string,i:number)=>[i+1,t])};
  const schema={type:'object',properties:{sources:{type:'array',items:{type:'object',properties:{id:{type:'integer',enum:input.records.map((r:any)=>r[0])},ids:{type:'array',items:{type:'integer',enum:input.conversation.map((m:any)=>m[0])},minItems:1}},required:['id','ids'],additionalProperties:false}}},required:['sources'],additionalProperties:false};
  for(const c of [...configs.slice(sessions.indexOf(s)%4),...configs.slice(0,sessions.indexOf(s)%4)]){const body={model:c.model,reasoning:c.reasoning,max_tokens:4096,messages:[{role:'system',content:prompt},{role:'user',content:JSON.stringify(input)}],response_format:{type:'json_schema',json_schema:{name:'record_sources',strict:true,schema}},provider:{require_parameters:true}};const p=prepareProviderRequest(body,{allowed_models:[c.model],provider:null});tasks.push({label,model:c.model,input,body:p.body,identity:p.identity});}
 }
 const env=readFileSync(join(homedir(),'.stomylos/.env'),'utf8');const entries=[...env.matchAll(/^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=\s*(.*?)\s*$/gm)];expect(entries).toHaveLength(1);const key=entries[0][1].trim().replace(/^['"]|['"]$/g,'');expect(/^[A-Za-z0-9_.-]{20,}$/.test(key)).toBe(true);
 closeSync(openSync(dir+'/started.json','wx',0o600));writeFileSync(dir+'/started.json',JSON.stringify({calls:tasks.length,skipped,at:new Date().toISOString(),hash:hash(JSON.stringify(tasks))}),{mode:0o600});writeFileSync(dir+'/requests.json',JSON.stringify(tasks,null,2),{mode:0o600});
 const results:any[]=[];let next=0;const save=()=>writeFileSync(dir+'/results.json',JSON.stringify(results,null,2).replaceAll(key,'[REDACTED]'),{mode:0o600});
 async function worker(){while(next<tasks.length){const t=tasks[next++];const r:any={label:t.label,model:t.model,status:'dispatched'};results.push(r);save();const start=performance.now();try{
  const response=await new OpenRouter(()=>key).complete(t.body,t.identity,new AbortController().signal,180000);r.content=response.content;r.metadata=response.metadata;
  const parsed=JSON.parse(response.content);expect(Object.keys(parsed)).toEqual(['sources']);expect(Array.isArray(parsed.sources)).toBe(true);expect(parsed.sources).toHaveLength(t.input.records.length);
  const seen=new Set();for(const s of parsed.sources){expect(Object.keys(s).sort()).toEqual(['id','ids']);expect(t.input.records.some((v:any)=>v[0]===s.id)).toBe(true);expect(seen.has(s.id)).toBe(false);seen.add(s.id);expect(Array.isArray(s.ids)).toBe(true);expect(s.ids.length).toBeGreaterThan(0);for(const id of s.ids)expect(t.input.conversation.some((v:any)=>v[0]===id)).toBe(true);}
  r.sources=parsed.sources;r.schema_valid=true;r.status='completed';
 }catch(e:any){r.status='failed';r.error=e.code??e.name;if(e instanceof CompletionFailure){r.content=e.content;r.metadata=e.metadata;}}
 r.elapsed_seconds=(performance.now()-start)/1000;save();console.log(`${t.label} ${t.model} ${r.status} ${r.elapsed_seconds.toFixed(2)}s`);}}
 await Promise.all([worker(),worker(),worker(),worker()]);expect(results).toHaveLength(180);expect(results.every(r=>r.status==='completed')).toBe(true);
},3600000);
