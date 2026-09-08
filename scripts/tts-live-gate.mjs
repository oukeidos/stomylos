// Explicit two-call speech-only gate. Ordinary tests never import this module.
import { readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import assert from 'node:assert/strict';
export async function speechGate(directory) {
  if (!process.argv.includes('--authorize-two-calls') || !isAbsolute(directory ?? '')) throw new Error('Require --authorize-two-calls --run-dir <absolute unused directory>');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'live-gate.json'); if (existsSync(path)) throw new Error('Gate already exists. Inspect it; do not repeat paid calls.');
  const keyPath = join(homedir(), '.stomylos/.env'); const stats = statSync(keyPath);
  if (stats.mode & 0o077 || stats.size > 65536) throw new Error('Key store permissions or size invalid');
  const lines = readFileSync(keyPath, 'utf8').split(/\r?\n/).filter(l => /^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=/.test(l));
  if (lines.length !== 1) throw new Error('Require exactly one OpenRouter key');
  const key = lines[0].replace(/^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=\s*/, '').trim().replace(/^(['"])(.*)\1$/, '$2');
  if (!key || /\s/.test(key)) throw new Error('Invalid key syntax');
  const catalogResponse = await fetch('https://openrouter.ai/api/v1/models/x-ai/grok-voice-tts-1.0/endpoints', { signal: AbortSignal.timeout(20000) });
  if (!catalogResponse.ok) throw new Error('Cannot verify current speech rate');
  const catalog = await catalogResponse.json(); const routes = catalog.data.endpoints.filter(e => e.tag === 'xai');
  const rate = Math.max(...routes.map(e => Number(e.pricing.prompt)));
  if (!routes.length || !Number.isFinite(rate) || rate <= 0 || rate > 0.00003) throw new Error('Speech price changed; inspect before dispatch');
  const report = { status: 'running', maxCalls: 2, maxUsd: 0.10, rate, attempts: [], catalog };
  const save = () => writeFileSync(path, JSON.stringify(report, null, 2), { mode: 0o600, flush: true }); save();
  const handler = async (input, response) => {
    try {
      assert.equal(report.attempts.length < 2, true); assert.equal(input.model, 'x-ai/grok-voice-tts-1.0');
      assert.equal(input.voice, 'ara'); assert.equal(input.speed, 1); assert.equal(input.response_format, 'mp3');
      assert.deepEqual(input.provider, { only: ['xai'], order: ['xai'], allow_fallbacks: false, data_collection: 'deny' });
      assert.equal(input.input.startsWith('[long-pause]'), true);
      const reservation = [...input.input].length * rate * 2;
      assert.ok(report.attempts.reduce((sum, a) => sum + a.reservation, 0) + reservation <= report.maxUsd);
      assert.ok(!report.attempts.some(a => a.status !== 'received'));
      const attempt = { status: 'dispatched', reservation, input, at: new Date().toISOString() };
      report.attempts.push(attempt); save();
      const result = await fetch('https://openrouter.ai/api/v1/audio/speech', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(180000),
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
      attempt.httpStatus = result.status; attempt.generationId = result.headers.get('x-generation-id'); save();
      if (!result.ok || result.headers.get('content-type')?.split(';')[0] !== 'audio/mpeg') throw new Error('Speech request failed');
      const data = new Uint8Array(await result.arrayBuffer()); if (!data.length || data.length > 16 * 1024 * 1024) throw new Error('Invalid speech size');
      attempt.status = 'received'; attempt.bytes = data.length; save();
      response.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': data.length, ...(attempt.generationId ? { 'x-generation-id': attempt.generationId } : {}) }); response.end(data);
    } catch {
      report.status = 'stopped'; save(); response.writeHead(502, { 'content-type': 'application/json' }); response.end('{"error":"Bounded speech gate stopped; inspect its ledger"}');
    }
  };
  const finish = async () => {
    for (const attempt of report.attempts) {
      if (!attempt.generationId) continue;
      try {
        const response = await fetch('https://openrouter.ai/api/v1/generation?id=' + encodeURIComponent(attempt.generationId), { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) });
        if (response.ok) { const { data } = await response.json(); attempt.cost = data.total_cost ?? null; attempt.provider = data.provider_name; attempt.model = data.model; }
      } catch { /* Unknown accounting remains reserved. */ }
    }
    if (report.status !== 'stopped') report.status = report.attempts.length === 2 ? 'two_requests_received' : 'incomplete'; save();
  };
  return { handler, finish };
}
