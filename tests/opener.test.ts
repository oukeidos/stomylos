import { conversationSnapshot, routerBody, routerSnapshot } from '../src/main/contracts';
import { validateRecovery, recoverySnapshot } from '../src/main/router-recovery';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/main/database';
import { openerBody, openerBridge, openerIdentity, openerVersion } from '../src/main/opener';
import { replyContext } from '../src/main/reply-context';
import { validateCommand } from '../src/main/ipc';
import { Coordinator } from '../src/main/coordinator';
import { AppFailure } from '../src/main/errors';
import type { DatabaseClient } from '../src/main/db-client';
import type { Json } from '../src/shared/types';
let dir: string, store: Store;
beforeEach(() => { dir=mkdtempSync(join(tmpdir(),'opener-')); store=new Store(dir,'isolated' as const); });
afterEach(() => { store.close(); rmSync(dir,{recursive:true,force:true}); });
const raw=()=> (store as any).db;
function prepare(id:string, op=randomUUID()) { return store.prepareOpener(id,op,store.session(id).opening_revision)!; }
function success(id:string, text='I tried making bread today. It came out very flat.') {
  const a=prepare(id); store.dispatchOpener(a.id); store.receiveOpener(a.id,text,{usage:{cost:0.01}}); store.acceptOpener(a.id); return a;
}
it('starts Off with no corpus draw and freezes a single successful source across show/hide/restart', () => {
  const s=store.createSession(); expect(s.opening_kind).toBe('user'); expect(store.messages(s.id)).toEqual([]);
  expect(raw().prepare('SELECT COUNT(*) n FROM starter_events').get().n).toBe(0);
  const a=success(s.id), message=store.messages(s.id)[0];
  expect(()=>prepare(s.id)).toThrow('opener_already_generated');
  store.setOpening(s.id,'hide',store.session(s.id).opening_revision,'user'); expect(store.messages(s.id)).toEqual([]);
  store.close(); store=new Store(dir,'isolated' as const);
  store.setOpening(s.id,'show',store.session(s.id).opening_revision,'starter'); expect(store.messages(s.id)).toEqual([message]);
  expect(raw().prepare('SELECT COUNT(*) n FROM starter_events').get().n).toBe(1);
  expect(store.requestHistory(s.id).find(x=>x.id===a.id)).toMatchObject({kind:'Conversation opener',status:'succeeded'});
});
it('rejects duplicate/stale generation and retries failures with the same frozen question', () => {
  const s=store.createSession(), op=randomUUID(), a=prepare(s.id,op);
  expect(store.prepareOpener(s.id,op,0)).toBeNull(); expect(()=>prepare(s.id)).toThrow('reply_in_progress');
  expect(()=>store.submit(s.id,'Hello')).toThrow('reply_in_progress');
  store.dispatchOpener(a.id); store.failOpener(a.id,'failed',{});
  expect(()=>store.prepareOpener(s.id,'stale',0)).toThrow('opening_changed');
  const b=prepare(s.id); expect(b.body).toEqual(a.body);
  expect(raw().prepare('SELECT COUNT(*) n FROM starter_events').get().n).toBe(1);
});
it('recovers received results locally and interrupts dispatched attempts without replay', () => {
  const s=store.createSession(), a=prepare(s.id);store.dispatchOpener(a.id);
  store.close();store=new Store(dir,'isolated' as const);
  expect(store.openerView(s.id)?.status).toBe('interrupted');
  const b=prepare(s.id);store.dispatchOpener(b.id);store.receiveOpener(b.id,'A quiet morning feels nice.',{});
  expect(()=>prepare(s.id)).toThrow('reply_in_progress');
  store.close();store=new Store(dir,'isolated' as const);
  expect(store.openerView(s.id)).toMatchObject({generated:true,status:'succeeded'});
  expect(store.messages(s.id)[0].content).toBe('A quiet morning feels nice.');
});
it.each(['standard','one_point'] as const)('transfers only the visible opener with role order and source accounting (%s)', mode=>{
  const s=store.createSession(); store.setReplyContext(s.id,'style',0,mode);success(s.id);
  const accepted=store.messages(s.id)[0].content;
  const source=JSON.parse(raw().prepare('SELECT question FROM conversation_openers WHERE session_id=?').get(s.id).question);
  store.searchMode(s.id,'off');
  store.submit(s.id,'That happened to me too.',undefined,1);
  store.commitRoute(s.id,null,'test',null);
  const request=store.prepareChat(s.id,randomUUID());
  const now=store.session(s.id), body=store.chatBody(request.id);
  const prefix=mode==='one_point'?4:0;
  expect(body.messages.slice(1+prefix).map((x:Json)=>x.role)).toEqual(['user','assistant','user']);
  expect(body.messages[1+prefix].content).toBe(openerBridge+accepted);
  expect(JSON.stringify(body.messages)).not.toContain(source.text);
  expect(raw().prepare('SELECT answer_count FROM starter_catalog_entries WHERE question_id=?').get(source.id).answer_count).toBe(1);
  expect(()=>store.setOpening(s.id,'late',now.opening_revision,'user')).toThrow('opening_is_frozen');
});
it('hidden success sends directly, never consumes the source, and new conversations reset',()=>{
  const s=store.createSession(); success(s.id);
  store.setOpening(s.id,'hide',store.session(s.id).opening_revision,'user');store.submit(s.id,'My own topic');
  const now=store.session(s.id);expect(now.starter_text).toBeNull();expect(store.messages(s.id).map(x=>x.origin)).toEqual(['learner']);
  expect(raw().prepare('SELECT SUM(answer_count) n FROM starter_catalog_entries').get().n).toBe(0);
});
it('pins the exact no-memory prompt/prefix and validates explicit IPC',()=>{
  const body=openerBody('A source question?');expect(body.messages).toHaveLength(6);
  expect(body.messages[0].content).toBe(readFileSync('../experiments/EXP-037-conversation-opener/prompt-r014.txt','utf8'));
  expect(body.messages.slice(1,5)).toEqual(JSON.parse(readFileSync('src/main/reply-context-seed-v1.json','utf8')));
  expect(body.messages.at(-1).content).toBe('<starting_question>\nA source question?\n</starting_question>');
  validateCommand('generateOpener',{sessionId:'one',operationId:'two',expectedRevision:0});
  expect(()=>validateCommand('generateOpener',{sessionId:'one',operationId:'two',expectedRevision:-1})).toThrow();
});
it('uses shared provider dispatch and save-only recovery without repeating inference', async()=>{
  const s=store.createSession();let rejectSave=true;
  const db={ready:Promise.resolve(),call:async(method:string,...args:any[])=>{
    if(method==='receiveOpener' && rejectSave) { rejectSave=false;throw new AppFailure('operation_failed'); }
    return (store as any)[method](...args);
  }} as unknown as DatabaseClient;
  const complete=vi.fn(async(_body:Json)=>({content:'I made some bread today.',metadata:{usage:{cost:0.01}}}));
  const coord=new Coordinator(db,{complete:vi.fn(),stream:complete} as any,{keyPresent:true} as any,()=>{},()=>true);
  await coord.command('generateOpener',{sessionId:s.id,operationId:'run',expectedRevision:0});
  await vi.waitFor(async()=>expect((await coord.snapshot()).activity.storageError).toBe('operation_failed'));
  expect(complete).toHaveBeenCalledTimes(1);
  await coord.command('retrySaving',undefined);
  await vi.waitFor(()=>expect(store.openerView(s.id)?.generated).toBe(true));
  expect(complete).toHaveBeenCalledTimes(1);
  expect(complete.mock.calls[0][0]).toEqual(openerBody(JSON.parse(raw().prepare('SELECT question FROM conversation_openers').get().question).text));
});

it('deletes private retry evidence and renews eligibility only in a new conversation',()=>{
  const s=store.createSession(),a=prepare(s.id);store.failOpener(a.id,'failure',{});success(s.id);
  store.end(s.id); if(store.endBlocker()) store.cancelEnd(s.id);
  store.deleteSession(s.id);
  expect(raw().prepare('SELECT * FROM opener_attempts').all()).toEqual([]);
  expect(raw().prepare('SELECT * FROM conversation_openers').all()).toEqual([]);
  const next=store.createSession();expect(next.id).not.toBe(s.id);
  expect(store.openerView(next.id)).toMatchObject({generated:false,status:'empty'});
  expect(store.integrity().foreignKeys).toEqual([]);
});

it('routes visible openers as assistant openings while retaining direct and legacy starter contracts',()=>{
  const legacy=conversationSnapshot('starter'), saved={...legacy,opener_version:openerVersion};
  const old=routerBody('An old question?','An answer.',legacy);
  const body=routerBody('I made bread.','I like bread.',saved);
  expect(body.messages[0].content).toBe(old.messages[0].content.replace("Use the starter question and the user's first answer.","Use the assistant's opening and the user's first reply."));
  expect(JSON.parse(body.messages[1].content)).toEqual({assistant_opening:'I made bread.',user_reply:'I like bread.'});
  expect(JSON.parse(old.messages[1].content)).toEqual({starter_question:'An old question?',learner_answer:'An answer.'});
  const direct=conversationSnapshot('user');
  expect(routerBody(null,'Hello',{...direct,opener_version:openerVersion})).toEqual(routerBody(null,'Hello',direct));
  expect(routerSnapshot(saved).version).toBe('stomylos_compact_router_v2_opener');
  expect(routerSnapshot(legacy).version).toBe('stomylos_compact_router_v2_starter');
  validateRecovery(routerSnapshot(saved));validateRecovery(recoverySnapshot(routerSnapshot(saved)));
  const {messages:_,...settings}=body, {messages:__,...oldSettings}=old;
  expect(settings).toEqual(oldSettings);
});
