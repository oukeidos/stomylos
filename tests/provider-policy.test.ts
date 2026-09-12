import { memoryAddBody } from '../src/main/memory-add';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/main/database';
import { prepareProviderRequest, validateProviderRequest, assertProviderBody } from '../src/main/provider-policy';
import { OpenRouter } from '../src/main/transport';
import { characters, conversationSnapshot, routerBody, routerSnapshot, grammarSnapshot, grammarBody } from '../src/main/contracts';
import { partnerRouterBody } from '../src/main/partner-router';
import { recoverySnapshot } from '../src/main/router-recovery';
import { withSearch, searchSnapshot, searchRouterBody, searchInput, searchOverlay } from '../src/main/search-contract';
import { genieBody, genieIdentity } from '../src/main/genie';
import { explainBody, explainIdentity } from '../src/main/explain';
import { patternBody, patternContract } from '../src/main/pattern-report';
import { memoryBody, memoryConfig, flatUpdaterVersion, candidateLimits, emptyMemory } from '../src/main/memory-updater';
import { flattenMemory } from '../src/main/memory-flat';
import { cleanupConfig, cleanupBody, flatCleanupVersion } from '../src/main/memory-cleanup';
import { speechBody } from '../src/main/tts';
import { makeSpeechConfig, speechConfig, hashConfig } from '../src/main/speech-store';
import { voices, previewSource } from '../src/shared/voice';
import type { Json } from '../src/shared/types';

afterEach(() => vi.unstubAllGlobals());
it('freezes a separate wire snapshot, preserves generation evidence, rejects tampering and endpoint confusion', () => {
  const original = { model: 'm', provider: { only: ['old'], order: ['old'], ignore: ['other'], require_parameters: true, sort: 'latency', allow_fallbacks: false }, messages: [] };
  const before = structuredClone(original), identity = { allowed_models: ['m'], provider: 'Old' };
  const routed = prepareProviderRequest(original, identity);
  expect(routed.body.provider).toEqual({ require_parameters: true, sort: 'latency', allow_fallbacks: true, data_collection: 'deny' });
  expect(original).toEqual(before); expect(identity.provider).toBe('Old');
  expect(validateProviderRequest(routed, { body: original, identity })).toEqual(routed);
  expect(() => validateProviderRequest({ ...routed, version: 'unknown' } as any)).toThrow('provider_policy_invalid');
  expect(() => validateProviderRequest(routed, { body: { ...original, model: 'other' }, identity })).toThrow('provider_source_changed');
  expect(() => validateProviderRequest({ ...routed, body: { ...routed.body, provider: {} } })).toThrow('provider_policy_invalid');
  expect(prepareProviderRequest(original, null, 'speech').support).toBe('unverified');
  const asr = prepareProviderRequest(original, null, 'transcription');
  expect(asr.support).toBe('unsupported'); expect(asr.body.provider).toBeUndefined();
  expect(() => assertProviderBody(original, 'transcription')).toThrow('provider_policy_invalid');
});
it('rejects raw provider policy bypasses before fetch and retains model validation', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); const gateway = new OpenRouter(() => 'synthetic');
  for (const provider of [undefined, {}, { only: ['openai'], allow_fallbacks: true, data_collection: 'deny' },
    { allow_fallbacks: false, data_collection: 'deny' }, { allow_fallbacks: true, data_collection: 'allow' }]) {
    await expect(gateway.stream({ model: 'selected', provider }, new AbortController().signal, () => {})).rejects.toThrow('provider_policy_invalid');
  }
  expect(fetch).not.toHaveBeenCalled();
  const body = prepareProviderRequest({ model: 'selected' }).body;
  fetch.mockResolvedValue(new Response(JSON.stringify({model:'wrong',provider:'Alternate',choices:[{message:{content:'ok'},finish_reason:'stop'}]})));
  await expect(gateway.complete(body, { allowed_models: ['selected'], provider: null }, new AbortController().signal, 1000)).rejects.toThrow('response_identity');
});
it('checks the actual wire for every active text request shape and keeps search limits unchanged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stomylos-policy-matrix-')), store = new Store(dir, resolve('native/advisory-lock.node'));
  const cases: { name: string; body: Json; identity?: Json }[] = [];
  const add = (name: string, body: Json, identity?: Json) => cases.push({ name, body, identity });
  try {
    for (const partner of characters) for (const mode of ['user', 'starter', 'search'] as const) {
      const s = store.createSession();
      if (mode !== 'starter') store.setOpening(s.id, randomUUID(), s.opening_revision, 'user');
      store.searchMode(s.id, 'off'); store.selectManual(s.id, partner.id); store.submit(s.id, 'A synthetic question.'); store.commitRoute(s.id, null, 'fixture', null);
      const request = store.prepareChat(s.id, randomUUID()), body = store.chatBody(request.id);
      add(`chat-${partner.id}-${mode}`, mode === 'search' ? withSearch(body, true) : body);
      store.end(s.id); store.cancelEnd(s.id);
    }
    for (const kind of ['user', 'starter'] as const) {
      const saved = conversationSnapshot(kind), body = routerBody(kind === 'user' ? null : 'Question?', 'Answer.', saved), snap = routerSnapshot(saved);
      add(`router-${kind}`, body, snap.response_identity);
      const secondary = recoverySnapshot(snap); add(`router-${kind}-secondary`, { ...body, ...secondary.parameters }, secondary.response_identity);
    }
    {
      const s = store.createSession(); store.setOpening(s.id, randomUUID(), s.opening_revision, 'user');
      store.searchMode(s.id,'off'); store.submit(s.id,'A different perspective.'); store.commitRoute(s.id,{model_03:2},null,null);
      store.changePartner(s.id,null,randomUUID(),0);
      const request = store.preparePartner(s.id,'send',randomUUID())!, snap = JSON.parse(request.config), body = partnerRouterBody(snap);
      add('reselection',body,snap.response_identity);
      const secondary = recoverySnapshot(snap); add('reselection-secondary',{...body,...secondary.parameters},secondary.response_identity);
      store.end(s.id);store.cancelEnd(s.id);
    }
    const search = searchSnapshot(); for (const ordinal of [0, 1]) add(`search-gate-${ordinal}`, searchRouterBody(search, searchInput('', 'Search the web.'), ordinal));
    const source = { sessionId: 's', revision: 0, contextHash: 'x', text: 'I go yesterday.', messages: [] };
    for (const selection of [false, true]) add(`genie-${selection}`, genieBody(source, { start: 0, end: source.text.length, direction: 'none', scope: selection ? 'selection' : 'draft' }, [{role:'assistant',content:'Earlier help.'}], 'Make it natural.'), genieIdentity);
    add('explain', explainBody({ preceding_message: null, full_passage: 'A short phrase.', selected_text: 'short', selection: { start: 2, end: 7, offset_unit: 'utf16' } }), explainIdentity);
    const grammar = grammarSnapshot(); add('grammar', grammarBody(grammar, []), grammar.response_identity);
    add('report', patternBody([]), patternContract.identity);
    const doc = flattenMemory(emptyMemory('shared')), memory = memoryConfig(flatUpdaterVersion);
    add('memory', memoryBody(memory, { current_memory: doc, limits: candidateLimits, session: { id: 's', character_id: 'p', ended_at: '', timezone: 'UTC', messages: [] } }), memory.response_identity);
    add('memory_add',memoryAddBody({timezone:'UTC',previous_assistant:null,current_user:{content:'I like tea.',sent_at:null}}),{allowed_models:['openai/gpt-5.6-luna'],provider:null});
    const cleanup = cleanupConfig(flatCleanupVersion); add('cleanup', cleanupBody(cleanup, doc), cleanup.response_identity);
    const wire = vi.fn(async (_url: unknown, init: RequestInit) => {
      const b = JSON.parse(init.body as string); assertProviderBody(b);
      const envelope = { model: b.model, provider: 'Alternate provider', choices: [{ message: { content: 'Accepted' }, delta: { content: 'Accepted' }, finish_reason: 'stop' }] };
      return new Response(b.stream ? `data: ${JSON.stringify(envelope)}\n\ndata: [DONE]\n\n` : JSON.stringify(envelope));
    }); vi.stubGlobal('fetch', wire); const gateway = new OpenRouter(() => 'synthetic');
    for (const c of cases) {
      const before = JSON.stringify(c.body), routed = prepareProviderRequest(c.body, c.identity ?? { allowed_models: [c.body.model], provider: null });
      const result = c.body.stream ? await gateway.stream(routed.body, new AbortController().signal, () => {}) :
        await gateway.complete(routed.body, routed.identity!, new AbortController().signal, 1000);
      expect(result.content, c.name).toBe('Accepted');
      const sent = JSON.parse(wire.mock.calls.at(-1)![1].body as string);
      expect(sent, c.name).toEqual(routed.body); expect(JSON.stringify(c.body)).toBe(before);
    }
    expect(cases).toHaveLength(40); expect(wire).toHaveBeenCalledTimes(cases.length);
    expect(searchOverlay.max_tool_calls).toBe(4); expect(searchOverlay.tools[0].parameters.max_uses).toBe(2);
    expect(searchOverlay.stop_server_tools_when[0]).toEqual({ type: 'step_count_is', step_count: 4 });
    const cache = hashConfig(speechConfig);
    for (const voice of voices) { const body = speechBody(previewSource, makeSpeechConfig(voice)); assertProviderBody(body, 'speech'); expect(body.voice).toBe(voice); }
    expect(hashConfig(speechConfig)).toBe(cache); expect(speechConfig.provider.only).toEqual(['xai']);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
it('keeps network entry points explicit so a new raw transport cannot bypass the policy boundary', () => {
  const files = readdirSync('src/main').filter(f => f.endsWith('.ts'));
  const direct = files.filter(f => /\bfetch\s*\(/.test(readFileSync(join('src/main', f), 'utf8')));
  expect(direct.sort()).toEqual(['asr-transport.ts', 'transport.ts', 'tts.ts']);
  for (const file of direct) expect(readFileSync(join('src/main',file),'utf8')).toContain('assertProviderBody(');
});
it('sends Lighter and Standard conversation prefixes unchanged through search and central provider admission', async () => {
  const dir=mkdtempSync(join(tmpdir(),'stomylos-reply-wire-')), store=new Store(dir,resolve('native/advisory-lock.node'));
  const wire=vi.fn(async(_url:unknown,init:RequestInit)=>{
    const body=JSON.parse(init.body as string);assertProviderBody(body);
    return new Response(`data: ${JSON.stringify({model:body.model,provider:'Alternate provider',choices:[{delta:{content:'Accepted'},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);
  });vi.stubGlobal('fetch',wire);
  try {
    const gateway=new OpenRouter(()=>'synthetic');
    for(const mode of ['one_point','standard'] as const) {
      const s=store.createSession();store.setReplyContext(s.id,randomUUID(),0,mode);store.searchMode(s.id,'off');
      store.selectManual(s.id,'model_04');store.submit(s.id,'A synthetic answer.',randomUUID(),1);store.commitRoute(s.id,null,'fixture',null);
      const request=store.prepareChat(s.id,randomUUID()), body=store.chatBody(request.id);
      for(const search of [false,true]) {
        const source=withSearch(body,search),before=JSON.stringify(source);
        const routed=prepareProviderRequest(source,{allowed_models:[source.model],provider:null});
        await gateway.stream(routed.body,new AbortController().signal,()=>{});
        const sent=JSON.parse(wire.mock.calls.at(-1)![1].body as string);
        expect(sent.messages).toEqual(body.messages);
        expect(sent.messages.filter((m:any)=>m.content.includes('What are your values?'))).toHaveLength(mode==='one_point'?1:0);
        expect(JSON.stringify(source)).toBe(before);expect(!!sent.tools).toBe(search);
        expect(sent.provider.allow_fallbacks).toBe(true);expect(sent.provider.data_collection).toBe('deny');
      }
      store.end(s.id);store.cancelEnd(s.id);
    }
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});
