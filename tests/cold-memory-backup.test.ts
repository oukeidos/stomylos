import { flattenMemory } from '../src/main/memory-flat';
import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { coldFixture } from './cold-memory-fixtures';
import { ColdMemoryStore, coldHash } from '../src/main/cold-memory-store';
import { MemoryClusters } from '../src/main/memory-clusters';
import { MemoryRecallStore } from '../src/main/memory-recall-store';
import { exportBackup,prepareBackup,installBackup } from '../src/main/backup';
import { Store } from '../src/main/database';
it('restores raw originals, binary vectors, generation and frozen recall together and resumes an abandoned lease',async()=>{
  const f=coldFixture(),target=mkdtempSync('/tmp/stomylos-cold-restored-'),file=join(target,'fixture.backup');
  let restored:Store|undefined;
  try{
    const raw=new ColdMemoryStore(f.db),clusters=new MemoryClusters(f.db),recall=new MemoryRecallStore(f.db),space=clusters.register('{"backup fixture":1}',3),gen=clusters.begin(space);
    for(const id of ['a','b'])f.db.transaction(()=>{f.db.prepare("INSERT INTO memory_item_metadata(id,source_order,item_index,origin) VALUES(?,1,0,'legacy')").run(id);raw.archive([{id,text:`Original ${id}`}]);f.db.prepare('DELETE FROM memory_item_metadata WHERE id=?').run(id);})();
    const job=clusters.claim(space)!;clusters.complete(job,{vector:[1,0,0],inputHash:coldHash(job.text),chunkCount:1});clusters.reconcile();
    const pending=clusters.claim(space)!;recall.cacheMetadata();
    const session=f.store.createSession(),frozen=recall.snapshot(session.id,flattenMemory(f.store.currentMemory()));
    const vector=f.db.prepare("SELECT vector FROM cold_embeddings WHERE state='ready'").pluck().get();
    f.store.close();await exportBackup(f.directory,file,'0.4.0');
    const empty=new Store(target,resolve('native/advisory-lock.node'));empty.close();
    const prepared=await prepareBackup(target,file);await installBackup(target,prepared.directory);
    restored=new Store(target,resolve('native/advisory-lock.node'));const db=new Database(join(target,'stomylos.sqlite3'));
    try{expect(db.prepare("SELECT vector FROM cold_embeddings WHERE state='ready'").pluck().get()).toEqual(vector);
      expect(db.prepare('SELECT state,lease FROM cold_embeddings WHERE memory_id=?').get(pending.id)).toEqual({state:'pending',lease:null});
      expect(new ColdMemoryStore(db).page().total).toBe(2);expect(new MemoryRecallStore(db).snapshot(session.id,flattenMemory(restored.currentMemory()))).toEqual(frozen);
      expect(db.prepare('SELECT state FROM cluster_generations WHERE id=?').pluck().get(gen)).toBe('building');expect(db.pragma('foreign_key_check')).toEqual([]);
    }finally{db.close();}
  }finally{restored?.close();f.close();rmSync(target,{recursive:true,force:true});}
});
