import { expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { conversationBody, conversationSnapshot, conversationSystem } from '../src/main/contracts';
import { renderAssociative, type AssociativeItem } from '../src/main/associative-recall';
import { memoryControlVersion } from '../src/shared/memory-control';
import { recordedTime, temporalHash, timeSources } from '../src/main/time-context';
import { prepareProviderRequest } from '../src/main/provider-policy';
import { keyFilePath, loadKey } from '../src/main/storage';
import { OpenRouter, CompletionFailure } from '../src/main/transport';
import { failureCode } from '../src/main/errors';
import type { Json, Message } from '../src/shared/types';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const fixed = recordedTime('2026-09-12T00:00:00.000Z', 'Asia/Seoul', 540);
const text = (value: unknown) => typeof value === 'string' ? value.toLowerCase() : '';

function bodyFor(job: Json): Json {
  const messages: Message[] = [{ id: `synthetic-${job.id}`, session_id: 'synthetic', sequence: 1, role: 'user', origin: 'learner',
    delivery: 'complete', request_id: null, content: job.case.current_user }];
  const item: AssociativeItem = { id: `recall-${job.id}`, text: job.case.recalled_text, text_hash: digest(job.case.recalled_text), source_order: 0 };
  const snapshot = conversationSnapshot('user');
  snapshot.memory_control = memoryControlVersion;
  snapshot.associative_recall = { version: 'stomylos_associative_recall_v1', query_ids: [`synthetic-${job.id}`], source_revision: 1,
    threshold: 0.78, items: [item], block: renderAssociative([item]), reason: 'selected' };
  snapshot.time_context = { reply_reference: fixed, sources: timeSources(messages, () => fixed) };
  snapshot.temporal_source_hash = temporalHash(snapshot.time_context.sources);
  snapshot.system_sha256 = digest(conversationSystem(snapshot, messages));
  const body = conversationBody(snapshot, job.character, null, messages);
  body.max_tokens = job.response_token_cap;
  return prepareProviderRequest(body).body;
}

it('sends one standard-role associative-recall request for every current conversation model and frozen sample case', async () => {
  const directory = process.env.STOMYLOS_ASSOCIATIVE_RECALL_VERIFY_DIR!;
  if (!directory?.startsWith('/tmp/stomylos-associative-recall-live-')) throw new Error('An explicitly authorized isolated live run is required');
  const gate = JSON.parse(readFileSync(join(directory, 'gate.json'), 'utf8'));
  const ledgerPath = join(directory, 'ledger.json');
  if (existsSync(ledgerPath)) throw new Error('This paid run already started; inspect its ledger rather than retrying it automatically');
  const key = loadKey(keyFilePath(process.platform, process.env));
  if (!key) throw new Error('External OpenRouter key is missing.');
  const remote = new OpenRouter(() => key), ledger: Json[] = [], report: Json = { status: 'running', results: [] };
  const save = () => { writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), { mode: 0o600, flush: true });
    writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600, flush: true }); };
  try {
    for (const job of gate.jobs) {
      const body = bodyFor(job);
      const messages = body.messages as Json[];
      expect(messages.map(message => message.role)).toEqual(['system', 'user']);
      expect(messages[1].content).toContain('<associative_recall>');
      expect(body.provider.data_collection).toBe('deny');
      expect(body.provider.allow_fallbacks).toBe(true);
      const reservation = job.reservation_usd;
      const committed = ledger.reduce((sum, item) => sum + (item.cost ?? item.reservation_usd), 0);
      if (ledger.length >= gate.maximum_calls || committed + reservation > gate.maximum_usd) throw new Error('Acceptance reservation exhausted before dispatch.');
      const attempt: Json = { id: ledger.length + 1, job: job.id, model: body.model, reservation_usd: reservation, cost: null,
        status: 'dispatched', at: new Date().toISOString(), request: { model: body.model, max_tokens: body.max_tokens,
          roles: messages.map(message => message.role), final_user_has_associative_block: messages.at(-1)?.content.includes('<associative_recall>') === true,
          provider: body.provider } };
      ledger.push(attempt); save();
      try {
        const result = await remote.stream(body, new AbortController().signal, () => {});
        attempt.status = 'complete'; attempt.cost = result.metadata.usage?.cost ?? null; attempt.metadata = result.metadata; attempt.content = result.content;
        const answer = text(result.content), signals = job.case.signals;
        const contains = signals.contains_any.map((value: string) => answer.includes(value.toLowerCase()));
        const excluded = signals.excludes.map((value: string) => answer.includes(value.toLowerCase()));
        const review = { contains_any: signals.contains_any, contains_any_passed: !signals.contains_any.length || contains.some(Boolean),
          excludes: signals.excludes, excludes_passed: !excluded.some(Boolean), manual_review: 'Signals are a bounded screen, not a semantic correctness claim.' };
        report.results.push({ job: job.id, case: job.case.id, kind: job.case.kind, character: job.character, model: body.model,
          status: 'succeeded', response: result.content, metadata: result.metadata, review });
      } catch (error) {
        attempt.status = 'failed'; attempt.failure = failureCode(error);
        if (error instanceof CompletionFailure) { attempt.content = error.content; attempt.metadata = error.metadata; attempt.cost = error.metadata.usage?.cost ?? null; }
        report.results.push({ job: job.id, case: job.case.id, character: job.character, model: body.model, status: 'failed', failure: attempt.failure });
      }
      save();
    }
    report.status = report.results.some((result: Json) => result.status === 'failed') ? 'executed_with_failures' : 'executed';
    report.reported_usd = ledger.reduce((sum, item) => sum + (item.cost ?? 0), 0);
    report.unreported_reservation_usd = ledger.filter(item => item.cost === null).reduce((sum, item) => sum + item.reservation_usd, 0);
    expect(report.results).toHaveLength(gate.jobs.length);
  } catch (error) { report.status = 'needs_review'; report.failure = String(error); throw error; }
  finally { save(); }
}, 900_000);
