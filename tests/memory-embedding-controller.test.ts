import { afterEach, expect, it, vi } from 'vitest';
vi.mock('electron',()=>({utilityProcess:{fork:vi.fn()}}));
import { MemoryEmbeddingController } from '../src/main/memory-embedding-controller';
import { AppFailure } from '../src/main/errors';
import type { DatabaseClient } from '../src/main/db-client';
import type { EmbeddingWorkerClient } from '../src/main/memory-embedding-client';
afterEach(()=>vi.useRealTimers());
it('caps initialization recovery without claiming or failing any item and leaves explicit retry available',async()=>{
  vi.useFakeTimers();const methods:string[]=[],failures:(string|null)[]=[];
  const db={call:async(name:string,...args:any[])=>{methods.push(name);if(name==='memoryPreference')return{enabled:true};if(name==='coldStatus')return{pending:1};if(name==='coldTick')return 0;if(name==='coldIndexFailure')failures.push(args[0]);}} as unknown as DatabaseClient;
  const make=vi.fn(()=>({initialize:async()=>{throw new AppFailure('cold_init_timeout');},stop:async()=>{}} as unknown as EmbeddingWorkerClient));
  const controller=new MemoryEmbeddingController(db,'fixture','fixture',()=>{},make);
  await controller.initialize();await vi.advanceTimersByTimeAsync(36001);
  expect(make).toHaveBeenCalledTimes(4);expect(methods).not.toContain('coldClaim');expect(methods).not.toContain('coldFail');expect(failures.at(-1)).toBe('cold_init_timeout');
  await vi.advanceTimersByTimeAsync(60000);expect(make).toHaveBeenCalledTimes(4);
  await controller.retry();await vi.advanceTimersByTimeAsync(0);expect(make).toHaveBeenCalledTimes(5);await controller.close();
});
it('isolates an item after two inference failures, processes the next item and suspends before backup completion',async()=>{
  vi.useFakeTimers();let pending=2,claims=0,successes=0,failed=0;const methods:string[]=[];
  const db={call:async(name:string)=>{methods.push(name);if(name==='memoryPreference')return{enabled:true};if(name==='coldStatus')return{pending};if(name==='coldTick')return 0;
    if(name==='coldClaim'){claims++;return{id:claims<=2?'bad':'good',text:claims<=2?'bad':'good',attempts:claims===2?2:1,lease:String(claims)};}
    if(name==='coldFail'){failed++;if(failed===2)pending--;return true;}if(name==='coldComplete'){successes++;pending--;return true;}
  }} as unknown as DatabaseClient;
  const make=vi.fn(()=>({initialize:async()=>{},embed:async(text:string)=>{if(text==='bad')throw new AppFailure('cold_item_timeout');return{vector:[1],inputHash:'hash',chunkCount:1};},stop:async()=>{}} as unknown as EmbeddingWorkerClient));
  const controller=new MemoryEmbeddingController(db,'fixture','fixture',()=>{},make);await controller.initialize();await vi.advanceTimersByTimeAsync(6001);
  expect(claims).toBe(3);expect(failed).toBe(2);expect(successes).toBe(1);expect(pending).toBe(0);
  await controller.suspend();const before=methods.length;controller.wake();await vi.advanceTimersByTimeAsync(1000);expect(methods.length).toBe(before);await controller.close();
});
