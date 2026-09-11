import { prepareProviderRequest } from '../src/main/provider-policy';
import sevenRuntime from '../src/main/conversation-v7-config.json';
import { flat, splitDelta } from './flat-memory-fixtures';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Coordinator } from '../src/main/coordinator';
import { Store, type StoreMethod } from '../src/main/database';
import type { DatabaseClient } from '../src/main/db-client';
import type { Gateway } from '../src/main/transport';
import { CompletionFailure } from '../src/main/transport';
import Database from 'better-sqlite3';
import goldens from './fixtures/contract-goldens.json';
import type { AppSnapshot, Json } from '../src/shared/types';
import { AppFailure } from '../src/main/errors';
import { randomUUID } from 'node:crypto';
import { DictationController } from '../src/main/asr';
import { DictationStore } from '../src/main/asr-store';
import { DictationEncoder } from '../src/main/asr-encoder';
import type { DictationSnapshot } from '../src/shared/asr';
import { grammarSnapshot } from '../src/main/contracts';
import { emptyMemory, memoryHash, memoryJson } from '../src/main/memory-updater';
import { historicalPatternContract, makePatternHistorical } from './pattern-report-history';

let directory: string; let store: Store; let controller: Coordinator;
let calls: Json[]; let snapshots: AppSnapshot[]; let failMethod: string | null;
let holdRouter: boolean;
let routerFails: boolean; let holdStream: boolean; let holdGrammar: boolean;
let grammarFails: boolean; let renewalFails: boolean; let holdRenewal: boolean; let renewalCalls: Json[]; let keyAvailable: boolean; let renewalContent: string | null;
let streamReady: (() => void) | null;
let loseAck: string | null;
let holdPrepare: boolean, releasePrepare: (() => void) | null;
let streamFails: boolean;
let memoryCalls: Json[], memoryFails: boolean, memoryRelease: (() => void) | null;
let lateGrammar: boolean;
let patternCalls: Json[], holdPattern: boolean, latePattern: boolean;
let patternPolicies: { identity: unknown; timeout: number | undefined }[];
let intentionCalls: Json[], intentionFailures: string[], holdIntention: boolean, intentionRelease: (() => void) | null;
let searchCalls: Json[];
let searchPhases: AppSnapshot['activity']['phase'][];
const patternHtml='<!DOCTYPE html><html><head><title>Patterns</title></head><body>No recurring pattern established.</body></html>';
let holdMemory: boolean, memoryOutput: (packet: Json) => string;
const waitFor = async (fn: () => boolean) => { await vi.waitFor(() => expect(fn()).toBe(true), { timeout: 3000, interval: 5 }); };
beforeEach(async () => {
  holdRouter = false;
  intentionCalls = []; intentionFailures = []; holdIntention = false; intentionRelease = null;
  searchCalls = []; searchPhases = [];
  directory = mkdtempSync(join(tmpdir(), 'stomylos-controller-')); store = new Store(directory, resolve('native/advisory-lock.node'));
  patternCalls=[];patternPolicies=[];holdPattern=false;latePattern=false; lateGrammar = false; calls = []; snapshots = []; failMethod = null; loseAck = null; routerFails = false; grammarFails = false; holdStream = false; holdGrammar = false; streamReady = null;
  streamFails = false;
  holdPrepare = false; releasePrepare = null;
  memoryCalls = []; memoryFails = false; memoryRelease = null; holdMemory = false; memoryOutput = () => '{"add":[],"update":[],"delete":[]}';
  renewalCalls = []; renewalFails = false; holdRenewal = false; keyAvailable = true; renewalContent = null;
  const database = {
    ready: Promise.resolve(),
    async call(method: StoreMethod, ...args: any[]) {
      if (failMethod === method) throw new AppFailure('operation_failed');
      const value = (store[method] as Function).apply(store, args);
      if (method === 'prepareChat' && holdPrepare) await new Promise<void>(resolve => { releasePrepare = resolve; });
      if (loseAck === method) { loseAck = null; throw new AppFailure('operation_failed'); }
      return value;
    },
    async close() { store.close(); }
  } as unknown as DatabaseClient;
  const gateway: Gateway = {
    async complete(body, _identity, signal, timeout) {
      if(body.max_tokens===32768 && body.model==='openai/gpt-6-astra') {
        patternCalls.push(body);
        patternPolicies.push({identity:_identity,timeout});
        if(holdPattern) await new Promise<void>((r,j)=>signal.addEventListener('abort',()=>latePattern?r():j(new AppFailure('request_cancelled')),{once:true}));
        return {content:patternHtml,metadata:{usage:{cost:0.25}}};
      }
      if (['stomylos_memory_delta_v1','experimental_database_records_format'].includes(body.response_format?.json_schema.name)) {
        memoryCalls.push(body);
        if (holdMemory) await new Promise<void>((resolve, reject) => { memoryRelease = resolve; signal.addEventListener('abort', () => reject(new AppFailure('request_cancelled')), { once: true }); });
        if (memoryFails) throw new AppFailure('request_timeout');
        return { content: memoryOutput(JSON.parse(body.messages[1].content)), metadata: { model: body.model, usage: { cost: 0.001 } } };
      }
      if (!body.response_format && body.messages[0].content.startsWith('Generate one English conversation-opening question')) {
        intentionCalls.push(body);
        if (holdIntention) await new Promise<void>((resolve, reject) => { intentionRelease = resolve; signal.addEventListener('abort', () => reject(new AppFailure('request_cancelled')), { once: true }); });
        const failure = intentionFailures.shift(); if (failure) throw new AppFailure(failure);
        return { content: `What would help you explore the trip idea ${intentionCalls.length}?`, metadata: { usage: { cost: 0.001 } } };
      }
      if (!body.response_format) {
        renewalCalls.push(body);
        if (renewalFails) throw new AppFailure('request_timeout');
        if (holdRenewal) await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new AppFailure('request_cancelled')), { once: true }));
        return { metadata: { model: body.model, usage: { total_tokens: 40, cost: 0.001 } },
          content: renewalContent ?? `What small invention would improve your day ${renewalCalls.length}?\nWhat would patience look like as a landscape ${renewalCalls.length}?` };
      }
      calls.push(body);
      const router = body.response_format.json_schema.name.startsWith('stomylos_character_scores_v');
      if (router && holdRouter) await new Promise<void>(done => signal.addEventListener('abort', () => done(), { once: true }));
      if (router && routerFails) throw new AppFailure('request_timeout');
      if (!router && grammarFails) throw new AppFailure('response_identity');
      if (!router && holdGrammar) await new Promise<void>((resolve, reject) => signal.addEventListener('abort', () => lateGrammar ? resolve() : reject(new AppFailure('request_cancelled')), { once: true }));
      return { metadata: {}, content: JSON.stringify(router ? Object.fromEntries(body.response_format.json_schema.schema.required.map((id: string) => [id, ['informative_generalist', 'model_03'].includes(id) ? 2 : 1])) :
        { units: JSON.parse(body.messages[1].content).filter((m: Json) => m.role === 'user').map((m: Json) => ({ ...(m.index === undefined ? { text: m.content } : { index: m.index }), corrected_text: m.content, explanation: '' })) }) };
    },
    async stream(body, signal, onText) {
      // Search gates are separate from the conversation/character call accounting below.
      if (body.response_format?.type === 'json_object') { searchCalls.push(body); searchPhases.push(snapshots.at(-1)!.activity.phase); return { content: '{"search":false}', metadata: { usage: { cost: 0.00001 } } }; }
      calls.push(body); onText('Partial response'); streamReady?.();
      if (streamFails) throw new CompletionFailure('response_length_limit', 'Partial response', {
        id: 'public-generation', model: body.model, finish_reason: 'length', usage: { completion_tokens: 8192, completion_tokens_details: { reasoning_tokens: 8000 } }
      });
      if (holdStream) await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new AppFailure('request_cancelled')), { once: true }));
      onText('Complete response.'); return { content: 'Complete response.', metadata: {} };
    }
  };
  controller = new Coordinator(database, gateway, { keyPresent: true, keyPath: '/test/key', dataPath: directory, appVersion: 'test', development: true }, event => {
    if (event.type === 'snapshot') snapshots.push(event.snapshot);
  }, () => keyAvailable);
  await controller.initialize();
});
afterEach(async () => { failMethod = null; store.close(); rmSync(directory, { force: true, recursive: true }); });
const activeId = () => store.sessions().find(s => s.state !== 'ended')!.id;
const send = (id: string, text = 'Exact source.', revision = 1) => controller.command('sendMessage', { sessionId: id, text, revision });
const idle = () => waitFor(() => snapshots.at(-1)?.activity.phase === 'idle');

it.each(['failure', 'lost-ack'])('recovers a bookmark %s through save-only retry with no inference', async mode => {
  const id = activeId(); await send(id); await idle(); keyAvailable = false;
  const messages = store.messages(id), requests = store.requests(id);
  const beforeCalls = [calls.length, searchCalls.length, memoryCalls.length, renewalCalls.length, intentionCalls.length];
  if (mode === 'failure') failMethod = 'setSessionBookmark'; else loseAck = 'setSessionBookmark';
  let completed = false;
  const pending = controller.command('setSessionBookmark', { sessionId: id, bookmarked: true }).then(result => { completed = true; return result; });
  await waitFor(() => !!snapshots.at(-1)?.activity.storageError);
  expect(completed).toBe(false); expect(store.view(id).bookmarked).toBe(mode === 'lost-ack');
  failMethod = null; await controller.command('retrySaving', undefined);
  expect(await pending).toMatchObject({ sessionId: id, bookmarked: true });
  expect(snapshots.at(-1)?.sessions.find(s => s.id === id)?.bookmarked).toBe(true);
  expect(store.messages(id)).toEqual(messages); expect(store.requests(id)).toEqual(requests);
  expect([calls.length, searchCalls.length, memoryCalls.length, renewalCalls.length, intentionCalls.length]).toEqual(beforeCalls);
  await controller.command('setSessionBookmark', { sessionId: id, bookmarked: false });
  expect(store.view(id).bookmarked).toBe(false); await controller.command('close', undefined);
});

function useSeven(id: string) {
  const raw=(store as unknown as {db:Database.Database}).db;
  const saved=JSON.parse(store.session(id).chat_config);
  raw.prepare('UPDATE sessions SET chat_config=? WHERE id=?').run(JSON.stringify({...saved,...structuredClone(sevenRuntime.conversation),router_prompt_version:'stomylos_compact_router_v1'}),id);
}
it('bypasses the new router chain for a manual partner and preserves ordinary retries',async()=>{
  const id=activeId();await controller.command('selectPartner',{sessionId:id,character:'model_09'});
  streamFails=true;await send(id);await idle();expect(routerCalls()).toHaveLength(0);
  expect(chatCalls()[0].model).toBe('deepseek/deepseek-v4.1-flash');
  streamFails=false;await controller.command('retryReply',{sessionId:id});
  await waitFor(()=>chatCalls().length===2);await idle();expect(routerCalls()).toHaveLength(0);expect(chatCalls()[1]).toEqual(chatCalls()[0]);
});

it('marks while a reply streams without stopping or redispatching it', async () => {
  const id = activeId(); holdStream = true; await send(id);
  await waitFor(() => calls.some(c => c.stream));
  const before = calls.length;
  await controller.command('setSessionBookmark', { sessionId: id, bookmarked: true });
  expect(store.view(id).bookmarked).toBe(true); expect(calls).toHaveLength(before);
  expect(snapshots.at(-1)?.activity.phase).not.toBe('idle');
  await controller.command('close', undefined);
});

it('serializes a pending mark before source deletion and rejects any later restoration', async () => {
  const id = activeId(); store.submit(id, 'A source eligible for bookmarking.'); store.end(id);
  const marking = controller.command('setSessionBookmark', { sessionId: id, bookmarked: true });
  const deleting = controller.command('deleteSession', { sessionId: id });
  await marking; await deleting;
  expect(store.sessionPage(0, 'bookmarked').sessions).toEqual([]);
  await expect(controller.command('setSessionBookmark', { sessionId: id, bookmarked: true })).rejects.toThrow('session_not_found');
  expect(calls).toEqual([]); expect(store.integrity().foreignKeys).toEqual([]);
  await controller.command('close', undefined);
});

it.each(['searchPrepare', 'searchDispatch', 'searchFinish'])('retries a lost %s save acknowledgement without duplicate routing or conversation dispatch', async method => {
  const id = activeId(); expect(store.session(id).search_mode).toBe('auto'); loseAck = method;
  await send(id, 'A public conversation.');
  await waitFor(() => !!snapshots.at(-1)?.activity.storageError);
  expect(searchCalls).toHaveLength(method === 'searchFinish' ? 1 : 0);
  expect(calls.filter(c => c.stream)).toHaveLength(0);
  await controller.command('retrySaving', undefined); await idle();
  expect(searchCalls).toHaveLength(1); expect(calls.filter(c => c.stream)).toHaveLength(1);
  expect(store.searchView(id)!.attempts).toHaveLength(1);
  expect(store.searchView(id)!.turn).toMatchObject({ decision: 'primary', permitted: 0 });
  await controller.command('close', undefined);
});

it('enforces the Off control before Send and preserves it through a reply retry', async () => {
  const id = activeId(); await controller.command('searchMode', { sessionId: id, mode: 'off' }); streamFails = true;
  await send(id); await idle(); expect(searchCalls).toHaveLength(0);
  await expect(controller.command('searchMode', { sessionId: id, mode: 'auto' })).rejects.toThrow('search_mode_locked');
  streamFails = false; await controller.command('retryReply', { sessionId: id });
  await waitFor(() => store.messages(id).at(-1)?.delivery === 'complete'); await idle();
  expect(searchCalls).toHaveLength(0); expect(calls.filter(c => c.stream).every(c => !c.tools)).toBe(true);
  await controller.command('searchMode', { sessionId: id, mode: 'auto' });
  await send(id, 'Second message', 2); await idle(); expect(searchCalls).toHaveLength(1);
  await controller.command('close', undefined);
});

it('fails a maximally escaped bounded memory input before network dispatch and leaves no running attempt', async () => {
  const id = activeId(); store.searchMode(id, 'off'); store.setOpening(id, 'bounded-direct', 0, 'user'); store.selectManual(id, 'model_04');
  const document = emptyMemory('shared');
  document.traits = Array.from({ length: 60 }, (_, i) => ({ id: 'item-' + i, text: String(i).padStart(3, '0') + 'x'.repeat(237) }));
  const encoded = memoryJson(document);
  (store as any).db.prepare('UPDATE shared_memory SET document=?,document_hash=? WHERE id=1').run(encoded, memoryHash(encoded));
  for (let i = 0; i < 24; i++) {
    store.submit(id, '"'.repeat(250)); if (!i) store.commitRoute(id, null, 'fixture', null);
    const request = store.prepareChat(id, randomUUID()), message = store.prepareReply(id, request.id);
    store.dispatch(request.id); store.finishReply(request.id, message.id, '"'.repeat(600), {});
  }
  await controller.command('endSession', { sessionId: id });
  await waitFor(() => store.memoryJob(id)?.state === 'failed');
  expect(memoryCalls).toHaveLength(0);
  expect(store.view(id).memory.attempts[0]).toMatchObject({ status: 'failed', failure: 'memory_input_too_large', dispatched_at: null });
  await controller.command('close', undefined);
});

it.each(['submit', 'prepareChat'])('replays a lost %s acknowledgement with one timed submission and one chat dispatch', async method => {
  const id = activeId(); loseAck = method;
  const sending = send(id, 'Tomorrow, perhaps.');
  await waitFor(() => !!snapshots.at(-1)?.activity.storageError);
  expect(calls.filter(c => c.stream)).toHaveLength(0);
  const prepared = store.requests(id).find(r => r.role === 'chat');
  await controller.command('retrySaving', undefined); await sending; await idle();
  expect(store.messages(id).filter(m => m.origin === 'learner')).toHaveLength(1);
  expect(store.requests(id).filter(r => r.role === 'chat')).toHaveLength(1);
  expect(calls.filter(c => c.stream)).toHaveLength(1);
  const final = store.requests(id).find(r => r.role === 'chat')!;
  if (prepared) expect(final.config).toBe(prepared.config);
  const config = JSON.parse(final.config);
  expect(config.time_context.sources).toHaveLength(1);
  expect(config.time_context.sources[0].sent_time.utc).toBeTruthy();
  await controller.command('close', undefined);
});

it('saves a queued newer draft after a lost Send acknowledgement is retried', async () => {
  const id = activeId(); loseAck = 'submit'; const sending = send(id, 'Sent text.', 1);
  await waitFor(() => !!snapshots.at(-1)?.activity.storageError);
  const saving = controller.command('saveDraft', { sessionId: id, text: 'Newer draft.', revision: 3 });
  await controller.command('retrySaving', undefined); await sending; await saving; await idle();
  await controller.command('saveDraft', { sessionId: id, text: 'Stale draft.', revision: 2 });
  expect(store.session(id).draft).toBe('Newer draft.');
  expect((controller as any).drafts.get(id)).toEqual({ revision: 3, text: 'Newer draft.' });
  await controller.command('close', undefined);
});

it.each(['endSession', 'close'])('does not dispatch after %s starts during request preparation', async action => {
  const id = activeId(); holdPrepare = true; await send(id);
  await waitFor(() => releasePrepare !== null);
  const ending = action === 'close' ? controller.command('close', undefined) : controller.command('endSession', { sessionId: id });
  await waitFor(() => (controller as any).interactive?.abort.signal.aborted === true);
  releasePrepare!(); await ending;
  expect(calls.filter(c => c.stream)).toHaveLength(0);
  if (action !== 'close') await controller.command('close', undefined);
});

async function attachDictation() {
  const records = new DictationStore(directory);
  const events: DictationSnapshot[] = [];
  const transcribe = vi.fn(async () => ({ text: 'Um, I goes there.' }));
  const create = vi.fn(async () => {
    const encoder = await DictationEncoder.create();
    return { push: async (sequence: number, pcm: Int16Array) => encoder.push(sequence, pcm),
      finish: async () => encoder.finish(), discard: async () => encoder.discard() };
  });
  const dictation = new DictationController(records, { transcribe }, create, snapshot => events.push(snapshot), () => undefined);
  await dictation.initialize(); controller.dictation = dictation;
  return { records, transcribe, create, dictation, events };
}

it('keeps ASR microphone creation behind durable draft saving and retries only local storage', async () => {
  const asr = await attachDictation(), sessionId = activeId(), id = randomUUID();
  failMethod = 'saveDraft';
  const opening = controller.command('asrBegin', { id, sessionId, text: 'Original draft.\n ', revision: 10 });
  await waitFor(() => !!snapshots.at(-1)?.activity.storageError);
  expect(asr.create).not.toHaveBeenCalled(); expect(asr.transcribe).not.toHaveBeenCalled();
  failMethod = null; await controller.command('retrySaving', undefined); await opening;
  expect(store.session(sessionId).draft).toBe('Original draft.\n ');
  expect(asr.create).toHaveBeenCalledTimes(1);
  for (const name of ['changePartner', 'useSelectedPartner', 'retryPartnerSelection'] as const) {
    await expect(controller.command(name, { sessionId, character: null, operationId: 'blocked', expectedRevision: 0 })).rejects.toThrow('asr_busy');
  }
  await controller.command('asrCancel', { id, discard: true });
  expect(asr.transcribe).not.toHaveBeenCalled(); expect(calls).toEqual([]);
  await controller.command('close', undefined);
});

it('rejects stale ASR insertion and keeps unsaved provenance recoverable without another request', async () => {
  const asr = await attachDictation(), sessionId = activeId(), id = randomUUID();
  await controller.command('asrBegin', { id, sessionId, text: 'Original.', revision: 10 });
  await controller.command('asrChunk', { id, sequence: 0, pcm: new Int16Array(300) });
  await controller.command('asrFinish', { id, reason: 'manual' });
  await controller.command('asrTranscribe', { id });
  // Match the renderer's published completion boundary, after result persistence.
  await waitFor(() => asr.events.at(-1)?.records.find(r => r.id === id)?.phase === 'complete');
  await controller.command('saveDraft', { sessionId, text: 'Newer draft.', revision: 12 });
  await expect(controller.command('asrInserted', { id, sessionId, text: 'Old draft.', revision: 11 })).rejects.toThrow('draft_changed');
  expect(store.session(sessionId).draft).toBe('Newer draft.');
  const save = vi.spyOn(asr.records, 'save').mockRejectedValueOnce(new Error('disk full'));
  await expect(controller.command('asrInserted', { id, sessionId, text: 'Newer draft.', revision: 12 })).rejects.toThrow('asr_save_required');
  await expect(controller.command('close', undefined)).rejects.toThrow('asr_save_required');
  expect(asr.dictation.needsSave).toBe(true); expect(asr.transcribe).toHaveBeenCalledTimes(1);
  save.mockRestore(); await controller.command('asrRetrySave', { id });
  expect(asr.dictation.needsSave).toBe(false); expect(asr.transcribe).toHaveBeenCalledTimes(1);
  expect(calls).toEqual([]); expect(store.session(sessionId).draft).toBe('Newer draft.');
  await controller.command('close', undefined);
});

it('uses the increased budget for a legacy session and explicit retry while preserving historical records', async () => {
  const id = activeId(); const legacy = JSON.stringify(goldens.legacy.conversation_snapshot);
  const raw = new Database(join(directory, 'stomylos.sqlite3'));
  raw.prepare('UPDATE sessions SET chat_config=? WHERE id=?').run(legacy, id); raw.close();
  streamFails = true; await send(id); await idle();
  const failed = store.requests(id).find(r => r.role === 'chat')!;
  expect(failed.failure).toBe('response_length_limit');
  expect(JSON.parse(failed.config)).toMatchObject({ version: 'stomylos_conversation_v2', max_tokens: 8192 });
  expect(JSON.parse(failed.metadata)).toMatchObject({ id: 'public-generation', finish_reason: 'length',
    usage: { completion_tokens: 8192, completion_tokens_details: { reasoning_tokens: 8000 } } });
  expect(store.messages(id).at(-1)).toMatchObject({ content: 'Partial response', delivery: 'interrupted' });
  expect(store.session(id).chat_config).toBe(legacy); expect(snapshots.at(-1)?.activity.error).toBe('response_length_limit');
  expect(calls).toHaveLength(2);
  streamFails = false; await controller.command('retryReply', { sessionId: id }); await waitFor(() => calls.length === 3); await idle();
  expect(calls).toHaveLength(3); expect(calls[2]).toEqual(calls[1]);
  expect(calls[2].max_tokens).toBe(8192);
  const retry = store.requests(id).findLast(r => r.role === 'chat')!;
  expect(retry).toMatchObject({ parent_id: failed.id, source_hash: failed.source_hash, config: failed.config, status: 'succeeded' });
  expect(store.requests(id).find(r => r.id === failed.id)).toEqual(failed);
  expect(store.session(id).chat_config).toBe(legacy);
  await controller.command('close', undefined);
});

it('routes once even with a manual override, then saves the ended analysis before another chat', async () => {
  const id = activeId(); useSeven(id); await controller.command('selectPartner', { sessionId: id, character: 'model_04' });
  await send(id, '  Source\ntext  '); await idle();
  expect(calls).toHaveLength(2); expect(calls[1].model).toBe('openai/gpt-6-astra'); expect(calls[1].reasoning).toEqual({ effort: 'low', exclude: true });
  await send(id, 'Second source.', 2); await idle(); expect(calls).toHaveLength(3);
  await controller.command('endSession', { sessionId: id });
  await waitFor(() => store.session(id).analysis_state === 'completed');
  expect(store.units(id).map(u => u.text)).toEqual(['  Source\ntext  ', 'Second source.']);
  expect(calls).toHaveLength(4); expect(await controller.command('newSession', undefined)).not.toBe(id);
  expect(store.starterJob(id)).toBeNull(); expect(renewalCalls).toHaveLength(0);
  await controller.command('close', undefined);
});
it('commits a local route after Luna and Terra fail without same-model retries', async () => {
  routerFails = true; const id = activeId(); await send(id); await idle();
  expect(store.requests(id).find(r => r.role === 'router')?.failure).toBe('request_timeout');
  expect(calls).toHaveLength(3); expect(store.session(id).character).toBeTruthy();
  await send(id, 'Next.', 2); await idle(); expect(calls).toHaveLength(4);
  await controller.command('close', undefined);
});
it('retains chat after grammar failure and retries once automatically before manually retrying the identical frozen analysis', async () => {
  const id = activeId(); await send(id); await idle(); grammarFails = true;
  await controller.command('endSession', { sessionId: id }); await waitFor(() => store.session(id).analysis_state === 'failed');
  await waitFor(() => store.requests(id).filter(r => r.role === 'grammar').length === 2 && store.session(id).analysis_state === 'failed');
  const original = store.requests(id).findLast(r => r.role === 'grammar')!; const source = store.messages(id);
  expect(store.units(id)).toEqual([]); await expect(controller.command('newSession', undefined)).rejects.toThrow('end_processing_pending');
  expect(calls).toHaveLength(4);
  grammarFails = false; await controller.command('retryAnalysis', { sessionId: id });
  await waitFor(() => store.session(id).analysis_state === 'completed');
  const retry = store.requests(id).findLast(r => r.role === 'grammar')!;
  expect(retry).toMatchObject({ parent_id: original.id, source_hash: original.source_hash, config: original.config, config_hash: original.config_hash });
  expect(store.messages(id)).toEqual(source); expect(store.units(id)).toHaveLength(1); expect(calls).toHaveLength(5);
  await expect(controller.command('retryAnalysis', { sessionId: id })).rejects.toThrow('analysis_not_retryable');
  expect(calls).toHaveLength(5); await controller.command('close', undefined);
});
it('rejects double send and cancels the reply before freezing its partial text', async () => {
  holdStream = true; const id = activeId(); await send(id);
  await waitFor(() => calls.some(call => call.stream));
  await expect(send(id, 'Double.', 2)).rejects.toThrow('reply_in_progress');
  await controller.command('endSession', { sessionId: id });
  await waitFor(() => store.session(id).analysis_state === 'completed');
  expect(store.messages(id).at(-1)).toMatchObject({ content: 'Partial response', delivery: 'interrupted' });
  expect(store.requests(id).find(r => r.role === 'chat')).toMatchObject({ status: 'interrupted', response_content: 'Partial response' });
  await controller.command('close', undefined);
});
it('treats exact /end as a local cancellation during a reply and never submits the command', async () => {
  holdStream = true; const id = activeId(); await send(id); await waitFor(() => calls.some(c => c.stream));
  await send(id, '/end', 2); await waitFor(() => store.session(id).analysis_state === 'completed');
  expect(store.messages(id).filter(m => m.origin === 'learner').map(m => m.content)).toEqual(['Exact source.']);
  expect(store.session(id).draft).toBe(''); expect(calls).toHaveLength(3); await controller.command('close', undefined);
});
it.each(['finishReply', 'saveAnalysis'])('recovers a lost %s acknowledgement with no repeated request or evidence', async method => {
  loseAck = method; const id = activeId(); await send(id);
  if (method === 'saveAnalysis') { await idle(); await controller.command('endSession', { sessionId: id }); }
  await waitFor(() => !!snapshots.at(-1)?.activity.storageError);
  const count = calls.length; await controller.command('retrySaving', undefined);
  await waitFor(() => !snapshots.at(-1)?.activity.storageError);
  expect(calls).toHaveLength(count);
  if (method === 'saveAnalysis') expect(store.units(id)).toHaveLength(1);
  else expect(store.messages(id).filter(m => m.origin === 'model')).toHaveLength(1);
  await controller.command('close', undefined);
});
it('blocks an ordinary close while interrupted text is unsaved, then closes after a local retry', async () => {
  holdStream = true; const id = activeId(); await send(id); await waitFor(() => calls.some(c => c.stream));
  failMethod = 'failRequest'; let closed = false;
  const closing = controller.command('close', undefined).then(value => { closed = value; });
  await waitFor(() => !!snapshots.at(-1)?.activity.storageError); expect(closed).toBe(false);
  await expect(controller.command('retrySaving', undefined)).rejects.toThrow('save_still_unavailable');
  failMethod = null; await controller.command('retrySaving', undefined); await closing;
  expect(closed).toBe(true); expect(calls).toHaveLength(2);
  store = new Store(directory, resolve('native/advisory-lock.node'));
  expect(store.messages(id).at(-1)).toMatchObject({ content: 'Partial response', delivery: 'interrupted' });
});
it('retries only the result transaction after a received reply could not be saved', async () => {
  failMethod = 'finishReply'; const id = activeId(); await send(id);
  await waitFor(() => snapshots.at(-1)?.activity.storageError === 'operation_failed');
  expect(calls).toHaveLength(2); expect(store.messages(id).at(-1)?.delivery).toBe('streaming');
  await expect(controller.command('endSession', { sessionId: id })).rejects.toThrow('save_required');
  failMethod = null; await controller.command('retrySaving', undefined); await idle();
  expect(calls).toHaveLength(2); expect(store.messages(id).at(-1)).toMatchObject({ content: 'Complete response.', delivery: 'complete' });
  await controller.command('close', undefined);
});
it('rejects a stale draft save after send and preserves a newer edit', async () => {
  const id = activeId(); await controller.command('saveDraft', { sessionId: id, text: 'Source.', revision: 4 });
  await send(id, 'Source.', 4); await idle();
  await controller.command('saveDraft', { sessionId: id, text: 'Stale source.', revision: 3 });
  expect(store.session(id).draft).toBe('');
  await controller.command('saveDraft', { sessionId: id, text: 'New unsent draft.', revision: 5 });
  await expect(send(id, 'Stale source.', 4)).rejects.toThrow('draft_changed');
  expect(store.session(id).draft).toBe('New unsent draft.'); await controller.command('close', undefined);
});
it.each(['queued', 'dispatched'])('blocks new chats during %s grammar and preserves recovery without replay on close', async status => {
  const id = activeId(); await send(id); await idle();
  if (status === 'queued') {
    // A durable request that has not yet reached the coordinator's dispatcher.
    store.end(id); store.createRequest(id, 'grammar', JSON.parse(store.session(id).grammar_config!));
  } else {
    holdGrammar = true; await controller.command('endSession', { sessionId: id });
    await waitFor(() => store.requests(id).some(r => r.role === 'grammar' && r.status === 'dispatched'));
    await waitFor(() => store.starterJob(id)?.state === 'completed' && store.memoryJob(id)?.state === 'completed');
  }
  expect(store.requests(id).find(r => r.role === 'grammar')?.status).toBe(status);
  await expect(controller.command('newSession', undefined)).rejects.toThrow('end_processing_pending');
  expect(store.endBlocker()).toBe(id);
  const requestCount = calls.length; await controller.command('close', undefined);
  store = new Store(directory, resolve('native/advisory-lock.node'));
  expect(store.session(id).analysis_state).toBe(status === 'queued' ? 'pending' : 'failed');
  expect(store.endBlocker()).toBe(id);
  expect(calls).toHaveLength(requestCount);
});
it('rejects retired starter retry without a provider call', async () => {
  const id=activeId(); await expect(controller.command('retryStarterRenewal',{sessionId:id})).rejects.toThrow('feature_removed');
  expect(renewalCalls).toHaveLength(0); await controller.command('close',undefined);
});
it('gates a new chat while independent background roles run and interrupts them on close', async () => {
  const first = activeId(); await send(first); await idle(); holdGrammar = true; holdRenewal = true;
  await controller.command('endSession', { sessionId: first }); await waitFor(() => store.session(first).analysis_state === 'running');
  await expect(controller.command('newSession', undefined)).rejects.toThrow('end_processing_pending');
  expect(store.session(first).analysis_state).toBe('running'); expect(store.starterJob(first)).toBeNull();
  await controller.command('close', undefined); store = new Store(directory, resolve('native/advisory-lock.node'));
  expect(store.starterJob(first)).toBeNull(); expect(renewalCalls).toHaveLength(0);
  expect(store.endBlocker()).toBe(first);
});
it('keeps no-key and restarted jobs pending, and key reload or history inspection never dispatches them', async () => {
  const id = activeId(); await send(id); await idle(); keyAvailable = false;
  await controller.command('refreshKey', undefined); await controller.command('endSession', { sessionId: id });
  expect(store.starterJob(id)).toBeNull(); expect(store.view(id).intentions).toBeUndefined(); expect(renewalCalls).toHaveLength(0);
  keyAvailable = true; await controller.command('refreshKey', undefined); await controller.command('loadSession', { sessionId: id });
  expect(renewalCalls).toHaveLength(0); await controller.command('close', undefined);
  store = new Store(directory, resolve('native/advisory-lock.node')); await controller.initialize();
  await controller.command('loadSession', { sessionId: id }); expect(renewalCalls).toHaveLength(0);
  expect(store.starterJob(id)).toBeNull(); expect(store.view(id).intentions).toBeUndefined();
});
it('never generates for skipped or untouched drafts', async () => {
  const empty = activeId(); await controller.command('endSession', { sessionId: empty });
  expect(renewalCalls).toHaveLength(0); const id = await controller.command('newSession', undefined);
  await controller.command('replaceStarter', { sessionId: id, operationId: 'public-skip', expectedQuestionId: store.session(id).starter_id!, expectedRevision: store.session(id).opening_revision });
  expect(renewalCalls).toHaveLength(0); await controller.command('endSession', { sessionId: id });
  expect(store.starterJob(id)).toBeNull(); expect(calls).toHaveLength(0); expect(renewalCalls).toHaveLength(0);
  await controller.command('close', undefined);
});

it('runs memory independently within the end gate and preserves chat snapshots across later commits', async () => {
  const first = activeId();
  await controller.command('selectPartner', { sessionId: first, character: 'model_04' });
  await send(first, 'I enjoy botanical gardens.'); await idle();
  holdMemory = true;
  memoryOutput = packet => splitDelta({ operations: [{ op: 'add', id: null, category: 'traits', text: 'Enjoys botanical gardens.', source_message_ids: [packet.messages.find((m: Json) => m.role === 'user' && m.evidence !== false).id] }] });
  await controller.command('endSession', { sessionId: first });
  await waitFor(() => memoryCalls.length === 1 && memoryRelease !== null);
  await waitFor(() => store.session(first).analysis_state === 'none' && store.starterJob(first) === null);
  await expect(controller.command('newSession', undefined)).rejects.toThrow('end_processing_pending');
  holdMemory = false; memoryRelease!();
  await waitFor(() => store.endStatus(first)?.complete === true);
  const second = await controller.command('newSession', undefined);
  await controller.command('selectPartner', { sessionId: second, character: 'model_04' });
  await send(second, 'A fresh topic.', 2); await idle();
  const before = store.requests(second).find(r => r.role === 'chat')!;
  const frozenMemory = JSON.parse(before.config).memory_context;
  expect(frozenMemory.database_records[0].text).toBe('Enjoys botanical gardens.');
  await send(second, 'I enjoy quiet libraries.', 3); await idle();
  const after = store.requests(second).findLast(r => r.role === 'chat')!;
  expect(JSON.parse(after.config).memory_context).toEqual(frozenMemory);
  expect(memoryCalls).toHaveLength(1);
  memoryOutput = packet => splitDelta({ operations: [{ op: 'add', id: null, category: 'traits', text: 'Enjoys quiet libraries.', source_message_ids: [packet.messages.findLast((m: Json) => m.role === 'user' && m.evidence !== false).id] }] });
  await controller.command('endSession', { sessionId: second });
  await waitFor(() => store.endStatus(second)?.complete === true);
  expect(JSON.parse(memoryCalls[1].messages[1].content).database_records).toEqual([{ id: 'm1', text: 'Enjoys botanical gardens.' }]);
  expect(store.requests(second).find(r => r.id === before.id)?.config).toBe(before.config);
  expect(store.requests(second).find(r => r.id === after.id)?.config).toBe(after.config);
  expect(flat(store.view(second).memory.current).database_records.map(t => t.text)).toContain('Enjoys quiet libraries.');
  const third = await controller.command('newSession', undefined);
  await controller.command('selectPartner', { sessionId: third, character: 'model_04' });
  await send(third, 'Do you remember my interests?', 4); await idle();
  const prompt = calls.filter(c => c.stream).at(-1)!.messages[0].content;
  expect(prompt).toContain('Enjoys botanical gardens.'); expect(prompt).toContain('Enjoys quiet libraries.');
  await controller.command('close', undefined);
});

it.each(['saveMemory', 'dispatchMemory', 'prepareMemory'])('recovers a lost %s acknowledgement without a second memory request', async method => {
  const id = activeId(); await send(id); await idle();
  loseAck = method; const ending = controller.command('endSession', { sessionId: id });
  await waitFor(() => !!snapshots.at(-1)?.activity.storageError);
  await controller.command('retrySaving', undefined);
  await waitFor(() => store.memoryJob(id)?.state === 'completed');
  await ending; expect(memoryCalls).toHaveLength(1); expect(store.view(id).memory.attempts).toHaveLength(1);
  await controller.command('close', undefined);
});

it('retains a received memory response during a save failure and retries only local persistence', async () => {
  const id = activeId(); await send(id); await idle();
  failMethod = 'saveMemory'; const ending = controller.command('endSession', { sessionId: id });
  await waitFor(() => !!snapshots.at(-1)?.activity.storageError);
  expect(memoryCalls).toHaveLength(1); expect(store.memoryJob(id)?.state).toBe('running');
  failMethod = null; await controller.command('retrySaving', undefined); await ending;
  await waitFor(() => store.memoryJob(id)?.state === 'completed');
  expect(memoryCalls).toHaveLength(1);
  await controller.command('close', undefined);
});

it('keeps a failed memory job gated and explicit retry reuses the exact request', async () => {
  const id = activeId(); await controller.command('selectPartner', { sessionId: id, character: 'model_04' });
  await send(id); await idle(); memoryFails = true;
  await controller.command('endSession', { sessionId: id }); await waitFor(() => store.memoryJob(id)?.state === 'failed');
  await expect(controller.command('newSession', undefined)).rejects.toThrow('end_processing_pending');
  const count = memoryCalls.length;
  await controller.command('snapshot', undefined); expect(memoryCalls).toHaveLength(count);
  memoryFails = false; await controller.command('retryMemory', { sessionId: id });
  await waitFor(() => store.memoryJob(id)?.state === 'completed');
  expect(memoryCalls).toHaveLength(count + 1); expect(memoryCalls.at(-1)).toEqual(memoryCalls[0]);
  await controller.command('close', undefined);
});

it('cancels active memory on close and requires explicit recovery after restart', async () => {
  const id = activeId(); await send(id); await idle(); holdMemory = true;
  await controller.command('endSession', { sessionId: id }); await waitFor(() => memoryRelease !== null);
  await controller.command('close', undefined);
  store = new Store(directory, resolve('native/advisory-lock.node'));
  expect(store.memoryJob(id)?.state).toBe('interrupted');
  const complete = vi.fn(async (body: Json) => ({ content: body.model === 'google/gemini-3.8-flash' ? '{"add":[],"update":[],"delete":[]}' : 'What is next?\nWhat feels different?', metadata: {} }));
  const db = { ready: Promise.resolve(), call: async (method: StoreMethod, ...args: any[]) => (store[method] as Function).apply(store, args), close: async () => store.close() } as unknown as DatabaseClient;
  const reopened = new Coordinator(db, { complete, stream: vi.fn() }, { keyPresent: true, keyPath: '/test/key', dataPath: directory, appVersion: 'test', development: true }, () => undefined, () => true);
  await reopened.initialize(); await reopened.command('snapshot', undefined);
  expect(complete).not.toHaveBeenCalled();
  await reopened.command('retryMemory', { sessionId: id });
  await waitFor(() => store.memoryJob(id)?.state === 'completed');
  expect(complete.mock.calls.filter(([body]) => body.model === 'google/gemini-3.8-flash')).toHaveLength(1); await reopened.command('close', undefined);
});

it('deletes an ended chat while cancelling its active background jobs and preserving the next draft', async () => {
  const id = activeId(); await send(id); await idle(); holdGrammar = holdRenewal = holdMemory = true;
  await controller.command('endSession', { sessionId: id });
  await waitFor(() => calls.length === 3 && memoryCalls.length === 1);
  expect(renewalCalls).toHaveLength(0); expect(store.starterJob(id)).toBeNull();
  const next = await controller.command('newSession', undefined);
  await controller.command('saveDraft', { sessionId: next, text: 'Keep this draft.', revision: 2 });
  await controller.command('deleteSession', { sessionId: id });
  expect(() => store.session(id)).toThrow('session_not_found');
  expect(store.session(next).draft).toBe('Keep this draft.');
  expect(store.integrity().foreignKeys).toEqual([]);
  await expect(controller.command('saveDraft', { sessionId: id, text: 'Late save', revision: 999 })).rejects.toThrow('session_not_found');
  await controller.command('deleteSession', { sessionId: id });
  await expect(controller.command('deleteSession', { sessionId: next })).rejects.toThrow('delete_requires_ended');
  await controller.command('close', undefined);
});
it('retries a lost deletion acknowledgement without recreating history or calling a model', async () => {
  const id = activeId(); await controller.command('endSession', { sessionId: id }); loseAck = 'deleteSession';
  const deleting = controller.command('deleteSession', { sessionId: id });
  await waitFor(() => !!snapshots.at(-1)?.activity.storageError);
  expect(() => store.session(id)).toThrow('session_not_found');
  await controller.command('retrySaving', undefined); await deleting;
  expect(calls).toHaveLength(0); expect(store.pendingDeletions()).toEqual([]);
  await controller.command('close', undefined);
});
it('keeps file cleanup durable after failure and retries without restoring the deleted chat', async () => {
  const id = activeId(); await controller.command('endSession', { sessionId: id });
  const clean = vi.fn().mockRejectedValueOnce(new Error('file locked')).mockResolvedValue(undefined);
  controller.speech = { prepareDeletion: async () => [], cancelDeletion() {}, deleteSession: clean, stop() {}, close: async () => undefined } as any;
  await controller.command('deleteSession', { sessionId: id });
  expect(store.pendingDeletions()).toEqual([id]); expect((await controller.snapshot()).activity.deletionCleanupPending).toBe(true);
  await controller.command('retryDeletionCleanup', undefined);
  expect(store.pendingDeletions()).toEqual([]); expect((await controller.snapshot()).activity.deletionCleanupPending).toBe(false);
  expect(clean).toHaveBeenCalledTimes(2); await controller.command('close', undefined);
});

it('rejects a successful analysis response that arrives after deletion cancellation', async () => {
  const id = activeId(); await send(id); await idle(); holdGrammar = true; lateGrammar = true;
  await controller.command('endSession', { sessionId: id }); await waitFor(() => calls.length === 3);
  const save = vi.spyOn(store, 'saveAnalysis');
  await controller.command('deleteSession', { sessionId: id });
  expect(save).not.toHaveBeenCalled(); expect(() => store.session(id)).toThrow('session_not_found');
  await controller.command('close', undefined);
});

it('routes direct entry once and retains only real turns across failed reply, retry and independent ending jobs', async () => {
  const id = activeId();
  await controller.command('setOpening', { sessionId: id, operationId: 'direct', expectedRevision: 0, kind: 'user' });
  expect(calls).toEqual([]); expect(renewalCalls).toEqual([]);
  streamFails = true; await send(id, 'Explain gravity.'); await idle();
  expect(JSON.parse(calls[0].messages[1].content)).toEqual({ opening_kind: 'user', first_message: 'Explain gravity.' });
  const before = calls.find(body => body.stream)!;
  expect(before.messages.map((m: Json) => m.role)).toEqual(['system', 'user']);
  const snapshot = store.view(id).memory.snapshot;
  streamFails = false; await controller.command('retryReply', { sessionId: id });
  await waitFor(() => calls.filter(body => body.stream).length === 2); await idle();
  expect(calls.filter(body => body.response_format?.json_schema.name.startsWith('stomylos_character_scores_v'))).toHaveLength(1);
  expect(calls.filter(body => body.stream)).toHaveLength(2);
  expect(calls.filter(body => body.stream)[1]).toEqual(before);
  await send(id, 'What changes on the moon?', 2); await idle();
  expect(calls.filter(body => body.stream).at(-1)!.messages.map((m: Json) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
  expect(store.view(id).memory.snapshot).toEqual(snapshot);
  await controller.command('endSession', { sessionId: id });
  await controller.command('retryAnalysis', { sessionId: id });
  await waitFor(() => store.starterJob(id) === null && store.session(id).analysis_state === 'completed');
  expect(renewalCalls).toHaveLength(0);
  expect(store.units(id).map(unit => unit.text)).toEqual(['Explain gravity.', 'What changes on the moon?']);
  expect((await controller.snapshot()).sessions.find(s => s.id === id)?.title).toBe('Explain gravity.');
  await controller.command('close', undefined);
});

it('recovers a lost opening acknowledgement without changing the preserved draft or making requests', async () => {
  const id = activeId(); await controller.command('saveDraft', { sessionId: id, revision: 5, text: '  Keep this draft.\n' });
  loseAck = 'setOpening';
  const operation = controller.command('setOpening', { sessionId: id, operationId: 'lost-opening', expectedRevision: 0, kind: 'user' });
  await waitFor(() => !!snapshots.at(-1)?.activity.storageError);
  await controller.command('retrySaving', undefined); expect(await operation).toEqual({ revision: 1 });
  expect(store.session(id)).toMatchObject({ opening_kind: 'user', opening_revision: 1, draft: '  Keep this draft.\n' });
  expect(calls).toEqual([]); expect(renewalCalls).toEqual([]);
  await controller.command('close', undefined);
});


function seedPatternEvidence() {
  for(let i=0;i<5;i++) {
    const session=store.createSession();store.submit(session.id,'I enjoyed walking.');store.end(session.id);
    const attempt=store.createRequest(session.id,'grammar',grammarSnapshot());store.dispatch(attempt.id);
    store.saveAnalysis(attempt.id,JSON.stringify({units:[{index: 0,corrected_text:'I enjoyed walking.',explanation:''}]}),{});
  }
}
it('dispatches a historical retry with its frozen request and policy through the controller', async () => {
  seedPatternEvidence();
  const r = store.patternCreate(store.patternPreview().fingerprint, randomUUID());
  const old = makePatternHistorical(directory, r.id);
  store.patternFinish(r.attemptId!, 'interrupted', 'queued_not_dispatched', null, {});
  expect(patternCalls).toHaveLength(0);
  await controller.command('patternRetry', { id: r.id, operationId: randomUUID() });
  await waitFor(() => controller.patterns.snapshot().phase === 'idle');
  expect(patternCalls).toEqual([prepareProviderRequest(JSON.parse(old.request)).body]);
  expect(store.patternAttempt(r.attemptId!).request).toBe(old.request);
  expect(patternPolicies).toEqual([{ identity: { ...historicalPatternContract.identity, provider: null }, timeout: historicalPatternContract.timeout_ms }]);
  expect(store.patternDetail(r.id).attempts).toHaveLength(2);
  expect(store.patternHtml(r.id).html).toBe(patternHtml);
  await controller.command('close', undefined);
});
it('discards a v2 late completion after cancellation without committing HTML', async () => {
  seedPatternEvidence(); holdPattern = true; latePattern = true;
  const p = store.patternPreview();
  const r = await controller.command('patternCreate', { fingerprint: p.fingerprint, operationId: randomUUID() });
  await waitFor(() => patternCalls.length === 1);
  expect(patternCalls[0].messages[0].content).toContain('calm editorial field-guide');
  await controller.command('patternCancel', { id: r.id });
  expect(store.patternDetail(r.id)).toMatchObject({ status: 'cancelled', selected_attempt_id: null });
  expect(() => store.patternHtml(r.id)).toThrow('pattern_not_ready');
  await controller.command('close', undefined);
});
it.each(['failure','lost_ack'])('saves a pattern response without redispatch after %s through shared recovery',async(mode)=>{
  seedPatternEvidence(); if(mode==='failure')failMethod='patternSave';else loseAck='patternSave';
  const preview=await controller.command('patternPreview',undefined);
  const report=await controller.command('patternCreate',{fingerprint:preview.fingerprint,operationId:randomUUID()});
  await waitFor(()=>!!snapshots.at(-1)?.activity.storageError);
  expect(controller.patterns.snapshot().phase).toBe('saving');expect(patternCalls).toHaveLength(1);
  await controller.command('patternClose',undefined);
  await expect(controller.command('patternCreate',{fingerprint:preview.fingerprint,operationId:randomUUID()})).rejects.toThrow('save_required');
  failMethod=null;await controller.command('patternRetrySave',undefined);
  await waitFor(()=>controller.patterns.snapshot().phase==='idle');
  expect(store.patternHtml(report.id).html).toBe(patternHtml);expect(patternCalls).toHaveLength(1);
  await controller.command('close',undefined);
});
it('allows a conversation while a report is running and drains report cancellation before deleting its source',async()=>{
  seedPatternEvidence();holdPattern=true;
  const preview=await controller.command('patternPreview',undefined);
  const report=await controller.command('patternCreate',{fingerprint:preview.fingerprint,operationId:randomUUID()});
  await waitFor(()=>patternCalls.length===1);
  const chat=await controller.command('newSession',undefined);await send(chat);await idle();
  expect(controller.patterns.snapshot().phase).toBe('generating');
  const source=store.patternDetail(report.id).sources[0].session_id;
  await controller.command('deleteSession',{sessionId:source});
  expect(store.patternDetail(report.id).status).toBe('cancelled');expect(store.patternDetail(report.id).canRetry).toBe(false);
  await controller.command('close',undefined);
});


// Dedicated Intention dispatch was retired. Its replacement parallel-stage,
// retry/cancellation and migration assertions live in end-processing.test.ts
// and database-migrations.test.ts.

const switchPartner = (id: string, character: string | null) => controller.command('changePartner', {
  sessionId: id, character, operationId: randomUUID(), expectedRevision: store.view(id).partner.revision
});
const chatCalls = () => calls.filter(body => !body.response_format);
const routerCalls = () => calls.filter(body => body.response_format?.json_schema.name.startsWith('stomylos_character_scores_v'));

it('continues a manual switch through ordinary Send and one-shot Auto excludes the effective model', async () => {
  const id = activeId(); await send(id); await idle();
  expect(snapshots.some(s => s.activity.phase === 'routing')).toBe(true);
  const first = chatCalls()[0], original = store.session(id).character;
  const target = JSON.parse(store.session(id).chat_config).characters.find((c: Json) => c.id !== original);
  await switchPartner(id, target.id);
  let snapshotStart = snapshots.length;
  expect(chatCalls()).toHaveLength(1); expect(routerCalls()).toHaveLength(1);
  await send(id, 'A different topic.', 2); await idle();
  expect(snapshots.slice(snapshotStart).some(s => s.activity.phase === 'routing')).toBe(false);
  expect(chatCalls()[1].model).toBe(target.model); expect(routerCalls()).toHaveLength(1);
  expect(chatCalls()[1].messages.slice(1, first.messages.length)).toEqual(first.messages.slice(1));
  await switchPartner(id, null); snapshotStart = snapshots.length;
  await send(id, 'Actually, focus on the recent correction.', 3); await idle();
  expect(snapshots.slice(snapshotStart).some(s => s.activity.phase === 'routing')).toBe(true);
  expect(chatCalls()[2].model).not.toBe(target.model); expect(routerCalls()).toHaveLength(2);
  expect(JSON.parse(routerCalls()[1].messages[1].content).at(-1)).toEqual({ role: 'user', content: 'Actually, focus on the recent correction.' });
  snapshotStart = snapshots.length;
  await send(id, 'Continue with that.', 4); await idle();
  expect(snapshots.slice(snapshotStart).some(s => s.activity.phase === 'routing')).toBe(false);
  expect(snapshots.slice(snapshotStart).some(s => s.activity.phase === 'preparing')).toBe(true);
  expect(searchPhases).toEqual(['preparing', 'preparing', 'preparing', 'preparing']);
  expect(chatCalls()[3].model).toBe(chatCalls()[2].model); expect(routerCalls()).toHaveLength(2);
  expect(store.messages(id).filter(m => m.origin === 'learner')).toHaveLength(4);
  expect(store.session(id).character).toBe(original); expect(memoryCalls).toHaveLength(0);
});

it('keeps legacy failed Auto explicit and retries its frozen selection without duplicating the user source', async () => {
  const id = activeId(); useSeven(id); await send(id); await idle(); await switchPartner(id, null);
  routerFails = true; await send(id, 'A question for someone else.', 2); await idle();
  expect(store.view(id).partner.pending?.state).toBe('failed'); expect(chatCalls()).toHaveLength(1);
  const failed = store.requests(id).findLast(r => r.role === 'router')!;
  await expect(controller.command('retryReply', { sessionId: id })).rejects.toThrow('partner_selection_pending');
  routerFails = false; await controller.command('retryPartnerSelection', { sessionId: id }); await idle();
  const retry = store.requests(id).findLast(r => r.role === 'router')!;
  expect(retry.parent_id).toBe(failed.id); expect(retry.config).toBe(failed.config);
  expect(routerCalls()[2]).toEqual(routerCalls()[1]); expect(chatCalls()).toHaveLength(2);
  expect(store.messages(id).filter(m => m.origin === 'learner')).toHaveLength(2);
  expect(store.view(id).partner.pending).toBeNull();
});

it('keeps original Retry independent of pending replacement and never reroutes that retry', async () => {
  const id = activeId(); streamFails = true; await send(id); await idle();
  const original = chatCalls()[0]; await switchPartner(id, null);
  const snapshotStart = snapshots.length;
  await controller.command('retryReply', { sessionId: id });
  await waitFor(() => store.requests(id).filter(r => r.role === 'chat' && r.status === 'failed').length === 2); await idle();
  expect(snapshots.slice(snapshotStart).some(s => s.activity.phase === 'routing')).toBe(false);
  expect(chatCalls()[1]).toEqual(original); expect(routerCalls()).toHaveLength(1);
  streamFails = false; await controller.command('useSelectedPartner', { sessionId: id }); await idle();
  expect(chatCalls()[2].model).not.toBe(original.model); expect(routerCalls()).toHaveLength(2);
  expect(store.messages(id).filter(m => m.origin === 'learner')).toHaveLength(1);
  const replacement = store.requests(id).findLast(r => r.role === 'chat')!;
  expect(replacement.parent_id).toBeNull();
  expect(JSON.parse(replacement.config).request_partner.supersedes_request_id).toBe(store.requests(id).filter(r => r.role === 'chat')[1].id);
});

it.each(['changePartner', 'preparePartner', 'finishRecoveryRoute', 'prepareChat'])('recovers a lost %s acknowledgement without replaying inference or selection', async method => {
  const id = activeId(); await send(id); await idle();
  const original = store.view(id).partner.currentModel;
  if (method === 'changePartner') loseAck = method;
  const choice = switchPartner(id, null);
  if (method === 'changePartner') {
    await waitFor(() => !!snapshots.at(-1)?.activity.storageError);
    await controller.command('retrySaving', undefined);
  }
  await choice;
  if (method !== 'changePartner') loseAck = method;
  const sent = send(id, 'New topic after an acknowledged choice.', 2);
  if (method !== 'changePartner') {
    await waitFor(() => !!snapshots.at(-1)?.activity.storageError);
    const before = calls.length;
    await expect(switchPartner(id, 'model_01')).rejects.toThrow('save_required');
    expect(calls.length).toBe(before);
    await controller.command('retrySaving', undefined);
  }
  await sent; await idle();
  expect(routerCalls()).toHaveLength(2); expect(chatCalls()).toHaveLength(2);
  expect(chatCalls()[1].model).not.toBe(original);
  expect(store.messages(id).filter(m => m.origin === 'learner')).toHaveLength(2);
  expect(store.requests(id).filter(r => r.role === 'router')).toHaveLength(2);
  expect(store.view(id).partner.pending).toBeNull();
});

it('rejects selection during Auto and ignores a late router result after End', async () => {
  const id = activeId(); await send(id); await idle(); const original = store.view(id).partner.currentModel;
  holdRouter = true; await switchPartner(id, null); await send(id, 'An unresolved user source.', 2);
  await waitFor(() => routerCalls().length === 2);
  await expect(switchPartner(id, 'model_01')).rejects.toThrow('reply_in_progress');
  await controller.command('endSession', { sessionId: id });
  expect(chatCalls()).toHaveLength(1); expect(store.session(id).state).toBe('ended');
  expect(store.view(id).partner.currentModel).toBe(original);
  expect(store.requests(id).filter(r => r.role === 'router').at(-1)?.status).toBe('interrupted');
  expect(store.messages(id).filter(m => m.origin === 'learner')).toHaveLength(2);
  await controller.command('close', undefined);
});

it('backup waits for accepted draft writes, blocks new commands and releases the gate after failure', async () => {
  const id = activeId();
  const draft = controller.command('saveDraft', { sessionId: id, text: 'Latest backup draft.', revision: 9 });
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = controller.withBackup(async () => {
    expect(store.session(id).draft).toBe('Latest backup draft.'); entered();
    await new Promise<void>(resolve => { finish = resolve; }); throw new Error('export failed');
  });
  const rejected = expect(pending).rejects.toThrow('export failed');
  await started; await draft;
  await expect(controller.command('saveDraft', { sessionId: id, text: 'Must not enter snapshot.', revision: 10 })).rejects.toThrow('backup_busy');
  await expect(controller.withBackup(async () => undefined)).rejects.toThrow('backup_busy');
  finish(); await rejected;
  await controller.command('saveDraft', { sessionId: id, text: 'After backup.', revision: 10 });
  expect(store.session(id).draft).toBe('After backup.');
  await controller.command('close', undefined);
});

it('backup refuses active generation and unresolved saves without cancelling or replaying inference', async () => {
  const id = activeId(); holdStream = true; await send(id);
  await waitFor(() => calls.some(c => c.stream)); const before = calls.length;
  await expect(controller.withBackup(async () => undefined)).rejects.toThrow('backup_busy');
  expect(calls.length).toBe(before); expect(snapshots.at(-1)?.activity.phase).not.toBe('idle');
  await controller.command('close', undefined);
});

it('backup refuses pending draft persistence without waiting indefinitely', async () => {
  const id = activeId(); failMethod = 'saveDraft';
  const pending = controller.command('saveDraft', { sessionId: id, text: 'Unsaved backup draft.', revision: 9 });
  await waitFor(() => !!snapshots.at(-1)?.activity.storageError);
  await expect(controller.withBackup(async () => undefined)).rejects.toThrow('save_required');
  failMethod = null; await controller.command('retrySaving', undefined); await pending;
  await controller.withBackup(async () => { expect(store.session(id).draft).toBe('Unsaved backup draft.'); });
  await controller.command('close', undefined);
});

it('backup releases its gate when an accepted draft write fails during draining', async () => {
  const id = activeId(); failMethod = 'saveDraft';
  const saving = controller.command('saveDraft', { sessionId: id, text: 'Save raced backup.', revision: 20 });
  await expect(controller.withBackup(async () => { throw new Error('must not export'); })).rejects.toThrow('save_required');
  failMethod = null; await controller.command('retrySaving', undefined); await saving;
  expect(store.session(id).draft).toBe('Save raced backup.');
  await controller.withBackup(async () => undefined);
  await controller.command('close', undefined);
});

it.each([false, true])('does not dispatch starter generation (skip-only: %s)', async skipOnly => {
  const id = activeId();
  if (skipOnly) {
    const session = store.session(id);
    store.replaceQuestion(id, randomUUID(), session.starter_id!, session.opening_revision);
  } else store.submit(id, 'A real user message.');
  await controller.command('endSession', {sessionId:id});
  expect(store.starterJob(id)).toBeNull(); expect(renewalCalls).toHaveLength(0);
  await controller.command('close', undefined);
});

it('manual memory edit recovers a lost commit acknowledgement once without a provider call', async () => {
  const inspect = new Database(join(directory,'stomylos.sqlite3'));
  const doc = memoryJson({character_id:'shared',revision:0,database_records:[{id:'manual',text:'Before.'}]});
  inspect.prepare('UPDATE shared_memory SET document=?,document_hash=?').run(doc,memoryHash(doc));inspect.close();
  const current = await controller.command('memoryManagement',undefined);
  loseAck = 'commitMemoryEdit';
  const pending = controller.command('editMemory',{id:'manual',text:'After.',revision:current.document.revision,hash:current.hash});
  await waitFor(() => !!snapshots.at(-1)?.activity.storageError);
  expect(store.currentMemory()).toMatchObject({revision:1,database_records:[{id:'manual',text:'After.'}]});
  await controller.command('retrySaving',undefined);await pending;
  expect(store.currentMemory().revision).toBe(1);expect(calls).toEqual([]);expect(memoryCalls).toEqual([]);
});

it.each(['edit-first','send-first'])('manual memory serializes %s against the first Send', async order => {
  const inspect = new Database(join(directory,'stomylos.sqlite3'));
  const doc = memoryJson({character_id:'shared',revision:0,database_records:[{id:'manual',text:'Before.'}]});
  inspect.prepare('UPDATE shared_memory SET document=?,document_hash=?').run(doc,memoryHash(doc));inspect.close();
  const session = store.createSession();store.searchMode(session.id,'off');store.selectManual(session.id,'model_04');holdStream=true;
  const current=await controller.command('memoryManagement',undefined);
  const edit=()=>controller.command('editMemory',{id:'manual',text:'After.',revision:current.document.revision,hash:current.hash});
  const send=()=>controller.command('sendMessage',{sessionId:session.id,text:'A new conversation.',revision:1});
  if(order==='edit-first') {
    const editing=edit(),sending=send();await editing;await sending;
    await waitFor(()=>store.requests(session.id).some(r=>r.role==='chat'));
    const request=store.requests(session.id).find(r=>r.role==='chat')!;
    expect(JSON.parse(request.config).memory_context.database_records[0].text).toBe('After.');
  } else {
    const sending=send(),editing=edit();const rejected=expect(editing).rejects.toThrow('memory_in_use');await sending;await rejected;
    expect(store.currentMemory().revision).toBe(0);
  }
});
