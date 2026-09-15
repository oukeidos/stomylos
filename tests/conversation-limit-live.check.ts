// Explicit paid check. Never included in npm test; frozen manifest and one-shot ledger.
import { it, expect } from 'vitest';
import { readFileSync, writeFileSync, existsSync, openSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { OpenRouter, CompletionFailure } from '../src/main/transport';
import { hash, grammarSnapshot, validateGrammar } from '../src/main/contracts';
import { parseGenie } from '../src/main/genie';
import { addAndFifo } from '../src/main/memory-add';
const dir='test-results/conversation-limits';
it('executes the authorized seven-call synthetic manifest once within USD 20',async()=>{
 const manifest=JSON.parse(readFileSync(dir+'/manifest.json','utf8'));
 const caps=JSON.parse(readFileSync(dir+'/capabilities.json','utf8')).rows;
 const bounds=manifest.cases.map((c:any)=>{
  const endpoints=caps.find((r:any)=>r.model===c.body.model)?.endpoints;
  if(!endpoints?.length)throw Error('unverified_model');
  const prices=endpoints.flatMap((e:any)=>[e.pricing,...(e.pricing?.overrides??[])]);
  const input=Math.max(...prices.map((p:any)=>Number(p.prompt??0))),output=Math.max(...prices.map((p:any)=>Number(p.completion??0)));
  // UTF-8 envelope proxy plus framing and search reserves; use the highest listed price tier.
  const inputUpper=c.request_bytes+16384+(c.search?32768:0);
  return {id:c.id,reserved_usd:inputUpper*input+c.body.max_tokens*output+(c.search?0.25:0),input_rate:input,output_rate:output};
 });
 const total=bounds.reduce((n:number,x:any)=>n+x.reserved_usd,0);
 expect(manifest.max_calls).toBe(7);expect(manifest.cases.length).toBeLessThanOrEqual(7);expect(total).toBeLessThanOrEqual(20);
 writeFileSync(dir+'/cost-bound.json',JSON.stringify({total_reserved_usd:total,bounds},null,2));
 for(const c of manifest.cases)expect(hash(JSON.stringify(c.body))).toBe(c.body_hash);
 // Read only the established provider credential; never output it or use normal conversation data.
 const env=readFileSync(homedir()+'/.stomylos/.env','utf8');
 const match=[...env.matchAll(/^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=\s*(.*?)\s*$/gm)];expect(match.length).toBe(1);
 const key=match[0][1].trim().replace(/^['"]|['"]$/g,'');expect(/^[A-Za-z0-9_.-]{20,}$/.test(key)).toBe(true);
 // Exclusive marker prevents an uncertain/failed run from being paid again.
 const lock=openSync(dir+'/live-started.json','wx',0o600);closeSync(lock);
 writeFileSync(dir+'/live-started.json',JSON.stringify({at:new Date().toISOString(),manifest_hash:hash(JSON.stringify(manifest)),maximum_reserved_usd:total}));
 const results:any[]=[];let accounted=0;
 const gateway=new OpenRouter(()=>key);
 for(const c of manifest.cases) {
  if(accounted>=20)break;
  const result:any={id:c.id,body_hash:c.body_hash,model:c.body.model,started_at:new Date().toISOString(),status:'dispatched',reserved_usd:bounds.find((b:any)=>b.id===c.id).reserved_usd};
  results.push(result);writeFileSync(dir+'/live-results.json',JSON.stringify(results,null,2));console.log('DISPATCH',c.id);
  const start=performance.now();let content:string|null=null,metadata:any={};
  try {
   const response=c.stream?await gateway.stream(c.body,new AbortController().signal,()=>{}, {timeoutMs:c.timeoutMs,...(c.search?{search:true}: {})} as any)
    :await gateway.complete(c.body,{allowed_models:[c.body.model,c.body.model.replace(/-20260709$/,'')],provider:null},new AbortController().signal,c.timeoutMs);
   content=response.content;metadata=response.metadata;result.status='completed';
   if(c.grammar){const units=validateGrammar(content!,c.source,grammarSnapshot());result.units=units.length;result.changed=units.filter(u=>u.changed).length;result.grammar_valid=true;}
   if(c.genie){result.parsed=parseGenie(content!);result.genie_valid=true;}
   if(c.memory){const parsed=addAndFifo({character_id:'shared',revision:0,database_records:[]},content!,'synthetic');result.memory_valid=true;result.added=parsed.changes.added.length;}
   if(c.expected)result.expected_present=content!.toLowerCase().includes(c.expected);
  }catch(e:any){result.status='failed';result.error=e.code??e.name;if(e instanceof CompletionFailure){content=e.content;metadata=e.metadata;}}
  result.elapsed_seconds=(performance.now()-start)/1000;result.metadata=metadata;result.response_bytes=content===null?null:Buffer.byteLength(content);
  if(content!==null)writeFileSync(dir+'/'+c.id+'-response.txt',content.replaceAll(key,'[REDACTED]'),{mode:0o600});
  const actual=metadata.usage?.cost;result.cost_usd=typeof actual==='number'?actual:null;accounted+=result.cost_usd??result.reserved_usd;
  writeFileSync(dir+'/live-results.json',JSON.stringify(results,null,2));console.log('RESULT',JSON.stringify(result));
 }
 expect(results).toHaveLength(7);expect(accounted).toBeLessThanOrEqual(20);
},2100000);
