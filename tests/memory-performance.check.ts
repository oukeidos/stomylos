import { expect,it } from 'vitest';
import { mkdirSync,writeFileSync } from 'node:fs';
import { cpus,platform,release } from 'node:os';
import { coldFixture } from './cold-memory-fixtures';
import { ColdMemoryStore,coldHash } from '../src/main/cold-memory-store';
import { MemoryClusters } from '../src/main/memory-clusters';
import { MemoryRecallStore } from '../src/main/memory-recall-store';
import { coldRecallPolicy,codePoints,renderColdItem } from '../src/main/memory-recall';
import { encodeVector } from '../src/main/memory-vectors';
const stats=(times:number[])=>{times.sort((a,b)=>a-b);return{n:times.length,p50:times[Math.floor(times.length/2)],p95:times[Math.ceil(times.length*0.95)-1],max:times.at(-1)};};
it('measures exact stored recall and online assignment on bounded 10000-item fixtures',()=>{
 const results=[];
 for(const count of [1000,10]){
  const f=coldFixture(),raw=new ColdMemoryStore(f.db),groups=new MemoryClusters(f.db),recall=new MemoryRecallStore(f.db),space=groups.register('{"performance":1}',384),gen=groups.begin(space);
  try{
   const vector=Array.from({length:384},(_,i)=>i===0?1:0),bytes=encodeVector(vector),vh=coldHash(bytes),members=10000/count;
   f.db.transaction(()=>{
    for(let g=0;g<count;g++)f.db.prepare("INSERT INTO cold_clusters(id,generation_id,sum_vector,centroid,anchor_id,item_count,session_count,cohesion,revision) VALUES(?,?,?,?,?,?,0,1,1)").run('g'+g,gen,encodeVector(vector.map(v=>v*members),true),bytes,'m'+(g*members),members);
    for(let i=0;i<10000;i++){
     const id='m'+i,text='Invented prior observation '+i,h=coldHash(text);
     const revision=Number(f.db.prepare("INSERT INTO cold_mutations(memory_id,kind) VALUES(?,'archive')").run(id).lastInsertRowid);
     f.db.prepare("INSERT INTO cold_memories(id,text,text_hash,source_order,item_index,archived_at,origin,time_basis,archive_revision) VALUES(?,?,?,?,0,'2026-09-11','legacy','unknown',?)").run(id,text,h,i,revision);
     f.db.prepare("INSERT INTO cold_embeddings(memory_id,space_id,source_hash,input_hash,state,vector,vector_hash,chunk_count) VALUES(?,?,?,?,'ready',?,?,1)").run(id,space,h,h,bytes,vh);
     f.db.prepare("INSERT INTO cold_memberships(generation_id,space_id,memory_id,state,cluster_id,assignment_seq,source_revision) VALUES(?,?,?,'assigned',?,?,?)").run(gen,space,id,'g'+Math.floor(i/members),i,revision);
     f.db.prepare('INSERT INTO cold_render_metadata VALUES(?,?,?,?)').run(id,coldRecallPolicy,h,codePoints(renderColdItem({id,text,text_hash:h,observed_at:null,edited_at:null,time_basis:'unknown'})));
    }
    f.db.prepare('UPDATE cluster_generations SET next_assignment=10000 WHERE id=?').run(gen);groups.activate(gen);
   })();
   const sampling:number[]=[],assignment:number[]=[];
   for(let n=0;n<40;n++){
    const id='selection'+n;f.db.prepare("INSERT INTO sessions(id,state,created_at,chat_config,opening_kind) VALUES(?,'ended','2026-09-11','{}','user')").run(id);
    const start=performance.now(),result=recall.snapshot(id,{character_id:'shared',revision:0,database_records:[]});sampling.push(performance.now()-start);expect(result.items).toHaveLength(3);
   }
   for(let n=0;n<20;n++){
    const id='new'+n;f.db.transaction(()=>{f.db.prepare("INSERT INTO memory_item_metadata(id,source_order,item_index,origin) VALUES(?,?,0,'legacy')").run(id,10000+n);raw.archive([{id,text:'Another prior observation '+n}]);f.db.prepare('DELETE FROM memory_item_metadata WHERE id=?').run(id);})();
    const job=groups.claim(space)!;groups.complete(job,{vector,inputHash:coldHash(job.text),chunkCount:1});const start=performance.now();groups.reconcile();assignment.push(performance.now()-start);
   }
   results.push({originals:10000,groups:count,recallMs:stats(sampling),assignmentMs:stats(assignment)});
  }finally{f.close();}
 }
 mkdirSync('test-results/cold-memory',{recursive:true});writeFileSync('test-results/cold-memory/performance.json',JSON.stringify({cpu:cpus()[0].model,platform:platform(),os:release(),versions:process.versions,fixture:'Uniform valid vectors isolate data-volume cost, not semantic quality; no embeddings or ANN',results},null,2));
 for(const result of results){expect(result.recallMs.p95).toBeLessThan(50);expect(result.assignmentMs.p95).toBeLessThan(20);}
},60000);
