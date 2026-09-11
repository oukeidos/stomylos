import { expect,it } from 'vitest';
import { mkdirSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import topics from './fixtures/cold-memory/topics.json';
import { loadEmbedding } from '../src/main/memory-embedding';
import { coldFixture } from './cold-memory-fixtures';
import { ColdMemoryStore } from '../src/main/cold-memory-store';
import { MemoryClusters } from '../src/main/memory-clusters';
import { clusterPolicy } from '../src/main/memory-vectors';
it('measures a fixed synthetic topic fixture at chronological checkpoints without private data or provider calls',async()=>{
  const engine=await loadEmbedding(resolve('assets/memory-model')),timings:number[]=[];
  const records=Array.from({length:10},(_,round)=>Object.entries(topics).map(([topic,notes])=>({id:`r${round}-${topic}`,text:notes[round],topic,session:`round-${round}`,round}))).flat();
  const vectors: Awaited<ReturnType<typeof engine.embed>>[]=[];
  try {for(const row of records){const start=performance.now();vectors.push(await engine.embed(row.text));timings.push(performance.now()-start);}}
  finally {await engine.close();}
  function run(threshold:number){
    const f=coldFixture(),raw=new ColdMemoryStore(f.db),groups=new MemoryClusters(f.db),space=groups.register('{"calibration":1}',384),gen=groups.begin(space,{version:'centroid_anchor_v1',centroid:threshold,anchor:threshold-0.1});
    const assign=(index:number)=>{const row=records[index];f.db.transaction(()=>{f.db.prepare("INSERT INTO memory_item_metadata(id,source_order,item_index,source_session_id,origin) VALUES(?,?,0,?,'add')").run(row.id,index,row.session);raw.archive([row]);f.db.prepare('DELETE FROM memory_item_metadata WHERE id=?').run(row.id);})();const job=groups.claim(space)!;groups.complete(job,vectors[index]);groups.reconcile();};
    const score=(start:number,end:number)=>{
      const mapping=new Map((f.db.prepare("SELECT memory_id,cluster_id FROM cold_memberships WHERE generation_id=? AND state='assigned'").all(gen) as {memory_id:string,cluster_id:string}[]).map(x=>[x.memory_id,x.cluster_id]));
      // Fixed balanced pairs: every same-topic pair and the first equally many
      // different-topic pairs in lexical source order, selected independently of output.
      const positive:number[][]=[],negative:number[][]=[];
      for(let a=start;a<end;a++)for(let b=a+1;b<end;b++)(records[a].topic===records[b].topic?positive:negative).push([a,b]);
      const negatives=negative.slice(0,positive.length);let tp=0,fp=0;
      for(const [a,b] of positive)if(mapping.has(records[a].id)&&mapping.get(records[a].id)===mapping.get(records[b].id))tp++;
      for(const [a,b] of negatives)if(mapping.has(records[a].id)&&mapping.get(records[a].id)===mapping.get(records[b].id))fp++;
      return{pairs:positive.length+negatives.length,positive:positive.length,negative:negatives.length,tp,fp,fn:positive.length-tp,precision:tp+fp?tp/(tp+fp):null,recall:tp/positive.length};
    };
    for(let i=0;i<30;i++)assign(i);const development=score(0,30);
    for(let i=30;i<40;i++)assign(i);const calibration=score(30,40);
    return {threshold,development,calibration,finish(){for(let i=40;i<50;i++)assign(i);groups.verify(gen);return{heldOut:score(40,50),groups:f.db.prepare('SELECT COUNT(*) FROM cold_clusters').pluck().get()};},close:()=>f.close()};
  }
  const candidates=[0.65,0.7,0.75,0.8,0.85].map(run);
  try{
    const selected=[...candidates].sort((a,b)=>(b.calibration.precision??0)-(a.calibration.precision??0)||b.calibration.recall-a.calibration.recall||Math.abs(a.threshold-0.75)-Math.abs(b.threshold-0.75))[0];
    const held=selected.finish();timings.sort((a,b)=>a-b);
    const report={scope:'50 invented English notes, 10 whole sessions; 30/10/10 chronological split; balanced pairs are not population prevalence estimates; not a real-memory usefulness study',selectedThreshold:selected.threshold,productThreshold:clusterPolicy.centroid,candidates:candidates.map(c=>({threshold:c.threshold,development:c.development,calibration:c.calibration})),...held,embeddingMs:{p50:timings[25],p95:timings[47],max:timings.at(-1)},providerRequests:0};
    mkdirSync('test-results/cold-memory',{recursive:true});writeFileSync('test-results/cold-memory/calibration.json',JSON.stringify(report,null,2));
    expect(selected.calibration.precision).toBeGreaterThanOrEqual(0.9);expect(selected.calibration.recall).toBeGreaterThanOrEqual(0.75);
    expect(held.heldOut.precision).toBeGreaterThanOrEqual(0.9);expect(held.heldOut.recall).toBeGreaterThanOrEqual(0.75);
  }finally{candidates.forEach(c=>c.close());}
},60000);
