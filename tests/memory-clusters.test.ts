import { afterEach, expect, it } from 'vitest';
import { coldFixture } from './cold-memory-fixtures';
import { ColdMemoryStore, coldHash } from '../src/main/cold-memory-store';
import { MemoryClusters } from '../src/main/memory-clusters';
import { decodeVector, encodeVector, normalized } from '../src/main/memory-vectors';
const fixtures: ReturnType<typeof coldFixture>[] = [];
afterEach(() => { fixtures.splice(0).forEach(f => f.close()); });
function fixture() {
  const f = coldFixture(); fixtures.push(f);
  const originals = new ColdMemoryStore(f.db), clusters = new MemoryClusters(f.db);
  const space = clusters.register(JSON.stringify({ fixture: 'unit vectors', version: 1 }), 3), generation = clusters.begin(space);
  let order = 0;
  const archive = (id: string, session: string | null = id) => {
    f.db.transaction(() => {
      f.db.prepare("INSERT INTO memory_item_metadata(id,source_order,item_index,source_session_id,observed_at,origin) VALUES(?,?,0,?,'2026-01-01','add')").run(id, ++order, session);
      originals.archive([{ id, text: `Original ${id}` }]);
      f.db.prepare('DELETE FROM memory_item_metadata WHERE id=?').run(id);
    })();
  };
  const embed = (vector: number[]) => {
    const job = clusters.claim(space)!;
    expect(job).not.toBeNull();
    clusters.complete(job, { vector: Array.from(normalized(vector)), inputHash: coldHash(job.text), chunkCount: 1 });
    return job;
  };
  return { ...f, originals, clusters, space, generation, archive, embed };
}
it('assigns by representative thresholds, counts distinct sessions, and reconstructs exact sums after replay', () => {
  const f = fixture(); f.archive('a', 'session-1'); f.archive('b', 'session-1'); f.archive('c', 'session-2'); f.archive('d', null);
  f.embed([1, 0, 0]); f.clusters.reconcile(); f.embed([1, 0.1, 0]); f.clusters.reconcile();
  f.embed([1, -0.1, 0]); f.clusters.reconcile(); f.embed([0, 1, 0]); f.clusters.reconcile();
  expect(f.clusters.activate(f.generation)).toBe(true); f.clusters.verify(f.generation);
  expect(f.db.prepare('SELECT id,item_count,session_count FROM cold_clusters ORDER BY id').all()).toEqual([
    { id: 'a', item_count: 3, session_count: 2 }, { id: 'd', item_count: 1, session_count: 0 }
  ]);
  expect(f.clusters.reconcile()).toBe(0);
  expect(f.db.prepare('SELECT COUNT(*) FROM cold_memberships').pluck().get()).toBe(4);
});
it('discovers missing embedding rows and ready vectors without membership after restart, without another inference', () => {
  const f = fixture(); f.archive('a');
  f.db.prepare('DELETE FROM cold_embeddings').run(); f.clusters.reconcile();
  const job = f.embed([1, 0, 0]);
  expect(f.db.prepare('SELECT COUNT(*) FROM cold_memberships').pluck().get()).toBe(0);
  f.reopen(); const resumed = new MemoryClusters(f.db); resumed.recover();
  expect(resumed.claim(f.space)).toBeNull(); expect(resumed.reconcile()).toBe(1);
  expect(f.db.prepare('SELECT attempts FROM cold_embeddings').pluck().get()).toBe(1);
  expect(resumed.complete(job, { vector: [1, 0, 0], inputHash: coldHash(job.text), chunkCount: 1 })).toBe(false);
  resumed.verify(f.generation);
});
it('excludes a failed item explicitly, never activates past unresolved work, and repairs without double-counting', () => {
  const f = fixture(); f.archive('a'); f.archive('b');
  const failed = f.clusters.claim(f.space)!; f.clusters.fail(failed, 'fixture failure'); f.clusters.reconcile();
  expect(f.clusters.activate(f.generation)).toBe(false);
  expect(f.db.prepare('SELECT completed_revision FROM cluster_generations').pluck().get()).toBe(1);
  f.embed([1, 0, 0]); f.clusters.reconcile(); expect(f.clusters.activate(f.generation)).toBe(true);
  expect(f.db.prepare("SELECT COUNT(*) FROM cold_memberships WHERE state='excluded'").pluck().get()).toBe(1);
  f.clusters.retryFailed(f.space); f.embed([1, 0, 0]); f.clusters.reconcile(); f.clusters.verify(f.generation);
  expect(f.db.prepare('SELECT item_count,session_count FROM cold_clusters').get()).toEqual({ item_count: 2, session_count: 2 });
});
it('deletes anchors with bounded repair, preserves other originals, and rejects late results for revoked IDs', () => {
  const f = fixture(); for (const id of ['a', 'b', 'c']) { f.archive(id, 'same-session'); f.embed([1, 0, 0]); f.clusters.reconcile(); }
  f.archive('pending'); const pending = f.clusters.claim(f.space)!;
  f.clusters.deleteOriginal('pending', coldHash('Original pending'), f.originals.revision());
  expect(f.clusters.complete(pending, { vector: [1, 0, 0], inputHash: coldHash(pending.text), chunkCount: 1 })).toBe(false);
  f.clusters.deleteOriginal('a', coldHash('Original a'), f.originals.revision());
  expect(f.db.prepare('SELECT state FROM cold_clusters').pluck().get()).toBe('repairing');
  f.clusters.reconcile(1); expect(f.db.prepare('SELECT state FROM cold_clusters').pluck().get()).toBe('repairing');
  f.clusters.reconcile(1); f.clusters.reconcile(1); f.clusters.verify(f.generation);
  expect(f.db.prepare('SELECT anchor_id,item_count,session_count FROM cold_clusters').get()).toEqual({ anchor_id: 'b', item_count: 2, session_count: 1 });
  expect(f.originals.page().items.map(i => i.id).sort()).toEqual(['b', 'c']);
  expect(f.db.pragma('foreign_key_check')).toEqual([]);
});
it('builds a replacement generation from stored vectors, catches arrivals and deletions and switches atomically', () => {
  const f = fixture(); f.archive('a'); f.embed([1, 0, 0]); f.clusters.reconcile(); f.clusters.activate(f.generation);
  const next = f.clusters.begin(f.space, { version: 'centroid_anchor_v1', centroid: 0.8, anchor: 0.7 });
  f.clusters.reconcile(); f.archive('b'); expect(f.clusters.activate(next)).toBe(false);
  f.embed([0, 1, 0]); f.clusters.reconcile(); f.clusters.deleteOriginal('a', coldHash('Original a'), f.originals.revision());
  expect(f.clusters.activate(next)).toBe(true);
  expect(f.db.prepare("SELECT id FROM cluster_generations WHERE state='active'").pluck().get()).toBe(next);
  f.clusters.verify(next); expect(f.db.prepare('SELECT SUM(attempts) FROM cold_embeddings').pluck().get()).toBe(1);
});
it('rejects invalid vectors and broken aggregates rather than silently activating corrupt derived data', () => {
  expect(() => decodeVector(encodeVector([1, NaN, 0]), 3)).toThrow('cold_vector_finite');
  expect(() => decodeVector(encodeVector([1, 1, 0]), 3)).toThrow('cold_vector_norm');
  const f = fixture(); f.archive('a'); f.embed([1, 0, 0]); f.clusters.reconcile();
  f.db.prepare('UPDATE cold_clusters SET sum_vector=?').run(encodeVector([2, 0, 0], true));
  expect(() => f.clusters.activate(f.generation)).toThrow('cold_cluster_sum');
  expect(f.db.prepare("SELECT COUNT(*) FROM cluster_generations WHERE state='active'").pluck().get()).toBe(0);
});
it('re-embeds a corrupt stored vector on explicit repair and bounds retired generations while preserving originals',()=>{
  const f=fixture();f.archive('a');f.embed([1,0,0]);f.clusters.reconcile();f.clusters.activate(f.generation);
  f.db.prepare('UPDATE cold_embeddings SET vector=?').run(Buffer.from([0]));
  f.clusters.retryFailed(f.space);const next=f.clusters.begin(f.space);expect(f.clusters.begin(f.space,undefined,true)).toBe(next);
  expect(f.db.prepare('SELECT state FROM cold_embeddings').pluck().get()).toBe('pending');
  f.embed([1,0,0]);f.clusters.reconcile();expect(f.clusters.activate(next)).toBe(true);f.clusters.verify(next);
  for(let i=0;i<4;i++){const g=f.clusters.begin(f.space,undefined,true);f.clusters.reconcile();expect(f.clusters.activate(g)).toBe(true);}
  expect(f.db.prepare("SELECT COUNT(*) FROM cluster_generations WHERE state='retired'").pluck().get()).toBe(1);
  expect(f.originals.original('a')?.text).toBe('Original a');expect(f.db.pragma('foreign_key_check')).toEqual([]);
});
it('supersedes unfinished old model builds and rejects their late results without mixing vector spaces',()=>{
  const f=fixture();f.archive('a');const old=f.clusters.claim(f.space)!;
  const replacement=f.clusters.register('{"replacement":2}',3),next=f.clusters.begin(replacement);
  expect(f.db.prepare("SELECT COUNT(*) FROM cluster_generations WHERE state='building'").pluck().get()).toBe(1);
  expect(f.clusters.complete(old,{vector:[1,0,0],inputHash:coldHash(old.text),chunkCount:1})).toBe(false);
  f.clusters.reconcile();const job=f.clusters.claim(replacement)!;f.clusters.complete(job,{vector:[0,1,0],inputHash:coldHash(job.text),chunkCount:1});f.clusters.reconcile();expect(f.clusters.activate(next)).toBe(true);f.clusters.verify(next);
  expect(f.originals.original('a')?.text).toBe('Original a');
});
