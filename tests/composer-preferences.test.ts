import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { Store } from '../src/main/database';
let dir:string,store:Store,db:Database.Database;
beforeEach(()=>{dir=mkdtempSync('/tmp/stomylos-composer-preferences-');store=new Store(dir,resolve('native/advisory-lock.node'));db=(store as any).db;});
afterEach(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
const pref=()=>({search:db.prepare('SELECT mode FROM search_preferences').pluck().get(),reply:db.prepare('SELECT mode FROM reply_preferences').pluck().get()});
it('remembers both choices before any send, survives restart, and never rewrites prior chats',()=>{
 const s=store.createSession();expect(pref()).toEqual({search:'auto',reply:'one_point'});
 store.searchMode(s.id,'off');store.setReplyContext(s.id,'choice',0,'standard');
 expect(pref()).toEqual({search:'off',reply:'standard'});expect(store.messages(s.id).filter(m=>m.origin==='learner')).toEqual([]);
 store.end(s.id);const original=store.session(s.id);store.close();store=new Store(dir,resolve('native/advisory-lock.node'));db=(store as any).db;
 const next=store.createSession();expect(next.search_mode).toBe('off');expect(store.replyContextView(next.id).mode).toBe('standard');
 store.searchMode(next.id,'auto');store.setReplyContext(next.id,'later',0,'one_point');expect(store.session(s.id)).toEqual(original);
 // An old acknowledgement must not reapply its choice to the newer preference.
 store.setReplyContext(s.id,'choice',0,'standard');expect(pref()).toEqual({search:'auto',reply:'one_point'});
 store.end(next.id);const newest=store.createSession();expect(newest.search_mode).toBe('auto');expect(store.replyContextView(newest.id).mode).toBe('one_point');
});
it('rolls back both session and preference when either preference save fails',()=>{
 const s=store.createSession(),snapshot=store.session(s.id);const prepare=db.prepare.bind(db);
 const fault=vi.spyOn(db,'prepare').mockImplementation(sql=>{if(sql.startsWith('UPDATE search_preferences')||sql.startsWith('UPDATE reply_preferences'))throw new Error('save fault');return prepare(sql);});
 expect(()=>store.searchMode(s.id,'off')).toThrow('save fault');
 expect(()=>store.setReplyContext(s.id,'choice',0,'standard')).toThrow('save fault');fault.mockRestore();
 expect(store.session(s.id)).toEqual(snapshot);expect(pref()).toEqual({search:'auto',reply:'one_point'});
});
it('remembers Web search changes during a chat while Lighter stays locked and frozen turns stay unchanged',()=>{
 const s=store.createSession();store.searchMode(s.id,'off');store.selectManual(s.id,'model_04');
 store.submit(s.id,'First user message.');store.commitRoute(s.id,null,'fixture',null);
 const r=store.prepareChat(s.id,randomUUID()),bubble=store.prepareReply(s.id,r.id);store.dispatch(r.id);store.finishReply(r.id,bubble.id,'A short answer.',{});
 const history=store.searchView(s.id);store.searchMode(s.id,'auto');expect(store.searchView(s.id)).toEqual(history);
 expect(()=>store.setReplyContext(s.id,'locked',0,'standard')).toThrow('reply_context_frozen');
 expect(pref()).toEqual({search:'auto',reply:'one_point'});
 store.end(s.id);store.cancelEnd(s.id);expect(store.createSession().search_mode).toBe('auto');
});
it('Send does not rewrite remembered defaults from an existing unchanged session',()=>{
 const s=store.createSession();
 // Simulate a saved default different from the open chat; Send must not copy it back.
 db.prepare("UPDATE reply_preferences SET mode='standard'").run();db.prepare("UPDATE search_preferences SET mode='off'").run();
 store.submit(s.id,'An unchanged session.');expect(pref()).toEqual({search:'off',reply:'standard'});
});
