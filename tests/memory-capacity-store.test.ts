import {afterEach,expect,it} from 'vitest';
import {memoryFixture,memorySession,receiveNotes,acceptNotes,memoryAttempt} from './current-memory-fixtures';
import {memoryCharacters} from '../src/main/memory-render';
const fixtures:ReturnType<typeof memoryFixture>[]=[];
afterEach(()=>fixtures.splice(0).forEach(f=>f.close()));
function fixture(){const f=memoryFixture();fixtures.push(f);const session=memorySession(f.store);f.store.end(session.id);return {...f,session};}
it('archives FIFO overflow intact with session provenance instead of invoking the retired cleanup model',()=>{
 const f=fixture(),before=f.store.view(f.session.id).memory.snapshot;
 acceptNotes(f.store,['First '+ 'x'.repeat(2200),'Second '+ 'y'.repeat(2200),'Newest']);
 expect(memoryCharacters(f.store.currentMemory())).toBeLessThanOrEqual(3000);
 expect(f.store.currentMemory()).toMatchObject({database_records:[{text:'Second '+ 'y'.repeat(2200)},{text:'Newest'}]});
 expect(f.db.prepare('SELECT text,source_session_id FROM cold_memories').all()).toEqual([{text:'First '+ 'x'.repeat(2200),source_session_id:f.session.id}]);
 expect(f.store.view(f.session.id).memory.snapshot).toEqual(before);expect(f.store.endBlocker()).toBeNull();
 expect(f.db.prepare('SELECT count(*) FROM memory_cleanup_attempts').pluck().get()).toBe(0);
});
it('rejects a single over-cap record atomically without truncating or applying its companion',()=>{
 const f=fixture(),text='한🙂'.repeat(2000);expect(()=>acceptNotes(f.store,[text,'Newest'])).toThrow('memory_add_item_capacity');
 expect(f.db.prepare('SELECT count(*) FROM cold_memories').pluck().get()).toBe(0);
 expect(f.store.currentMemory()).toMatchObject({revision:0,database_records:[]});expect(f.store.integrity().foreignKeys).toEqual([]);
});
it('rolls back HOT, Older and provenance together, then accepts the received response exactly once',()=>{
 const f=fixture(),attempt=receiveNotes(f.store,['x'.repeat(2998),'Newest']),before=f.store.currentMemory();
 f.db.exec("CREATE TRIGGER fail_archive BEFORE INSERT ON cold_memories BEGIN SELECT RAISE(ABORT,'archive fault'); END");
 expect(()=>f.store.acceptMemoryAdd(attempt.id)).toThrow('archive fault');expect(f.store.currentMemory()).toEqual(before);
 expect(f.db.prepare('SELECT count(*) FROM cold_memories').pluck().get()).toBe(0);expect(f.store.view(f.session.id).memory.addJobs![0].state).toBe('received');
 f.db.exec('DROP TRIGGER fail_archive');f.store.acceptMemoryAdd(attempt.id);const saved=f.store.currentMemory();f.store.acceptMemoryAdd(attempt.id);expect(f.store.currentMemory()).toEqual(saved);
 expect(f.db.prepare('SELECT count(*) FROM cold_memories').pluck().get()).toBe(1);
});
it('cancels a pending source without applying late results or changing authoritative memory',()=>{
 const f=fixture(),attempt=memoryAttempt(f.store),before=f.store.currentMemory();f.store.cancelEnd(f.session.id);
 f.store.receiveMemoryAdd(attempt.id,'{"add":["Late"]}',{});f.store.acceptMemoryAdd(attempt.id);
 expect(f.store.currentMemory()).toEqual(before);expect(f.store.endBlocker()).toBeNull();expect(f.store.view(f.session.id).memory.addJobs![0].state).toBe('skipped');
});
it('deleting an ended source preserves already archived facts and clears its owned attempts',()=>{
 const f=fixture();acceptNotes(f.store,['x'.repeat(2998),'Newest']);const before=f.db.prepare('SELECT * FROM cold_memories').all(),memory=f.store.currentMemory();
 f.store.deleteSession(f.session.id);expect(f.store.currentMemory()).toEqual(memory);expect(f.db.prepare('SELECT * FROM cold_memories').all()).toEqual(before);
 expect(f.db.prepare('SELECT count(*) FROM memory_add_attempts').pluck().get()).toBe(0);expect(f.store.integrity().foreignKeys).toEqual([]);
});
