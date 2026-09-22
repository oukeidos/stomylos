import {expect,it} from 'vitest';
import {memoryFixture,memorySession,acceptNotes} from './current-memory-fixtures';
import {coldContextVersion} from '../src/main/memory-recall';
it('stores flat notes under the current context and applies session extraction plus source linking',()=>{
 const f=memoryFixture();try{
  const session=memorySession(f.store);expect(JSON.parse(session.chat_config).memory_version).toBe(coldContextVersion);
  const before=f.store.view(session.id).memory.snapshot;f.store.end(session.id);
  acceptNotes(f.store,['Likes quiet museums.']);expect(f.store.currentMemory()).toMatchObject({revision:1,database_records:[{text:'Likes quiet museums.'}]});
  expect(f.store.view(session.id).memory.snapshot).toEqual(before);expect(f.store.view(session.id).memory.addJobs![0].state).toBe('completed');
  expect(f.store.view(session.id).memory.addAttempts!.map(a=>a.phase)).toEqual(['extract','link']);
  f.reopen();expect(f.store.currentMemory().revision).toBe(1);expect(f.store.memoryAddReady()).toBeNull();
 }finally{f.close();}
});
