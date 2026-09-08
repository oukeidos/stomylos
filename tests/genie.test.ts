import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import fixtures from './fixtures/genie-r3.json';
import { genieBody, genieRange, genieReplacement, parseGenie, genieIdentity, genieLimits } from '../src/main/genie';
import { validateEnvelope } from '../src/main/contracts';
import { validateCommand } from '../src/main/ipc';
import { GenieController } from '../src/main/genie-controller';
import { AppFailure } from '../src/main/errors';
import type { GenieSource, GenieRange } from '../src/shared/genie';
import type { Gateway } from '../src/main/transport';
import { moveGenieSelection, sourceOffset, displayOffset } from '../src/renderer/genie-selection';
const whole: GenieRange = { start: 0, end: 0, direction: 'none', scope: 'draft' };
const source = (text = 'I goes walking.'): GenieSource => ({ sessionId: 's', text, revision: 1, contextHash: 'context', messages: [] });
it('extends a read-only selection by graphemes and supports backward selection and select all', () => {
  expect(moveGenieSelection('😀e\u0301 next', 0, 0, 'none', 'ArrowRight', true)).toEqual({ start: 0, end: 2, direction: 'forward' });
  expect(moveGenieSelection('😀e\u0301 next', 2, 2, 'none', 'ArrowRight', true)).toEqual({ start: 2, end: 4, direction: 'forward' });
  expect(moveGenieSelection('one\ntwo', 5, 5, 'none', 'Home', true)).toEqual({ start: 4, end: 5, direction: 'backward' });
  expect(moveGenieSelection('one\ntwo', 4, 5, 'backward', 'ArrowLeft', true)).toEqual({ start: 3, end: 5, direction: 'backward' });
  expect(moveGenieSelection('one', 1, 1, 'none', 'a', false, true)).toEqual({ start: 0, end: 3, direction: 'forward' });
  expect(moveGenieSelection('\ntext', 0, 0, 'none', 'Home', true)?.start).toBe(0);
});
it('maps textarea-normalized line endings back to exact saved source offsets', () => {
  const raw = '😀\r\nsame\rsame\r\nsame';
  const displayed = raw.replace(/\r\n?/g, '\n'), start = displayed.lastIndexOf('same');
  expect(sourceOffset(raw, start)).toBe(raw.lastIndexOf('same'));
  expect(displayOffset(raw, sourceOffset(raw, start))).toBe(start);
  expect(raw.slice(sourceOffset(raw, start), sourceOffset(raw, start + 4))).toBe('same');
});
it('uses exact selected prompt/schema bytes and all 27 R3 requests, including actual assistant JSON follow-ups', () => {
  for (const [file, name] of Object.entries({ 'prompt-v1.txt': 'genie-prompt.txt', 'structured-scope-v1.txt': 'genie-scope.txt', 'structured-output-v1.txt': 'genie-output.txt', 'structured-schema-v1.json': 'genie-schema.json' })) {
    expect(createHash('sha256').update(readFileSync(`src/main/${name}`)).digest('hex')).toBe(fixtures.hashes[file as keyof typeof fixtures.hashes]);
  }
  let noChange = 0;
  for (const sample of fixtures.samples) {
    const input = JSON.parse(sample.body.messages[1].content), s = { ...source(input.draft), messages: input.main_chat };
    const selection = input.target_selection;
    const range: GenieRange = selection ? { start: Array.from(input.draft).slice(0, selection.start).join('').length,
      end: Array.from(input.draft).slice(0, selection.end).join('').length, scope: 'selection', direction: 'forward' } : genieRange(s.text, whole);
    expect(genieBody(s, range, sample.body.messages.slice(2), input.help_request)).toEqual(sample.body);
    expect(JSON.parse(genieBody(s, range).messages[1].content).help_request).toBe('Help!');
    const content = validateEnvelope(sample.response, genieIdentity).content, reply = parseGenie(content);
    const replacement = genieReplacement(s, range, reply);
    if (reply.suggested_text === s.text.slice(range.start, range.end)) { expect(replacement).toBeNull(); noChange++; }
    if (replacement !== null && selection) {
      expect(replacement).toBe(s.text.slice(0, range.start) + reply.suggested_text + s.text.slice(range.end));
    }
  }
  expect(noChange).toBe(2);
});
it.each(['{"reply":"x","suggested_text":null,"extra":1}', '{"reply":"x","reply":"y","suggested_text":null}',
  '{"reply":"x","suggested_text":"  "}', '{"reply":"","suggested_text":null}', '```json\n{}\n```',
  '{"reply":1,"suggested_text":null}', '{"reply":"x"}', '[]', '{"reply":"x","suggested_text":null} trailing'])('rejects unusable output: %s', content => {
  expect(() => parseGenie(content)).toThrow();
});
it('preserves literal punctuation, line endings, repeated phrases and Unicode with app-owned offsets', () => {
  const s = source('😀 e\u0301 same\r\nsame "quoted".'), start = s.text.lastIndexOf('same'), range: GenieRange = { start, end: start + 4, direction: 'backward', scope: 'selection' };
  expect(JSON.parse(genieBody(s, range).messages[1].content).target_selection).toEqual({ text: 'same', start: start - 1, end: start + 3, offset_unit: 'unicode_codepoints' });
  expect(genieReplacement(s, range, { reply: '', suggested_text: '"new"\nline' })).toBe('😀 e\u0301 same\r\n"new"\nline "quoted".');
  expect(() => genieRange(s.text, { ...range, start: 1 })).toThrow('genie_range');
  expect(() => genieRange(s.text, { ...range, end: 999 })).toThrow('genie_range');
  expect(genieReplacement(source('Hi.'), genieRange('Hi.', whole), { reply: '', suggested_text: 'Hi. ' })).toBe('Hi. ');
  expect(genieBody(source('Hi.'), { ...whole, end: 3, scope: 'selection' }).messages[0].content).toContain('app-owned target_selection');
});
it('bounds full serialized context without truncation and validates exact IPC keys', () => {
  expect(() => genieBody(source('a'.repeat(genieLimits.draft + 1)), whole)).toThrow('genie_limit');
  const s = source('a'.repeat(genieLimits.draft)); expect(genieBody(s, genieRange(s.text, whole)).messages[1].content).toContain(s.text);
  expect(() => genieBody(s, whole, [{ role: 'user', content: 'x'.repeat(256000) }])).toThrow('genie_limit');
  const blank = [{ role: 'user', content: '' }];
  const overhead = Buffer.byteLength(JSON.stringify(genieBody(source(), whole, blank)));
  const content = 'x'.repeat(genieLimits.body - overhead);
  expect(Buffer.byteLength(JSON.stringify(genieBody(source(), whole, [{ role: 'user', content }])))).toBe(genieLimits.body);
  expect(() => genieBody(source(), whole, [{ role: 'user', content: content + 'x' }])).toThrow('genie_limit');
  const args = { sessionId: 's', text: 'x', revision: 1, range: whole, operationId: 'op' };
  expect(() => validateCommand('genieOpen', args)).not.toThrow();
  for (const extra of [{ model: 'other' }, { messages: [] }, { text: 'x'.repeat(100001) }, { range: { ...whole, extra: 1 } }, { revision: -1 }]) {
    expect(() => validateCommand('genieOpen', { ...args, ...extra })).toThrow('invalid_command');
  }
  expect(() => validateCommand('genieDraft', { episodeId: 'e', text: '한'.repeat(2667), revision: 1 })).toThrow();
});
it.each([{ model: 'wrong' }, { provider: 'wrong' }, { choices: [{ finish_reason: 'length', message: { content: '{"reply":"x","suggested_text":"y"}' } }] },
  { choices: [{ finish_reason: 'stop', message: { refusal: 'refused', content: '{"reply":"x","suggested_text":"y"}' } }] }])('rejects mismatched/unfinished/refused envelopes', change => {
  expect(() => validateEnvelope({ ...fixtures.samples[0].response, ...change }, genieIdentity)).toThrow();
});

function rig() {
  let saved = source(), response = '{"reply":"Try this.","suggested_text":"I go walking."}';
  const gateway = { complete: vi.fn(async () => ({ content: response, metadata: {} })), stream: vi.fn() } as unknown as Gateway;
  const hooks = { source: vi.fn(async (_id, text, revision) => { if (text !== saved.text || revision !== saved.revision) throw new AppFailure('genie_stale'); return structuredClone(saved); }),
    save: vi.fn(async (_s, text, revision) => { saved = { ...saved, text, revision }; }), emit: vi.fn() };
  const c = new GenieController(gateway, hooks);
  const open = () => c.open({ sessionId: 's', text: saved.text, revision: saved.revision, range: whole, operationId: 'open' });
  return { c, gateway, hooks, open, setResponse: (s: string) => { response = s; }, saved: () => saved };
}
const ready = async (c: GenieController) => vi.waitFor(() => expect(c.snapshot().episode?.phase).toBe('ready'));
it('resumes without inference, deduplicates apply/undo and never edits outside the original source', async () => {
  const r = rig(); await r.open(); await ready(r.c); const e = r.c.snapshot().episode!;
  await r.c.cancel(e.id, true); await r.open(); expect(r.gateway.complete).toHaveBeenCalledTimes(1);
  const args = { episodeId: e.id, candidateId: e.candidateId!, revision: 2, operationId: 'apply' };
  const result = await r.c.apply(args); expect(result.text).toBe('I go walking.'); expect(await r.c.apply(args)).toEqual(result);
  expect(r.hooks.save).toHaveBeenCalledTimes(1);
  await expect(r.c.apply({ ...args, revision: 3 })).rejects.toThrow('genie_operation_conflict');
  expect((await r.c.undo({ undoId: 'apply', revision: 3, operationId: 'undo' })).text).toBe('I goes walking.');
  expect(r.gateway.complete).toHaveBeenCalledTimes(1);
});
it('passes actual JSON history, invalidates old candidates and submits a follow-up only once', async () => {
  const r = rig(); await r.open(); await ready(r.c); const e = r.c.snapshot().episode!;
  const raw = '{ "reply": "What kind?", "suggested_text": null }'; r.setResponse(raw);
  await r.c.submit({ episodeId: e.id, text: 'Not every day.', revision: 1, operationId: 'follow' }); await ready(r.c);
  await r.c.submit({ episodeId: e.id, text: 'Not every day.', revision: 1, operationId: 'follow' });
  expect(r.gateway.complete).toHaveBeenCalledTimes(2); expect(r.c.snapshot().episode!.candidateId).toBeNull();
  await expect(r.c.apply({ episodeId: e.id, candidateId: e.candidateId!, revision: 2, operationId: 'bad' })).rejects.toThrow('genie_stale');
  await r.c.submit({ episodeId: e.id, text: '한국어 /end', revision: 3, operationId: 'follow2' }); await ready(r.c);
  const body = vi.mocked(r.gateway.complete).mock.calls[2][0];
  expect(body.messages.at(-2)).toEqual({ role: 'assistant', content: raw });
  expect(body.messages.at(-1)).toEqual({ role: 'user', content: '한국어 /end' });
});
it('drops a late cancelled response and retries the frozen request without duplicate history', async () => {
  const r = rig(); let release!: (value: any) => void;
  vi.mocked(r.gateway.complete).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  await r.open(); const e = r.c.snapshot().episode!;
  const closing = r.c.cancel(e.id, true); release({ content: '{"reply":"late","suggested_text":"bad"}', metadata: {} }); await closing;
  expect(r.c.snapshot().episode).toMatchObject({ phase: 'interrupted', candidateId: null, open: false });
  await r.open(); expect(r.gateway.complete).toHaveBeenCalledTimes(1);
  await r.c.retry(e.id, 'retry'); await ready(r.c);
  expect(vi.mocked(r.gateway.complete).mock.calls[0][0]).toEqual(vi.mocked(r.gateway.complete).mock.calls[1][0]);
  expect(r.c.snapshot().episode!.turns).toHaveLength(1);
});
it('does not dispatch a follow-up closed while source validation is in progress', async () => {
  const r = rig(); await r.open(); await ready(r.c); const e = r.c.snapshot().episode!;
  let release!: (v: GenieSource) => void;
  r.hooks.source.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const submitting = r.c.submit({ episodeId: e.id, text: 'more', revision: 1, operationId: 'race' });
  await r.c.cancel(e.id, true); release(e.source); await expect(submitting).rejects.toThrow('genie_stale');
  expect(r.gateway.complete).toHaveBeenCalledTimes(1);
});
it.each(['apply', 'target'])('rejects %s if the dialog closes during source validation', async action => {
  const r = rig(); await r.open(); await ready(r.c); const e = r.c.snapshot().episode!;
  let release!: (v: GenieSource) => void;
  r.hooks.source.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const operation = action === 'apply' ? r.c.apply({ episodeId: e.id, candidateId: e.candidateId!, revision: 2, operationId: 'race' }) : r.c.target(e.id, whole, 'race');
  await r.c.cancel(e.id, true); release(e.source); await expect(operation).rejects.toThrow('genie_stale');
  expect(r.gateway.complete).toHaveBeenCalledTimes(1); expect(r.hooks.save).not.toHaveBeenCalled();
});
it('handles exact no-change without an apply action and preserves the temporary follow-up on resume', async () => {
  const r = rig(); r.setResponse('{"reply":"","suggested_text":"I goes walking."}'); await r.open(); await ready(r.c);
  const e = r.c.snapshot().episode!; expect(e.candidateId).toBeNull();
  r.c.updateDraft(e.id, 'unfinished clarification', 2); r.c.updateDraft(e.id, 'stale', 1);
  await r.c.cancel(e.id, true); await r.open(); expect(r.c.snapshot().episode!.followup).toBe('unfinished clarification');
  await r.c.dispose(); expect(r.c.snapshot().episode).toBeNull(); expect(r.gateway.complete).toHaveBeenCalledTimes(1);
});
it('limits follow-up bytes and deduplicates target changes', async () => {
  const r = rig(); await r.open(); await ready(r.c); const e = r.c.snapshot().episode!;
  r.c.updateDraft(e.id, 'x'.repeat(8000), 1);
  expect(() => r.c.updateDraft(e.id, 'x'.repeat(8001), 2)).toThrow('genie_limit');
  expect(r.c.snapshot().episode!.followup).toHaveLength(8000);
  const range: GenieRange = { start: 2, end: 6, direction: 'forward', scope: 'selection' };
  const changed = await r.c.target(e.id, range, 'target'); await ready(r.c);
  expect(await r.c.target(e.id, range, 'target')).toEqual(changed); expect(r.gateway.complete).toHaveBeenCalledTimes(2);
  await expect(r.c.target(e.id, { ...range, end: 7 }, 'target')).rejects.toThrow('genie_operation_conflict');
});
