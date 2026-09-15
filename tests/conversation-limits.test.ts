import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { conversationBudget } from '../src/shared/conversation-limits';
import { genieRecentMessages } from '../src/main/genie';
import { dadouchosSource } from '../src/main/dadouchos';
import { Store, type StoreMethod } from '../src/main/database';
import { grammarSnapshot, grammarBody, hash } from '../src/main/contracts';
import { migrateDatabase, currentSchema } from '../src/main/database-migrations';
import { Coordinator } from '../src/main/coordinator';
import type { DatabaseClient } from '../src/main/db-client';
import type { Gateway } from '../src/main/transport';
import type { Message } from '../src/shared/types';
import oldGrammar from '../src/main/grammar-v2-config.json';
const message=(content:string,i=0,role:'user'|'assistant'='user'):Message=>({id:'m'+i,session_id:'s',sequence:i,origin:role==='user'?'learner':'model',role,content,delivery:'complete',request_id:null});
const fixtures:{dir:string;store:Store;db:Database.Database}[]=[];
afterEach(()=>{for(const f of fixtures.splice(0)){f.store.close();f.db.close();rmSync(f.dir,{recursive:true,force:true});}});
function fixture(){const dir=mkdtempSync('/tmp/stomylos-limits-');const store=new Store(dir,resolve('native/advisory-lock.node'));const db=new Database(join(dir,'stomylos.sqlite3'));const f={dir,store,db};fixtures.push(f);return f;}
function start(f:ReturnType<typeof fixture>){const s=f.store.createSession();f.store.searchMode(s.id,'off');f.store.selectManual(s.id,'model_01');f.store.submit(s.id,'Hi.');f.store.commitRoute(s.id,null,'fixture',null);const r=f.store.startChat(f.store.prepareChat(s.id,'first').id);f.store.finishReply(r.request.id,r.bubble.id,'Hello.',{});return s.id;}
function seed(f:ReturnType<typeof fixture>,id:string,turns:number){const insert=f.db.prepare('INSERT INTO messages(id,session_id,sequence,role,origin,content,delivery) VALUES(?,?,?,?,?,?,?)');f.db.transaction(()=>{for(let i=1;i<turns;i++){insert.run('u'+i,id,i*2,'user','learner','Hi.','complete');f.db.prepare('INSERT INTO message_times SELECT ?,sent_at_utc,timezone,utc_offset_minutes FROM message_times LIMIT 1').run('u'+i);insert.run('a'+i,id,i*2+1,'assistant','model','Hello.','complete');}})();}
function oldSnapshot(){const current=grammarSnapshot(),g=oldGrammar.grammar;return {...current,version:g.contract_version,parameters:structuredClone(g.request_parameters),timeout_seconds:g.transport.timeout_seconds};}
it('shares exact independent UTF-8, cumulative, turn and warning boundaries',()=>{
 for(const n of [5999,6000,6001])expect(conversationBudget([], '한글😀'+'x'.repeat(n-10)).allowed).toBe(n<=6000);
 for(const n of [47999,48000,48001])expect(conversationBudget([message('x'.repeat(n-1))],'x').allowed).toBe(n<=48000);
 for(const n of [159999,160000,160001])expect(conversationBudget([message('x'.repeat(n-1),0,'assistant')],'x').allowed).toBe(n<=160000);
 for(const n of [511,512,513])expect(conversationBudget(Array.from({length:n},(_,i)=>message('x',i)),'x').allowed).toBe(n<512);
 expect(conversationBudget(Array.from({length:410},(_,i)=>message('x',i))).near).toBe(true);
 expect(conversationBudget([message('x'.repeat(38400))]).near).toBe(true);
 expect(conversationBudget([message('x'.repeat(128000),0,'assistant')]).near).toBe(true);
 expect(conversationBudget([message('x'.repeat(38400))],'x'.repeat(6001)).reason).toBe('message_limit');
});
it('transactional Send crosses the old cap, preserves rejected draft, accepts turn 512 and keeps End usable',()=>{
 const f=fixture(),id=start(f);seed(f,id,511);
 f.store.saveDraft(id,'한'.repeat(2000)+'x');expect(()=>f.store.submit(id,'한'.repeat(2000)+'x')).toThrow('message_limit');expect(f.store.session(id).draft).toBe('한'.repeat(2000)+'x');
 f.store.submit(id,'Last message');const r=f.store.startChat(f.store.prepareChat(id,'last').id);f.store.finishReply(r.request.id,r.bubble.id,'Goodbye.',{});
 f.store.saveDraft(id,'Keep this draft');expect(()=>f.store.submit(id,'Keep this draft')).toThrow('turn_limit');
 // Escaping /end is ordinary learner content and must not bypass admission.
 expect(()=>f.store.submit(id,'//end')).toThrow('turn_limit');expect(f.store.session(id).draft).toBe('Keep this draft');
 f.store.end(id,'Keep this draft');expect(f.store.session(id).state).toBe('ended');expect(f.store.messages(id).filter(m=>m.origin==='learner')).toHaveLength(512);
});
it('recent help excludes old pairs, drops whole oversized context and handles the opening',()=>{
 const m=Array.from({length:10},(_,i)=>message('text'+i,i,i%2?'assistant':'user'));
 expect(genieRecentMessages(m)).toEqual(m.slice(-6).map(({role,content})=>({role,content})));
 expect(genieRecentMessages([{...message('Opening',0,'assistant'),origin:'starter'}])).toEqual([{role:'assistant',content:'Opening'}]);
 expect(genieRecentMessages([])).toEqual([]);
 const large=[message('u',0),message('a'.repeat(15000),1,'assistant'),message('u',2),message('a'.repeat(15000),3,'assistant')];expect(genieRecentMessages(large)).toHaveLength(2);
 expect(()=>genieRecentMessages([message('x'.repeat(6000)),message('x'.repeat(20000),1,'assistant')])).toThrow('genie_context_limit');
 expect(genieRecentMessages([message('pending')])).toEqual([]);
});
it('new grammar uses maximum output while v2 retains its exact parameters and deadline',()=>{
 const current=grammarSnapshot(),old=oldSnapshot();expect(current.version).toBe('stomylos_grammar_analysis_v3');expect(current.timeout_seconds).toBe(600);
 expect(grammarBody(current,[message('Hi.')]).max_tokens).toBe(128000);expect(grammarBody(old,[message('Hi.')]).max_tokens).toBe(8192);
 expect(()=>grammarBody({...old,timeout_seconds:600},[])).toThrow('unsupported_grammar_settings');
 expect(()=>grammarBody({...current,parameters:old.parameters},[])).toThrow('unsupported_grammar_settings');
});
it.each([false,true])('coordinator dispatches the saved grammar deadline (legacy=%s)',async legacy=>{
 const f=fixture(),id=start(f);f.store.end(id);const snapshot=legacy?oldSnapshot():grammarSnapshot();f.db.prepare('UPDATE sessions SET grammar_config=? WHERE id=?').run(JSON.stringify(snapshot),id);
 const source=f.store.messages(id).filter(m=>m.origin==='learner');const content=JSON.stringify({units:source.map((m,index)=>({index,corrected_text:m.content,explanation:''}))});
 const complete=vi.fn(async()=>({content,metadata:{}}));const gateway={complete,stream:vi.fn()} as unknown as Gateway;
 const client={ready:Promise.resolve(),call:async(method:StoreMethod,...args:any[])=>(f.store[method] as Function).apply(f.store,args)} as unknown as DatabaseClient;
 const coordinator=new Coordinator(client,gateway,{keyPresent:true,keyPath:'',dataPath:f.dir,appVersion:'test',development:true},()=>{},()=>true);
 // Isolate manual grammar from unrelated End memory scheduling.
 const request=f.store.createRequest(id,'grammar',snapshot);
 await (coordinator as any).analyze(request,new AbortController().signal);
 expect(complete).toHaveBeenCalledOnce();expect(complete.mock.calls[0]).toHaveLength(5);expect((complete.mock.calls[0] as unknown[])[3]).toBe(legacy?120000:600000);
 expect(f.store.session(id).analysis_state).toBe('completed');
});
it('v41 admission preserves frozen rows, rolls back failure, restarts and becomes a no-op',()=>{
 const f=fixture(),id=start(f);f.store.end(id);const old=JSON.stringify(oldSnapshot());f.db.prepare('UPDATE sessions SET grammar_config=? WHERE id=?').run(old,id);f.db.pragma('user_version=41');
 const exec=f.db.exec.bind(f.db);const fault=vi.spyOn(f.db,'exec').mockImplementation(sql=>{const result=exec(sql);if(sql.includes('Admit grammar v3'))throw Error('injected admission fault');return result;});
 expect(()=>migrateDatabase(f.db,f.dir)).toThrow('injected admission fault');fault.mockRestore();expect(f.db.pragma('user_version',{simple:true})).toBe(41);
 const path=join(f.dir,'stomylos.pre-migration-v41.sqlite3'),backup=readFileSync(path);migrateDatabase(f.db,f.dir);expect(f.db.pragma('user_version',{simple:true})).toBe(currentSchema);
 expect(f.db.prepare('SELECT grammar_config FROM sessions WHERE id=?').pluck().get(id)).toBe(old);
 migrateDatabase(f.db,f.dir);expect(readFileSync(path)).toEqual(backup);expect(f.db.pragma('integrity_check',{simple:true})).toBe('ok');
});

it('help remains available after 24 turns and coordinator projects only recent pairs',async()=>{
 const f=fixture(),id=start(f);seed(f,id,30);f.store.saveDraft(id,'Draft');
 const client={ready:Promise.resolve(),call:async(method:StoreMethod,...args:any[])=>(f.store[method] as Function).apply(f.store,args)} as unknown as DatabaseClient;
 const coordinator=new Coordinator(client,{complete:vi.fn(),stream:vi.fn()} as unknown as Gateway,{keyPresent:true,keyPath:'',dataPath:f.dir,appVersion:'test',development:true},()=>{},()=>true);
 (coordinator as any).drafts.set(id,{text:'Draft',revision:1});
 const source=await (coordinator as any).genieSource(id,'Draft',1);expect(source.messages).toHaveLength(6);
 expect(source.contextHash).toBe(hash(JSON.stringify([f.store.view(id).session.opening_kind,f.store.view(id).session.opening_revision,f.store.messages(id)])));
 expect(dadouchosSource(f.store.view(id)).messages).toHaveLength(6);
});
