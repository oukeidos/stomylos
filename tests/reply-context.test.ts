import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { Store } from '../src/main/database';
import { conversationBody, conversationSnapshot, grammarBody, grammarSnapshot, routerBody } from '../src/main/contracts';
import { replyContext, replyMode, replyPrefix, replySeedHash } from '../src/main/reply-context';
import { validateCommand } from '../src/main/ipc';
import type { ReplyMode } from '../src/shared/reply-context';
let directory: string, store: Store, db: Database.Database;
beforeEach(() => { directory = mkdtempSync('/tmp/stomylos-reply-context-'); store = new Store(directory, resolve('native/advisory-lock.node')); db = (store as any).db; });
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
function choose(id: string, mode: ReplyMode) { return store.setReplyContext(id, randomUUID(), store.replyContextView(id).revision, mode); }
function direct() { const s = store.createSession(); store.setOpening(s.id, randomUUID(), s.opening_revision, 'user'); return s.id; }
function send(id: string, content = 'I keep listening to the same songs.') { store.searchMode(id,'off'); return store.submit(id, content, randomUUID(), store.replyContextView(id).revision); }
function prepare(id: string) { store.commitRoute(id, null, 'test', null); return store.prepareChat(id, randomUUID()); }
it('pins the exact approved four-message artifact and rejects unknown or malformed envelopes', () => {
  expect(createHash('sha256').update(readFileSync('src/main/reply-context-seed-v1.json')).digest('hex')).toBe(replySeedHash);
  const prefix = replyPrefix({ reply_context: replyContext('one_point') });
  expect(prefix.map(m => m.role)).toEqual(['user','assistant','user','assistant']);
  expect(prefix[2].content).toBe("What if there's a lot to explain?");
  expect(replyMode({})).toBe('standard');
  for (const value of [null, {}, { ...replyContext('one_point'), seed_sha256: 'bad' }, { ...replyContext('standard'), seed_sha256: replySeedHash }, { ...replyContext('standard'), version: 'v2' }]) {
    expect(() => replyMode({reply_context:value})).toThrow('unsupported_reply_context');
  }
  expect(() => conversationBody({...conversationSnapshot(),reply_context:null},'model_01','?',[])).toThrow('unsupported_reply_context');
});
it('remembers saved choices immediately, including abandoned drafts, across restart', () => {
  const id = direct(); expect(store.replyContextView(id)).toMatchObject({ mode:'one_point', canChange:true, revision:0 });
  choose(id,'standard'); store.saveDraft(id,'Unsent words'); store.close(); store = new Store(directory,resolve('native/advisory-lock.node')); db=(store as any).db;
  expect(store.session(id).draft).toBe('Unsent words'); expect(store.replyContextView(id).mode).toBe('standard');
  store.end(id); const next=store.createSession(); expect(store.replyContextView(next.id).mode).toBe('standard');
  choose(next.id,'standard'); send(next.id); expect(store.replyContextView(next.id).canChange).toBe(false);
  store.end(next.id); expect(store.replyContextView(store.createSession().id).mode).toBe('standard');
});
it('enforces selection/send revisions, idempotent receipts, conflicts and permanent locking before a reply', () => {
  const id=direct(), operation=randomUUID();
  const selected=store.setReplyContext(id,operation,0,'standard');
  expect(store.setReplyContext(id,operation,0,'standard')).toEqual(selected);
  expect(() => store.setReplyContext(id,operation,0,'one_point')).toThrow('reply_context_operation_conflict');
  expect(() => store.submit(id,'stale',randomUUID(),0)).toThrow('reply_context_changed');
  expect(store.messages(id)).toEqual([]);
  choose(id,'one_point'); expect(() => store.setReplyContext(id,operation,0,'standard')).toThrow('reply_context_changed');
  const message=send(id); expect(store.submit(id,message.content,message.id,0)).toEqual(message);
  expect(() => choose(id,'standard')).toThrow('reply_context_frozen');
  store.close(); store=new Store(directory,resolve('native/advisory-lock.node')); db=(store as any).db;
  expect(store.replyContextView(id)).toMatchObject({ mode:'one_point',canChange:false,lockReason:'started' });
});
it('rolls back selection and first-submit failures without changing draft, preference or lock', () => {
  const id=direct(); store.saveDraft(id,'Preserved');
  const prepare=db.prepare.bind(db);
  const fault=vi.spyOn(db,'prepare').mockImplementation(sql => { if(sql.startsWith('UPDATE sessions SET chat_config=?,reply_context_revision=')) throw new Error('save fault'); return prepare(sql); });
  expect(()=>choose(id,'standard')).toThrow('save fault'); fault.mockRestore();
  expect(store.replyContextView(id)).toMatchObject({mode:'one_point',revision:0,canChange:true});
  choose(id,'standard');
  const clock=vi.spyOn(store as any,'clock').mockImplementation(()=>{throw new Error('submit fault');});
  expect(()=>send(id)).toThrow('submit fault'); clock.mockRestore();
  expect(store.messages(id)).toEqual([]); expect(store.session(id).draft).toBe('Preserved');
  expect(store.replyContextView(id).canChange).toBe(true); expect(db.prepare('SELECT mode FROM reply_preferences').pluck().get()).toBe('standard');
});
it.each(['starter','user'] as const)('inserts one prefix for %s across all models and excludes synthetic turns from grammar/router/history', kind => {
  const id=kind==='user'?direct():store.createSession().id; const user=send(id), request=prepare(id);
  const snapshot=JSON.parse(request.config), history=store.messages(id), seed=replyPrefix(snapshot);
  for(const partner of snapshot.characters) {
    const candidate={...snapshot}; delete candidate.request_partner;
    const body=conversationBody(candidate,partner.id,store.session(id).starter_text,history);
    expect(body.messages.slice(1,5)).toEqual(seed);
    expect(body.messages.filter((m:any)=>m.content===seed[0].content)).toHaveLength(1);
    const standard={...candidate,reply_context:replyContext('standard')}, legacy={...candidate}; delete legacy.reply_context;
    expect(conversationBody(standard,partner.id,store.session(id).starter_text,history)).toEqual(conversationBody(legacy,partner.id,store.session(id).starter_text,history));
  }
  expect(history.some(m=>seed.some(s=>s.content===m.content))).toBe(false);
  expect(JSON.stringify(grammarBody(grammarSnapshot(),history))).not.toContain('What are your values?');
  expect(JSON.stringify(routerBody(store.session(id).starter_text,user.content,JSON.parse(store.session(id).chat_config)))).not.toContain('What are your values?');
  store.failRequest(request.id,'http_429');
  const retry=store.prepareChat(id,randomUUID(),'retry');
  expect(JSON.parse(retry.config).reply_context).toEqual(snapshot.reply_context);
  expect(store.chatBody(retry.id).messages.slice(1,5)).toEqual(seed);
  expect(store.replyContextView(id).canChange).toBe(false);
});
it('keeps historical chats Standard and allows explicit independent selection on an unsent legacy draft', () => {
  const id=direct(); const saved=JSON.parse(store.session(id).chat_config); delete saved.reply_context;
  db.prepare('UPDATE sessions SET chat_config=? WHERE id=?').run(JSON.stringify(saved),id);
  expect(store.replyContextView(id).mode).toBe('standard');
  choose(id,'one_point'); const changed=JSON.parse(store.session(id).chat_config); delete changed.reply_context;
  expect(changed).toEqual(saved);
  choose(id,'standard'); send(id); store.end(id);
  expect(store.replyContextView(id)).toMatchObject({mode:'standard',canChange:false});
});
it('validates selection and send revision IPC arguments', () => {
  expect(()=>validateCommand('setReplyContext',{sessionId:'test',operationId:'op',expectedRevision:0,mode:'one_point'})).not.toThrow();
  expect(()=>validateCommand('setReplyContext',{sessionId:'test',operationId:'op',expectedRevision:-1,mode:'one_point'})).toThrow();
  expect(()=>validateCommand('sendMessage',{sessionId:'test',text:'hi',revision:0,expectedReplyContextRevision:2})).not.toThrow();
});
it('keeps one seed through later turns, a model change and memory preference changes', () => {
  const id=direct(); store.selectManual(id,'model_04'); send(id); const first=prepare(id);
  const firstBody=store.chatBody(first.id), bubble=store.prepareReply(id,first.id);
  store.dispatch(first.id);store.finishReply(first.id,bubble.id,'A familiar song can be comforting.',{});
  store.changePartner(id,'model_03',randomUUID(),store.view(id).partner.revision);
  send(id,'Why do familiar things feel comforting?');const second=store.prepareChat(id,randomUUID());
  const body=store.chatBody(second.id); expect(body.model).not.toBe(firstBody.model);
  expect(body.messages.slice(1,5)).toEqual(firstBody.messages.slice(1,5));
  expect(body.messages.filter((m:any)=>m.content.includes('What are your values?'))).toHaveLength(1);
  store.setMemoryPreference(false,store.memoryPreference().revision);
  const started=store.startChat(second.id);
  expect(started.body.messages.slice(1,5)).toEqual(firstBody.messages.slice(1,5));
  expect(JSON.parse(started.request.config).reply_context).toEqual(JSON.parse(first.config).reply_context);
});
it('retains explicitly selected context when first preparation rebuilds an old memory wrapper', async () => {
  const { v5Snapshot }=await import('./time-fixtures');
  const id=direct(), legacy=v5Snapshot('user');
  db.prepare('UPDATE sessions SET chat_config=? WHERE id=?').run(JSON.stringify(legacy),id);
  choose(id,'one_point');store.selectManual(id,'model_04');send(id);const request=prepare(id);
  expect(JSON.parse(request.config).reply_context).toEqual(replyContext('one_point'));
  expect(JSON.parse(store.session(id).chat_config).reply_context).toEqual(replyContext('one_point'));
  expect(store.chatBody(request.id).messages.slice(1,5)).toEqual(replyPrefix({reply_context:replyContext('one_point')}));
});
it('does not let an unchanged legacy draft overwrite the next-chat default', () => {
  const id=direct(), legacy=JSON.parse(store.session(id).chat_config);delete legacy.reply_context;
  db.prepare('UPDATE sessions SET chat_config=? WHERE id=?').run(JSON.stringify(legacy),id);
  send(id);store.end(id);
  expect(store.replyContextView(store.createSession().id).mode).toBe('one_point');
});
