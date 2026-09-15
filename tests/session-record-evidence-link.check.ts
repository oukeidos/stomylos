// One explicitly authorized post-extraction evidence-link call; no normal DB access.
import {it,expect} from 'vitest';
import {readFileSync,writeFileSync,mkdirSync,openSync,closeSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {OpenRouter,CompletionFailure} from '../src/main/transport';
import {hash} from '../src/main/contracts';
const prompt='For each record, list the IDs of the conversation messages supporting it. Include messages needed to resolve references. Return only a JSON array of [record ID, supporting message IDs] pairs. Use [] for supporting message IDs if unsupported.';
it('links one frozen sample using the exact proposed compact format',async()=>{
 const dir='test-results/session-record-evidence-link';mkdirSync(dir,{recursive:true,mode:0o700});
 const prior='test-results/session-memory-all-comparison';
 const session=JSON.parse(readFileSync(prior+'/inputs.json','utf8')).find((s:any)=>s.label==='S49');
 const generated=JSON.parse(readFileSync(prior+'/results.json','utf8')).find((r:any)=>r.label==='S49'&&r.variant==='original');
 const saved=JSON.parse(readFileSync(prior+'/requests.json','utf8')).find((r:any)=>r.label==='S49'&&r.variant==='original');
 expect(generated.status).toBe('completed');expect(generated.records).toHaveLength(2);
 const input={conversation:session.conversation.map((m:any,i:number)=>[i+1,m.role,m.content]),records:generated.records.map((text:string,i:number)=>[i+1,text])};
 const body=structuredClone(saved.body);body.messages=[{role:'system',content:prompt},{role:'user',content:JSON.stringify(input)}];
 // The user requested a root array with heterogeneous tuple entries. Do not wrap
 // it in an object or introduce a different strict provider schema.
 delete body.response_format;
 expect(body.model).toBe('openai/gpt-5.6-terra');expect(body.reasoning).toEqual({effort:'medium',exclude:true});
 const env=readFileSync(join(homedir(),'.stomylos/.env'),'utf8');const entries=[...env.matchAll(/^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=\s*(.*?)\s*$/gm)];expect(entries).toHaveLength(1);
 const key=entries[0][1].trim().replace(/^['"]|['"]$/g,'');expect(/^[A-Za-z0-9_.-]{20,}$/.test(key)).toBe(true);
 closeSync(openSync(dir+'/started.json','wx',0o600));writeFileSync(dir+'/started.json',JSON.stringify({at:new Date().toISOString(),calls:1,label:'S49',body_hash:hash(JSON.stringify(body))}),{mode:0o600});
 writeFileSync(dir+'/request.json',JSON.stringify({body,identity:saved.identity,input,original_generation_metadata:generated.metadata},null,2),{mode:0o600});
 const result:any={status:'dispatched'};const save=()=>writeFileSync(dir+'/result.json',JSON.stringify(result,null,2).replaceAll(key,'[REDACTED]'),{mode:0o600});save();const start=performance.now();
 try{
  const response=await new OpenRouter(()=>key).complete(body,saved.identity,new AbortController().signal,180000);result.content=response.content;result.metadata=response.metadata;
  const pairs=JSON.parse(response.content);expect(Array.isArray(pairs)).toBe(true);expect(pairs).toHaveLength(input.records.length);
  const seen=new Set<number>();for(const pair of pairs){expect(Array.isArray(pair)).toBe(true);expect(pair).toHaveLength(2);const [id,ids]=pair;expect(Number.isInteger(id)).toBe(true);expect(id).toBeGreaterThanOrEqual(1);expect(id).toBeLessThanOrEqual(input.records.length);expect(seen.has(id)).toBe(false);seen.add(id);expect(Array.isArray(ids)).toBe(true);for(const mid of ids){expect(Number.isInteger(mid)).toBe(true);expect(mid).toBeGreaterThanOrEqual(1);expect(mid).toBeLessThanOrEqual(input.conversation.length);}}
  result.pairs=pairs;result.schema_valid=true;result.status='completed';
 }catch(e:any){result.status='failed';result.error=e.code??e.name;if(e instanceof CompletionFailure){result.content=e.content;result.metadata=e.metadata;}}
 result.elapsed_seconds=(performance.now()-start)/1000;save();expect(result.status).toBe('completed');
},240000);
