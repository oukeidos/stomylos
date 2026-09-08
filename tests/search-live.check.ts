import { expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/main/database';
import { OpenRouter, CompletionFailure, type Gateway } from '../src/main/transport';
import { AppFailure, failureCode } from '../src/main/errors';
import { routeSearch } from '../src/main/search-router';
import { searchHash } from '../src/main/search-contract';
import { keyFilePath, loadKey } from '../src/main/storage';
import type { Json } from '../src/shared/types';

it('runs the frozen 20-reply acceptance matrix within the 44-attempt / USD5 envelope', async () => {
  const directory = process.env.STOMYLOS_SEARCH_VERIFY_DIR!, gate = JSON.parse(readFileSync(join(directory, 'gate.json'), 'utf8'));
  const endpoint = process.env.STOMYLOS_SEARCH_MOCK_ENDPOINT;
  expect(!!endpoint).toBe(gate.mock); expect(gate.maximumCalls).toBe(44); expect(gate.maximumUsd).toBe(5); expect(gate.jobs).toHaveLength(20);
  const resume = process.env.STOMYLOS_SEARCH_RESUME === '1';
  const continuation = resume ? JSON.parse(readFileSync(join(directory, 'continuation.json'), 'utf8')) : null;
  if (continuation) expect(searchHash(readFileSync(join(directory, 'gate.json'), 'utf8'))).toBe(continuation.originalGateHash);
  for (const [path, digest] of Object.entries(continuation?.hashes ?? gate.hashes)) expect(searchHash(readFileSync(path, 'utf8')), path).toBe(digest);
  const ledgerPath = join(directory, 'dispatches.json'); if (existsSync(ledgerPath) && !resume) throw new Error('No automatic resumption of an existing paid ledger.');
  const ledger: Json[] = resume ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : [];
  const report: Json = resume ? JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8')) : { mock: gate.mock, results: [] };
  report.status = 'running'; delete report.failure;
  const save = () => { writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), { mode: 0o600, flush: true });
    writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600, flush: true }); };
  const key = gate.mock ? 'public-key' : loadKey(keyFilePath(process.platform, process.env)); if (!key) throw new Error('External OpenRouter key is missing.');
  const remote = new OpenRouter(() => key, endpoint);
  let activeJob = '';
  const gateway: Gateway = {
    complete: async () => { throw new AppFailure('unexpected_acceptance_call'); },
    stream: async (body, signal, chunk, options) => {
      if (report.budgetOverrun) throw new AppFailure('acceptance_reservation_exceeded');
      const price = gate.prices[body.model]; if (!price) throw new AppFailure('unpriced_acceptance_model');
      const inputBound = Buffer.byteLength(JSON.stringify(body)) + 2048;
      // Reserve for loop spend plus an overshooting step and final generation.
      // This conservative engineering allowance is not a provider billing cap.
      const reservation = gate.mock ? 0 : 1.25 * (body.tools
        ? 0.25 + 2 * ((inputBound + 20000) * price.prompt + body.max_tokens * price.completion + price.request) + 0.002
        : inputBound * price.prompt + body.max_tokens * price.completion + price.request);
      const held = ledger.reduce((n, a) => n + (a.cost ?? a.reservation), 0);
      if (!Number.isFinite(reservation) || ledger.length >= 44 || held + reservation > 5) throw new AppFailure('acceptance_budget_exhausted');
      const attempt: Json = { id: ledger.length + 1, job: activeJob, kind: options?.gate ? 'gate' : 'conversation', model: body.model,
        request: body, request_hash: searchHash(JSON.stringify(body)), reservation, cost: null, status: 'dispatched', at: new Date().toISOString() };
      ledger.push(attempt); save();
      try {
        const result = await remote.stream(body, signal, chunk, options);
        attempt.status = 'complete'; attempt.content = result.content; attempt.metadata = result.metadata;
        attempt.cost = result.metadata.usage?.cost ?? null;
        if (attempt.cost !== null && (!Number.isFinite(attempt.cost) || attempt.cost < 0)) attempt.cost = null;
        if (attempt.cost !== null && attempt.cost > reservation && !gate.mock) { report.budgetOverrun = attempt.id; throw new AppFailure('acceptance_reservation_exceeded'); }
        return result;
      } catch (error) {
        attempt.status = 'failed'; attempt.failure = failureCode(error);
        if (error instanceof CompletionFailure) { attempt.content = error.content; attempt.metadata = error.metadata; attempt.cost = error.metadata.usage?.cost ?? null; }
        throw error;
      } finally { save(); }
    }
  };
  try {
    for (const job of gate.jobs) {
      if (report.budgetOverrun) throw new Error('Reservation exceeded; stop all dispatch.');
      const dispatched = ledger.find(a => a.job === job.id && a.kind === 'conversation');
      if (dispatched) {
        if (dispatched.status !== 'complete' || !report.results.some((r: Json) => r.job === job.id && r.request.status === 'succeeded')) throw new Error('A dispatched conversation cannot be retried by this gate.');
        continue;
      }
      activeJob = job.id; const data = join(directory, job.id); mkdirSync(data, { mode: 0o700, recursive: true });
      const fixed = { utc: gate.frozenAt, timezone: 'UTC', utc_offset_minutes: 0, local_date: gate.frozenAt.slice(0, 10) };
      let store = new Store(data, resolve('native/advisory-lock.node'), () => 0, () => fixed);
      let saved: Json | null = null;
      try {
        const session = store.createSession(), id = session.id;
        let user = store.messages(id).findLast(m => m.role === 'user' && m.content === job.case.current_user);
        if (!user) {
          store.setOpening(id, randomUUID(), session.opening_revision, 'user'); store.selectManual(id, job.partner);
          store.searchMode(id, 'off'); store.submit(id, job.case.seed_user); store.commitRoute(id, null, 'fixed_acceptance_partner', null);
          const fixture = store.prepareChat(id, randomUUID()); store.dispatch(fixture.id); const previous = store.prepareReply(id, fixture.id);
          store.finishReply(fixture.id, previous.id, job.case.previous_assistant, { synthetic_fixture: true });
          store.searchMode(id, job.mode); user = store.submit(id, job.case.current_user);
        } else {
          expect(resume).toBe(true); expect(session.model).toBe(job.model); expect(session.search_mode).toBe(job.mode);
          expect(store.requests(id).at(-1)?.failure).toBe('acceptance_budget_exhausted');
        }
        const started = performance.now();
        const signal = new AbortController().signal;
        await routeSearch({ view: async () => store.searchView(id), prepare: async () => store.searchPrepare(id),
          dispatch: async a => store.searchDispatch(a), finish: async (...args) => store.searchFinish(...args) }, gateway, signal);
        const routingSeconds = (performance.now() - started) / 1000;
        const request = store.prepareChat(id, randomUUID()), body = store.chatBody(request.id); expect(body.model).toBe(job.model);
        if (job.mode === 'off') { expect(store.searchView(id)!.attempts).toHaveLength(0); expect(body.tools).toBeUndefined(); }
        const bubble = store.prepareReply(id, request.id); store.dispatch(request.id); let first: number | null = null;
        try {
          const result = await gateway.stream(body, signal, text => { if (text && first === null) first = (performance.now() - started) / 1000; }, body.tools ? { search: true } : undefined);
          store.finishReply(request.id, bubble.id, result.content, result.metadata);
        } catch (error) { store.failRequest(request.id, failureCode(error), error instanceof CompletionFailure ? error.content : null, error instanceof CompletionFailure ? error.metadata : {}); }
        saved = { job: job.id, model: job.model, mode: job.mode, case: job.case, user_message_id: user.id,
          routingSeconds, firstAnswerSeconds: first, totalSeconds: (performance.now() - started) / 1000,
          gate: store.searchView(id), request: store.request(request.id), body };
        report.results = report.results.filter((r: Json) => r.job !== job.id); report.results.push(saved); save();
        const before = store.view(id); store.close(); store = new Store(data, resolve('native/advisory-lock.node'));
        expect(store.view(id)).toEqual(before);
        console.log(JSON.stringify({ job: job.id, status: saved.request.status, gate: saved.gate?.turn.decision,
          searchCalls: JSON.parse(saved.request.metadata).search?.web_search_requests ?? null,
          seconds: saved.totalSeconds, reportedUsd: ledger.reduce((n, a) => n + (a.cost ?? 0), 0) }));
        if (saved.request.status !== 'succeeded') throw new Error('Conversation failed; inspect saved evidence before any further dispatch.');
      } finally { store.close(); }
    }
    report.status = 'executed'; report.qualityReview = 'Pending manual paired-answer review; operational completion is separate.';
    report.reportedUsd = ledger.reduce((n, a) => n + (a.cost ?? 0), 0);
    report.unknownCostReservationUsd = ledger.filter(a => a.cost === null).reduce((n, a) => n + a.reservation, 0);
    for (const model of new Set<string>(gate.jobs.map((j: Json) => j.model))) {
      expect(report.results.some((r: Json) => r.model === model && JSON.parse(r.request.metadata).search?.web_search_requests > 0)).toBe(true);
    }
    for (const r of report.results) if (!r.case.expected_search) expect(r.body.tools).toBeUndefined();
  } catch (error) { report.status = 'needs_review'; report.failure = String(error); throw error; }
  finally { save(); }
}, 1800000);
