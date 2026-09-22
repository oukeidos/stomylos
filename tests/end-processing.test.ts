import {afterEach,expect,it,vi} from 'vitest';
import {memoryFixture,memorySession,memoryCoordinator,receiveNotes} from './current-memory-fixtures';
import {AppFailure} from '../src/main/errors';
import type {Gateway} from '../src/main/transport';
const fixtures:ReturnType<typeof memoryFixture>[]=[];
afterEach(()=>fixtures.splice(0).forEach(f=>f.close()));
function fixture(){const f=memoryFixture();fixtures.push(f);return f;}
it('keeps failed extraction gated, retries the exact body explicitly, and never starts automatic grammar',async()=>{
 const f=fixture(),s=memorySession(f.store);let fail=true;const bodies:any[]=[];
 const gateway:Gateway={async complete(body){bodies.push(body);if(fail)throw new AppFailure('http_401');return {content:'{"add":[]}',metadata:{}};},async stream(){throw Error('No chat');}};
 const c=memoryCoordinator(f,gateway);
 try{await c.command('endSession',{sessionId:s.id});await vi.waitFor(()=>expect(f.store.view(s.id).memory.addJobs![0].state).toBe('failed'));
  expect(bodies).toHaveLength(1);expect(f.store.endBlocker()).toBe(s.id);expect(f.store.session(s.id).analysis_state).toBe('none');
  await expect(c.command('newSession',undefined)).rejects.toThrow('end_processing_pending');fail=false;
  await c.command('retryMemoryAdd',{sessionId:s.id,jobId:f.store.view(s.id).memory.addJobs![0].ordinal});await vi.waitFor(()=>expect(f.store.endBlocker()).toBeNull());
  expect(bodies).toHaveLength(2);expect(bodies[1]).toEqual(bodies[0]);expect(f.store.requests(s.id).filter(a=>a.role==='grammar')).toEqual([]);
 }finally{await c.command('close',undefined);}
});
it('commits a received linking response after restart without credentials or another inference',async()=>{
 const f=fixture(),s=memorySession(f.store);f.store.end(s.id);receiveNotes(f.store,['Likes museums.']);f.reopen();
 const complete=vi.fn(async()=>{throw Error('No inference');}),c=memoryCoordinator(f,{complete,async stream(){throw Error('No chat');}},false);
 try{await c.initialize();await vi.waitFor(()=>expect(f.store.endBlocker()).toBeNull());expect(complete).not.toHaveBeenCalled();expect(f.store.currentMemory().revision).toBe(1);}
 finally{await c.command('close',undefined);}
});
it('close interrupts active extraction and requires explicit recovery without applying a late result',async()=>{
 const f=fixture(),s=memorySession(f.store);const complete=vi.fn(async(_body,_identity,signal)=>new Promise<any>((_,reject)=>signal.addEventListener('abort',()=>reject(new AppFailure('request_cancelled')),{once:true})));
 const c=memoryCoordinator(f,{complete,async stream(){throw Error('No chat');}});
 await c.command('endSession',{sessionId:s.id});await vi.waitFor(()=>expect(complete).toHaveBeenCalledOnce());await c.command('close',undefined);f.reopen();
 expect(f.store.currentMemory().revision).toBe(0);expect(f.store.memoryAddReady()).toBeNull();expect(f.store.view(s.id).memory.addJobs![0].state).toBe('interrupted');
});
it('empty, unsent and Memory Off sessions finish without background generation',async()=>{
 for(const mode of ['empty','unsent','off']){
  const f=fixture();if(mode==='off')f.store.setMemoryPreference(false,0);const s=mode==='off'?memorySession(f.store):f.store.createSession();
  if(mode==='unsent')f.store.submit(s.id,'Accepted locally but never dispatched.');
  const complete=vi.fn(),c=memoryCoordinator(f,{complete,async stream(){throw Error('No chat');}});
  try{await c.command('endSession',{sessionId:s.id});expect(f.store.endBlocker()).toBeNull();expect(complete).not.toHaveBeenCalled();expect(f.store.view(s.id).memory.addJobs).toEqual([]);}
  finally{await c.command('close',undefined);}
 }
});
