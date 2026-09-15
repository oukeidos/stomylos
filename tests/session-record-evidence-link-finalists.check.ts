// Two explicitly authorized false-support probes; no normal DB access or retries.
import {it,expect} from 'vitest';
import {readFileSync,writeFileSync,mkdirSync,openSync,closeSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {OpenRouter,CompletionFailure} from '../src/main/transport';
import {prepareProviderRequest} from '../src/main/provider-policy';
import {hash} from '../src/main/contracts';
it('checks S42 once with each former cleanup finalist',async()=>{
 const dir='test-results/session-record-evidence-link-finalists';mkdirSync(dir,{recursive:true,mode:0o700});
 const source=JSON.parse(readFileSync('test-results/session-record-evidence-link-all/requests.json','utf8')).find((t:any)=>t.label==='S42');expect(source).toBeTruthy();
 const configs=[{model:'qwen/qwen3.8-2.4t-a95b',effort:'low'},{model:'meta/muse-spark-1.3',effort:'minimal'}];
 const tasks=configs.map(c=>{const body=structuredClone(source.body);body.model=c.model;body.reasoning={effort:c.effort,exclude:true};body.max_tokens=16384;const identity={allowed_models:[c.model],provider:null};const p=prepareProviderRequest(body,identity);expect(p.body.messages).toEqual(source.body.messages);return {...c,body:p.body,identity:p.identity};});
 const env=readFileSync(join(homedir(),'.stomylos/.env'),'utf8');const entries=[...env.matchAll(/^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=\s*(.*?)\s*$/gm)];expect(entries).toHaveLength(1);const key=entries[0][1].trim().replace(/^['"]|['"]$/g,'');expect(/^[A-Za-z0-9_.-]{20,}$/.test(key)).toBe(true);
 closeSync(openSync(dir+'/started.json','wx',0o600));writeFileSync(dir+'/started.json',JSON.stringify({calls:2,at:new Date().toISOString(),hash:hash(JSON.stringify(tasks))}),{mode:0o600});writeFileSync(dir+'/requests.json',JSON.stringify(tasks,null,2),{mode:0o600});
 const results:any[]=[];const save=()=>writeFileSync(dir+'/results.json',JSON.stringify(results,null,2).replaceAll(key,'[REDACTED]'),{mode:0o600});
 for(const t of tasks){const row:any={model:t.model,effort:t.effort,status:'dispatched'};results.push(row);save();const start=performance.now();try{
  const response=await new OpenRouter(()=>key).complete(t.body,t.identity!,new AbortController().signal,180000);row.content=response.content;row.metadata=response.metadata;
  const pairs=JSON.parse(response.content);expect(Array.isArray(pairs)).toBe(true);expect(pairs).toHaveLength(1);expect(pairs[0]).toHaveLength(2);expect(pairs[0][0]).toBe(1);expect(Array.isArray(pairs[0][1])).toBe(true);
  for(const id of pairs[0][1]){expect(Number.isInteger(id)).toBe(true);expect(id).toBeGreaterThanOrEqual(1);expect(id).toBeLessThanOrEqual(source.input.conversation.length);}
  row.pairs=pairs;row.schema_valid=true;row.status='completed';
 }catch(e:any){row.status='failed';row.error=e.code??e.name;if(e instanceof CompletionFailure){row.content=e.content;row.metadata=e.metadata;}}
 row.elapsed_seconds=(performance.now()-start)/1000;save();}
 expect(results).toHaveLength(2);
},400000);
