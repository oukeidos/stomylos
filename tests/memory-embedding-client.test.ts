import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('electron',()=>({utilityProcess:{fork:vi.fn()}}));
import { EmbeddingWorkerClient } from '../src/main/memory-embedding-client';
afterEach(()=>vi.useRealTimers());
class Worker extends EventEmitter {
  sent:any[]=[];killed=0;exitOnKill=true;
  postMessage(message:any){this.sent.push(message);}
  kill(){this.killed++;if(this.exitOnKill)this.emit('exit',0);return true;}
}
it('invalidates the lease before killing a hung initializer and rejects its late reply',async()=>{
  vi.useFakeTimers();const worker=new Worker(),events:string[]=[];
  worker.on('exit',()=>events.push('exit'));
  const client=new EmbeddingWorkerClient('fixture',async()=>{events.push('invalidated');},()=>worker,{init:20,item:30,termination:10});
  const pending=client.initialize('fixture'),caught=pending.catch(e=>e.message);
  await vi.advanceTimersByTimeAsync(20);expect(await caught).toBe('cold_init_timeout');expect(events).toEqual(['invalidated','exit']);expect(worker.killed).toBe(1);
  worker.emit('message',{id:1,result:{}});await expect(client.embed('late')).rejects.toThrow('cold_worker_unavailable');
});
it('bounds a worker that emits neither responses nor exit, instead of spawning over an unconfirmed process',async()=>{
  vi.useFakeTimers();const worker=new Worker();worker.exitOnKill=false;
  const client=new EmbeddingWorkerClient('fixture',async()=>{},()=>worker,{init:20,item:30,termination:10});
  const caught=client.initialize('fixture').catch(e=>e.message);await vi.advanceTimersByTimeAsync(31);
  expect(await caught).toBe('cold_worker_termination');expect(worker.killed).toBe(1);await expect(client.stop()).rejects.toThrow('cold_worker_termination');
});
it('uses a separate item deadline after initialization and cannot admit a stale item after stop',async()=>{
  vi.useFakeTimers();const worker=new Worker(),invalidate=vi.fn(async()=>{});
  const client=new EmbeddingWorkerClient('fixture',invalidate,()=>worker,{init:20,item:30,termination:10});
  const init=client.initialize('fixture');worker.emit('message',{id:1,result:{}});await init;
  const caught=client.embed('original').catch(e=>e.message);await vi.advanceTimersByTimeAsync(29);expect(worker.killed).toBe(0);
  await vi.advanceTimersByTimeAsync(1);expect(await caught).toBe('cold_item_timeout');expect(invalidate).toHaveBeenCalledWith('cold_item_timeout');
});
