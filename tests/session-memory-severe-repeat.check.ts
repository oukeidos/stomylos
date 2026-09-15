// Explicitly authorized two-session 36-call repeat probe; excluded from ordinary tests.
// All private input/output stays in ignored test-results. No normal DB writes/retries.
import {it,expect} from 'vitest';
import {readFileSync,writeFileSync,mkdirSync,openSync,closeSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {OpenRouter,CompletionFailure} from '../src/main/transport';
import {addAndFifo} from '../src/main/memory-add';
import {hash} from '../src/main/contracts';
const directory='test-results/session-memory-severe-repeat';
it('repeats the two selected sessions nine additional times per setting',async()=>{
 mkdirSync(directory,{recursive:true,mode:0o700});
 const prior='test-results/session-memory-all-comparison';
 const sessions=JSON.parse(readFileSync(prior+'/inputs.json','utf8')).filter((s:any)=>['S07','S25'].includes(s.label));
 const saved=JSON.parse(readFileSync(prior+'/requests.json','utf8')).filter((t:any)=>['S07','S25'].includes(t.label));
 expect(sessions).toHaveLength(2);expect(saved).toHaveLength(4);
 const tasks:any[]=[];
 for(let run=2;run<=10;run++) for(const label of ['S07','S25']) {
  const variants=run%2?['integer','original']:['original','integer'];
  for(const variant of variants){const t=saved.find((t:any)=>t.label===label&&t.variant===variant);expect(t).toBeTruthy();tasks.push({...structuredClone(t),run});}
 }
 expect(tasks).toHaveLength(36);
 const env=readFileSync(join(homedir(),'.stomylos/.env'),'utf8');
 const entries=[...env.matchAll(/^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=\s*(.*?)\s*$/gm)];expect(entries).toHaveLength(1);
 const key=entries[0][1].trim().replace(/^['"]|['"]$/g,'');expect(/^[A-Za-z0-9_.-]{20,}$/.test(key)).toBe(true);
 closeSync(openSync(directory+'/started.json','wx',0o600));
 writeFileSync(directory+'/started.json',JSON.stringify({at:new Date().toISOString(),calls:tasks.length,hash:hash(JSON.stringify(tasks))}),{mode:0o600});
 writeFileSync(directory+'/inputs.json',JSON.stringify(sessions,null,2),{mode:0o600});
 writeFileSync(directory+'/requests.json',JSON.stringify(tasks,null,2),{mode:0o600});
 const results:any[]=[];const gateway=new OpenRouter(()=>key);let next=0;
 const save=()=>writeFileSync(directory+'/results.json',JSON.stringify(results,null,2).replaceAll(key,'[REDACTED]'),{mode:0o600});
 async function worker(){while(next<tasks.length){
  const t=tasks[next++];const row:any={label:t.label,variant:t.variant,run:t.run,status:'dispatched',started_at:new Date().toISOString()};results.push(row);save();const start=performance.now();
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
 await Promise.all([worker(),worker()]);expect(results).toHaveLength(36);
},4000000);
