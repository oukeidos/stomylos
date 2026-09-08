import { expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, type StoreMethod } from '../src/main/database';
import { Coordinator } from '../src/main/coordinator';
import type { DatabaseClient } from '../src/main/db-client';
import { OpenRouter, type Gateway } from '../src/main/transport';
import { keyFilePath, loadKey } from '../src/main/storage';
import { parseStarterQuestions, starterBody, starterGenerators } from '../src/main/starter-renewal';
import { appVersion } from '../src/main/contracts';
import type { AppSnapshot, Json } from '../src/shared/types';

it('verifies exactly one request for each pinned generator through end, admission and reopen', async () => {
  const directory = process.env.STOMYLOS_STARTER_VERIFY_DIR!;
  const gate = JSON.parse(readFileSync(join(directory, 'gate.json'), 'utf8'));
  const endpoint = process.env.STOMYLOS_STARTER_MOCK_ENDPOINT;
  expect(Boolean(endpoint)).toBe(gate.mock); expect(gate.maximumCalls).toBe(3); expect(gate.maximumUsd).toBe(1);
  const routes = starterGenerators.map(g => {
    if (gate.mock) return { prompt: 0, completion: 0 };
    const row = gate.prices.find((r: Json) => r.model === g.model && r.tag === g.tag);
    const provider = row?.response.data.endpoints.find((p: Json) => p.tag === g.tag);
    if (!provider) throw new Error('Pinned route price is missing');
    return { prompt: Number(provider.pricing.prompt), completion: Number(provider.pricing.completion) };
  });
  const reservation = routes.reduce((n, price, i) => n + gate.inputTokenBound * price.prompt + starterGenerators[i].max_tokens * price.completion, 0);
  expect(Number.isFinite(reservation)).toBe(true); expect(reservation).toBeLessThanOrEqual(1);
  const report: Json = { status: 'running', mock: gate.mock, appVersion, directory, reservationUsd: reservation, maximumUsd: 1,
    calls: 0, unrelatedCalls: 0, knownCostUsd: 0, results: [] };
  const ledger = join(directory, 'dispatches.json');
  if (!existsSync(ledger)) writeFileSync(ledger, '[]', { flag: 'wx', mode: 0o600, flush: true });
  report.calls = JSON.parse(readFileSync(ledger, 'utf8')).length;
  const key = gate.mock ? 'public-fixture-key' : loadKey(keyFilePath(process.platform, process.env));
  if (!key) throw new Error('External OpenRouter key is missing');
  const remote = new OpenRouter(() => key, endpoint);
  let store: Store | null = null; let controller: Coordinator | null = null;
  try {
    for (const [index, model] of starterGenerators.entries()) {
      const data = join(directory, `model-${index}`);
      if (existsSync(data)) {
        // Inspect existing successful attempts locally. Failed/unknown attempts cannot dispatch again.
        store = new Store(data, resolve('native/advisory-lock.node'));
        const sessions = store.sessions(); expect(sessions).toHaveLength(1); const id = sessions[0].id;
        const job = store.starterJob(id)!; const attempts = store.starterAttempts(job.id); expect(attempts).toHaveLength(1);
        const attempt = attempts[0]; const metadata = JSON.parse(attempt.metadata);
        expect(job.state).toBe('completed'); expect(attempt.status).toBe('succeeded');
        expect(job.model).toBe(model.model); expect(starterBody(JSON.parse(job.config), job.input_json).model).toBe(model.model);
        expect(parseStarterQuestions(attempt.response_content!)).toHaveLength(2);
        expect(attempt.accepted_count).toBeGreaterThanOrEqual(0); expect(attempt.accepted_count).toBeLessThanOrEqual(2);
        expect(metadata.provider).toBe(model.provider); expect(metadata.usage?.cost).toBeTypeOf('number');
        expect(JSON.parse(readFileSync(ledger, 'utf8')).filter((r: Json) => r.model === model.model)).toHaveLength(1);
        const saved = store.view(id); const inventory = store.starterInventory(); store.close();
        store = new Store(data, resolve('native/advisory-lock.node')); expect(store.view(id)).toEqual(saved); expect(store.starterInventory()).toEqual(inventory);
        report.results.push({ model: model.model, state: job.state, accepted: attempt.accepted_count, status: attempt.status, failure: attempt.failure, metadata, recheckedWithoutRequest: true });
        report.knownCostUsd += metadata.usage.cost; store.close(); store = null; continue;
      }
      mkdirSync(data, { mode: 0o700 });
      store = new Store(data, resolve('native/advisory-lock.node'), () => index);
      let snapshot: AppSnapshot | null = null;
      const db = { ready: Promise.resolve(), async call(method: StoreMethod, ...args: any[]) { return (store![method] as Function).apply(store, args); },
        async close() { store!.close(); } } as unknown as DatabaseClient;
      const gateway: Gateway = {
        async complete(body, identity, signal, timeout) {
          if (body.response_format) {
            const router = body.response_format.json_schema.name.startsWith('stomylos_character_scores_v');
            return { metadata: {}, content: JSON.stringify(router ? Object.fromEntries(body.response_format.json_schema.schema.required.map((id: string) => [id, ['informative_generalist', 'model_03'].includes(id) ? 2 : 1])) :
              { units: JSON.parse(body.messages[1].content).filter((m: Json) => m.role === 'user').map((m: Json) => ({ ...(m.index === undefined ? { text: m.content } : { index: m.index }), corrected_text: m.content, explanation: '' })) }) };
          }
          expect(body.model).toBe(model.model); expect(body.provider.only).toEqual([model.tag]);
          const inputBound = body.messages.reduce((n: number, m: Json) => n + Buffer.byteLength(m.content) + 64, 256);
          expect(inputBound).toBeLessThanOrEqual(gate.inputTokenBound);
          const dispatches = JSON.parse(readFileSync(ledger, 'utf8'));
          expect(dispatches.length).toBeLessThan(3); expect(dispatches.some((r: Json) => r.model === body.model)).toBe(false);
          dispatches.push({ model: body.model, inputBound, max_tokens: body.max_tokens, reservedUsd: inputBound * routes[index].prompt + body.max_tokens * routes[index].completion });
          writeFileSync(ledger, JSON.stringify(dispatches), { mode: 0o600, flush: true }); report.calls++;
          return remote.complete(body, identity, signal, timeout);
        },
        async stream(_body, _signal, update) {
          const content = 'A familiar walk can make small changes easier to notice. The place stays recognizable while its details keep moving.';
          update(content); return { content, metadata: {} };
        }
      };
      controller = new Coordinator(db, gateway, { keyPresent: true, keyPath: 'external-key-not-shown', dataPath: data, appVersion, development: true },
        event => { if (event.type === 'snapshot') snapshot = event.snapshot; }, () => true);
      await controller.initialize(); const id = store.unfinished()!.id;
      for (const [i, text] of ['I noticed the river was unusually clear on my morning walk.', 'Later I read about maps and wondered how they change what people notice.'].entries()) {
        await controller.command('sendMessage', { sessionId: id, text, revision: i + 1 });
        await vi.waitFor(() => expect(snapshot?.activity.phase).toBe('idle'), { timeout: 3000, interval: 10 });
      }
      await controller.command('endSession', { sessionId: id });
      await vi.waitFor(() => expect(['completed', 'failed', 'interrupted']).toContain(store!.starterJob(id)?.state), { timeout: 190000, interval: 100 });
      const job = store.starterJob(id)!; const attempts = store.starterAttempts(job.id);
      const attempt = attempts[0]; const metadata = JSON.parse(attempt.metadata);
      report.results.push({ model: model.model, state: job.state, accepted: attempt.accepted_count, status: attempt.status, failure: attempt.failure, metadata });
      report.knownCostUsd += metadata.usage?.cost ?? 0;
      expect(attempts).toHaveLength(1); expect(job.state).toBe('completed'); expect(parseStarterQuestions(attempt.response_content!)).toHaveLength(2);
      expect(attempt.accepted_count).toBeGreaterThanOrEqual(0); expect(attempt.accepted_count).toBeLessThanOrEqual(2);
      expect(metadata.provider).toBe(model.provider); expect(metadata.usage?.cost).toBeTypeOf('number');
      const saved = store.view(id); const inventory = store.starterInventory();
      await controller.command('close', undefined); controller = null; store = new Store(data, resolve('native/advisory-lock.node'));
      expect(store.view(id)).toEqual(saved); expect(store.starterInventory()).toEqual(inventory); store.close(); store = null;
      console.log(`Verified generator ${index + 1}/3: ${model.model}`);
    }
    expect(report.calls).toBe(3); expect(report.knownCostUsd).toBeLessThanOrEqual(1); report.status = 'passed';
  } finally {
    if (controller) await controller.command('close', undefined).catch(() => undefined);
    store?.close(); if (report.status !== 'passed') report.status = 'failed';
    writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  }
}, 600000);
