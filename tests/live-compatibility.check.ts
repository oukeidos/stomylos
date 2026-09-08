import { expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { characters, conversationBody, conversationSnapshot, starters } from '../src/main/contracts';
import { keyFilePath, loadKey } from '../src/main/storage';
import { OpenRouter } from '../src/main/transport';
import { failureCode } from '../src/main/errors';
import type { Json, Message } from '../src/shared/types';
it('makes at most one compatibility call to each remaining selected endpoint', async () => {
  const directory = process.env.STOMYLOS_LIVE_DIR!;
  if (!directory?.startsWith('/tmp/stomylos-live-')) throw new Error('An explicitly authorized integrated live run is required');
  const integrated = JSON.parse(readFileSync(join(directory, 'integrated.json'), 'utf8'));
  expect(integrated.requests.length).toBe(4); expect(integrated.requests.every((r: Json) => r.status === 'succeeded')).toBe(true);
  const marker = join(directory, 'compatibility-started');
  if (existsSync(marker)) throw new Error('This bounded run already started; do not retry it automatically');
  writeFileSync(marker, 'One call per remaining selected partner.\n', { flag: 'wx', mode: 0o600, flush: true });
  const endpoint = process.env.STOMYLOS_LIVE_MOCK_ENDPOINT;
  if (endpoint && (!directory.startsWith('/tmp/stomylos-live-mock-') || !/^http:\/\/127\.0\.0\.1:\d+\/completion$/.test(endpoint))) throw new Error('Invalid local mock endpoint');
  const key = endpoint ? 'public-mock-key' : loadKey(keyFilePath(process.platform, process.env)); if (!key) throw new Error('API key unavailable');
  const gateway = new OpenRouter(() => key, endpoint); const results: Json[] = [];
  const source = [
    { role: 'assistant', origin: 'starter', content: starters[0].text },
    { role: 'user', origin: 'learner', content: 'I like taking a quiet walk before I start work. It helps me notice small things around me.' }
  ] as Message[];
  for (const partner of characters.filter(c => c.id !== integrated.session.character)) {
    try {
      const result = await gateway.stream(conversationBody(conversationSnapshot(), partner.id, starters[0].text, source), new AbortController().signal, () => {});
      results.push({ character: partner.id, requestedModel: partner.model, status: 'succeeded', metadata: result.metadata });
    } catch (error) { results.push({ character: partner.id, requestedModel: partner.model, status: 'failed', failure: failureCode(error) }); }
    writeFileSync(join(directory, 'compatibility.json'), JSON.stringify(results), { mode: 0o600, flush: true });
    console.log(`${partner.label}: ${results.at(-1)!.status}`);
    if (results.at(-1)!.status === 'failed') break;
  }
  expect(results).toHaveLength(4); expect(results.every(r => r.status === 'succeeded')).toBe(true);
}, 490000);
