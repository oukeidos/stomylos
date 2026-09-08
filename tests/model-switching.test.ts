import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { Store } from '../src/main/database';
import { character, conversationBody, conversationComponents, conversationSnapshot, hash, requestPartner, routerScores } from '../src/main/contracts';
import { chooseOtherPartner, partnerRouterBody, partnerRouterSnapshot, recentDialogue } from '../src/main/partner-router';
import { validateCommand } from '../src/main/ipc';
import type { Json, Message } from '../src/shared/types';
import { universalSnapshot, v5Snapshot } from './time-fixtures';

let directory: string, store: Store, raw: Database.Database;
const native = resolve('native/advisory-lock.node');
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'stomylos-switch-')); store = new Store(directory, native); raw = (store as unknown as { db: Database.Database }).db; });
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
function start(snapshot?: Json) {
  const s = store.createSession();
  if (snapshot) raw.prepare('UPDATE sessions SET chat_config=? WHERE id=?').run(JSON.stringify(snapshot), s.id);
  store.searchMode(s.id, 'off'); store.selectManual(s.id, 'model_01'); store.submit(s.id, 'An original user turn.');
  store.commitRoute(s.id, null, 'public-fixture', null); return s.id;
}
function complete(id: string, kind: 'send' | 'retry' | 'different_model' = 'send') {
  const request = store.prepareChat(id, randomUUID(), kind), body = store.chatBody(request.id), bubble = store.prepareReply(id, request.id);
  store.dispatch(request.id); store.finishReply(request.id, bubble.id, 'An ordinary answer.', {});
  return { request, body };
}
function select(id: string, target: string | null) { const revision = store.view(id).partner.revision; const operationId = randomUUID(); store.changePartner(id, target, operationId, revision); return { revision, operationId }; }
function failChat(id: string) {
  const request = store.prepareChat(id, randomUUID(), 'send'), body = store.chatBody(request.id);
  store.prepareReply(id, request.id); store.dispatch(request.id); store.failRequest(request.id, 'request_timeout', 'Failed partial', {}); return { request, body };
}

it('keeps A→B→A in one transcript with immutable originals, source IDs and memory', () => {
  const id = start(), a = complete(id), original = store.session(id).chat_config, initialRoute = raw.prepare('SELECT * FROM route_decisions').all();
  const memory = store.view(id).memory.snapshot, first = store.messages(id);
  store.saveDraft(id, 'Preserved draft'); select(id, 'model_04');
  expect(store.requests(id)).toHaveLength(1); expect(store.session(id).draft).toBe('Preserved draft');
  expect(store.view(id).partner.currentCharacter).toBe('model_01');
  store.submit(id, 'Another user turn.'); const b = complete(id);
  expect(b.body.model).toBe(character('model_04').model);
  expect(b.body.messages.slice(-3)).toEqual([{role:'user',content:'An original user turn.'},{role:'assistant',content:'An ordinary answer.'},{role:'user',content:'Another user turn.'}]);
  expect(b.body.messages[0].content.split('<application_time_context>')[0]).toBe(a.body.messages[0].content.split('<application_time_context>')[0]);
  select(id, 'model_01'); store.submit(id, 'An original user turn.'); const again = complete(id);
  expect(again.body.model).toBe(a.body.model); expect(store.messages(id).slice(0,first.length)).toEqual(first);
  expect(store.sessions()).toHaveLength(1); expect(store.messages(id).filter(m=>m.role==='user')).toHaveLength(3);
  expect(store.session(id).chat_config).toBe(original); expect(store.session(id).character).toBe('model_01');
  expect(raw.prepare('SELECT * FROM route_decisions').all()).toEqual(initialRoute);
  expect(store.view(id).memory.snapshot).toEqual(memory); expect(store.memoryJob(id)).toBeNull();
  for (const request of store.requests(id)) expect(hash(request.config)).toBe(request.config_hash);
  store.end(id);
  const grammar = store.createRequest(id,'grammar',JSON.parse(store.session(id).grammar_config!)); store.dispatch(grammar.id);
  const users=store.messages(id).filter(m=>m.role==='user');
  store.saveAnalysis(grammar.id,JSON.stringify({units:users.map((m,index)=>({index,corrected_text:m.content,explanation:''}))}),{});
  expect(store.units(id).map(u=>u.source_message_id)).toEqual(users.map(m=>m.id));
  expect(store.units(id)).toHaveLength(3); expect(store.integrity().foreignKeys).toEqual([]);
});

it('retries the original failed model despite a pending choice, then creates a distinct replacement root', () => {
  const id = start(), a = failChat(id); select(id, 'model_04');
  const retry = store.prepareChat(id, randomUUID(), 'retry'); expect(store.chatBody(retry.id)).toEqual(a.body);
  expect(retry.parent_id).toBe(a.request.id); expect(retry.config).toBe(a.request.config);
  store.prepareReply(id,retry.id); store.dispatch(retry.id); store.failRequest(retry.id,'request_timeout','Second partial',{});
  store.preparePartner(id,'different_model',randomUUID());
  const b=store.prepareChat(id,randomUUID(),'different_model'), body=store.chatBody(b.id);
  expect(b.parent_id).toBeNull(); expect(JSON.parse(b.config).request_partner.supersedes_request_id).toBe(retry.id);
  expect(body.model).toBe(character('model_04').model); expect(body.messages.slice(1)).toEqual(a.body.messages.slice(1));
  expect(store.messages(id).filter(m=>m.role==='user')).toHaveLength(1);
  expect(store.request(a.request.id).response_content).toBe('Failed partial');
  expect(raw.prepare('SELECT count(*) n FROM message_times').get()).toEqual({n:1});
  expect(raw.prepare('SELECT count(*) n FROM search_turns').get()).toEqual({n:1});
  expect(JSON.parse(b.config).memory_context).toEqual(JSON.parse(a.request.config).memory_context);
  const bubble=store.prepareReply(id,b.id);store.dispatch(b.id);store.failRequest(b.id,'request_timeout','',{});
  expect(store.view(id).partner.currentCharacter).toBe('model_04');
  const next=select(id,null);expect(next.revision).toBeGreaterThan(0);
  const route=store.preparePartner(id,'different_model',randomUUID())!;
  expect(JSON.parse(route.config).excluded_model).toBe(character('model_04').model);
  expect(bubble.request_id).toBe(b.id);
});

it('freezes recent Auto input once, excludes the current model and preserves the decision through reply failure', () => {
  const id=start(); complete(id);
  for(let i=0;i<3;i++){store.submit(id,`Topic ${i}.`);complete(id);}
  select(id,null); expect(store.requests(id).filter(r=>r.role==='router')).toHaveLength(0);
  store.submit(id,'Actually, explain this new question.');
  const route=store.preparePartner(id,'send',randomUUID())!, snapshot=JSON.parse(route.config);
  expect(partnerRouterBody(snapshot).messages[1].content).not.toContain('An original user turn');
  expect(JSON.parse(snapshot.input).filter((m:Json)=>m.role==='user')).toHaveLength(3);
  expect(JSON.parse(snapshot.input).at(-1).content).toBe('Actually, explain this new question.');
  expect(store.preparePartner(id,'send',randomUUID())!.id).toBe(route.id);
  store.dispatch(route.id);
  const scores=Object.fromEntries(conversationSnapshot().characters.map((c:Json)=>[c.id,c.id==='model_01'?2:1]));
  store.finishPartnerRoute(route.id,JSON.stringify(scores),{});
  expect(store.preparePartner(id,'send',randomUUID())).toBeNull();
  const request=store.prepareChat(id,randomUUID(),'send');expect(store.chatBody(request.id).model).not.toBe(character('model_01').model);
  store.prepareReply(id,request.id);store.dispatch(request.id);store.failRequest(request.id,'request_timeout','',{});
  const retry=store.prepareChat(id,randomUUID(),'retry');expect(retry.config).toBe(request.config);
  expect(store.requests(id).filter(r=>r.role==='router')).toHaveLength(1);
});

it('restores pending local choices and interrupted Auto without dispatch or original-row mutation', () => {
  const id=start(); complete(id);select(id,null);store.close();store=new Store(directory,native);
  expect(store.view(id).partner.pending).toMatchObject({choice:null,state:'pending'});
  store.submit(id,'New source.');const route=store.preparePartner(id,'send',randomUUID())!;store.dispatch(route.id);
  store.close();store=new Store(directory,native);expect(store.view(id).partner.pending?.state).toBe('failed');
  expect(()=>store.preparePartner(id,'send',randomUUID())).toThrow('partner_selection_failed');
  const retry=store.preparePartner(id,'retry_selection',randomUUID())!;
  expect(retry.config).toBe(route.config);expect(retry.parent_id).toBe(route.id);
  store.dispatch(retry.id);store.failRequest(retry.id,'router_schema');
  select(id,'model_03');store.preparePartner(id,'different_model',randomUUID());complete(id,'different_model');
  expect(store.messages(id).filter(m=>m.role==='user')).toHaveLength(2);
  store.end(id);store.deleteSession(id);expect(store.integrity().foreignKeys).toEqual([]);
});

it.each([v5Snapshot(),universalSnapshot(true),universalSnapshot(false)])('retains historical memory ownership and exact prompt while switching saved rosters', snapshot=>{
  const id=start(snapshot);const a=complete(id);select(id,'model_04');store.submit(id,'Continue.');const b=complete(id);
  expect(a.body.messages[0].content.split('<application_time_context>')[0]).toBe(b.body.messages[0].content.split('<application_time_context>')[0]);
  expect(b.body.model).toBe(character('model_04',snapshot).model);
  expect(()=>select(id,'model_08')).toThrow('invalid_character');
  expect(()=>partnerRouterSnapshot(snapshot,store.messages(id),b.body.model)).not.toThrow();
});

it('keeps legacy request configs without a binding reconstructable after a switch',()=>{
  const id=start(); const a=failChat(id);const old=JSON.parse(a.request.config);delete old.request_partner;
  // Simulate an existing immutable historical row, without weakening production triggers.
  raw.exec('DROP TRIGGER immutable_request_source');raw.prepare('UPDATE model_requests SET config=?,config_hash=? WHERE id=?').run(JSON.stringify(old),hash(JSON.stringify(old)),a.request.id);
  select(id,'model_04');const retry=store.prepareChat(id,randomUUID(),'retry');
  expect(store.chatBody(retry.id)).toEqual(a.body);expect(JSON.parse(retry.config).request_partner).toBeUndefined();
});

it('rejects stale selections, live request changes, completed-answer regeneration and target tampering',()=>{
  const id=start();const a=complete(id);const frozen=store.request(a.request.id);const choice=select(id,'model_04');
  store.changePartner(id,'model_04',choice.operationId,choice.revision);
  expect(()=>store.changePartner(id,'model_03',randomUUID(),choice.revision)).toThrow('partner_selection_changed');
  expect(()=>store.preparePartner(id,'different_model',randomUUID())).toThrow('reply_not_retryable');
  store.submit(id,'Another.');const r=store.prepareChat(id,randomUUID(),'send');
  expect(()=>select(id,'model_03')).toThrow('partner_busy');
  const changed=JSON.parse(r.config);changed.request_partner.target.model='other';
  expect(()=>requestPartner(changed,'model_01')).toThrow('request_partner_changed');
  const sources=store.messages(id).filter(m=>m.sequence<=r.source_sequence);
  expect(()=>conversationBody(JSON.parse(r.config),'model_01',store.session(id).starter_text,sources)).toThrow('request_partner_changed');
  expect(store.request(a.request.id)).toEqual(frozen);
});

it('bounds recent windows by whole groups and rejects invalid score/command data',()=>{
  const messages:Message[]=Array.from({length:8},(_,i)=>({id:`m${i}`,session_id:'s',sequence:i,role:i%2?'assistant':'user',origin:i%2?'model':'learner',delivery:'complete',request_id:null,content:i<6?'가'.repeat(5000):'Latest'}));
  const window=recentDialogue(messages);expect(JSON.parse(window.input)).toEqual([{role:'user',content:'Latest'}]);
  expect(window.message_ids).toEqual(['m6']);
  expect(()=>recentDialogue([{...messages[6],content:'x'.repeat(24001)}])).toThrow('partner_input_limit');
  const saved=conversationSnapshot();const scores=Object.fromEntries(saved.characters.map((c:Json)=>[c.id,2]));
  for(const current of saved.characters)expect(chooseOtherPartner(saved,current.model,scores,{}).model).not.toBe(current.model);
  expect(()=>routerScores('{"model_01":2}',saved)).toThrow('router_schema');
  validateCommand('changePartner',{sessionId:'s',character:null,operationId:'op',expectedRevision:0});
  expect(()=>validateCommand('changePartner',{sessionId:'s',character:null,operationId:'op',expectedRevision:-1})).toThrow('invalid_command');
  const legacy=JSON.parse(readFileSync('src/main/legacy-conversation-config.json','utf8'));
  const old={...legacy.conversation,system_prompt:legacy.conversationPrompt,prompt_sha256:hash(legacy.conversationPrompt)};
  expect(()=>partnerRouterSnapshot(old,[messages[6]],old.characters[0].model)).not.toThrow();
});

it.each(['failed', 'ready'])('carries an unused %s Auto choice to the next Send after original-model Retry succeeds', state => {
  const id = start(); const a = failChat(id); select(id, null);
  const route = store.preparePartner(id, 'different_model', randomUUID())!; store.dispatch(route.id);
  if (state === 'failed') store.failRequest(route.id, 'request_timeout');
  else store.finishPartnerRoute(route.id, JSON.stringify(Object.fromEntries(conversationSnapshot().characters.map((c: Json) => [c.id, 2]))), {});
  expect(store.view(id).partner.canRetryReply).toBe(true);
  const op = store.view(id).partner.pending!.id;
  const retry = complete(id, 'retry'); expect(retry.body).toEqual(a.body);
  const frozen = raw.prepare('SELECT * FROM partner_selection_operations WHERE id=?').get(op) as Json;
  store.submit(id, 'A genuinely new user turn.');
  const next = store.preparePartner(id, 'send', randomUUID())!;
  expect(next.parent_id).toBeNull(); expect(JSON.parse(next.config).selection_operation_id).not.toBe(op);
  expect(JSON.parse(next.config).excluded_model).toBe(a.body.model);
  expect(JSON.parse(JSON.parse(next.config).input).at(-1).content).toBe('A genuinely new user turn.');
  const preserved = raw.prepare('SELECT * FROM partner_selection_operations WHERE id=?').get(op) as Json;
  expect(preserved).toEqual({ ...frozen, state: 'superseded' });
  expect(store.messages(id).filter(m => m.origin === 'learner')).toHaveLength(2);
});

it.each(['conversation-v6-config', 'c-conversation-config', 'legacy-conversation-config'])('switches and retries the supported %s roster without rewriting the saved contract', name => {
  const runtime = JSON.parse(readFileSync(`src/main/${name}.json`, 'utf8'));
  const snapshot: Json = { ...runtime.conversation, system_prompt: runtime.conversationPrompt, prompt_sha256: hash(runtime.conversationPrompt) };
  if (name === 'conversation-v6-config') Object.assign(snapshot, {
    prompt_id: 'stomylos_conversation_prompt_v5',
    memory_version: 'stomylos_memory_context_v2', time_version: 'stomylos_time_context_v1',
    component_hashes: conversationComponents(snapshot.version, 'stomylos_memory_context_v2'),
    opening: { version: 'stomylos_opening_v1', kind: 'starter' }
  });
  const s = store.createSession(); raw.prepare('UPDATE sessions SET chat_config=? WHERE id=?').run(JSON.stringify(snapshot), s.id);
  store.searchMode(s.id, 'off'); store.selectManual(s.id, snapshot.characters[0].id);
  store.submit(s.id, 'An original user source.'); store.commitRoute(s.id, null, 'public-fixture', null); complete(s.id);
  select(s.id, null); store.submit(s.id, 'A new direction.');
  const route = store.preparePartner(s.id, 'send', randomUUID())!; store.dispatch(route.id);
  store.finishPartnerRoute(route.id, JSON.stringify(Object.fromEntries(snapshot.characters.map((c: Json) => [c.id, 2]))), {});
  const changed = failChat(s.id); expect(changed.body.model).not.toBe(snapshot.characters[0].model);
  const retry = complete(s.id, 'retry'); expect(retry.body).toEqual(changed.body);
  expect(store.session(s.id).chat_config).toBe(JSON.stringify(snapshot));
  expect(store.messages(s.id).filter(m => m.origin === 'learner')).toHaveLength(2);
});
