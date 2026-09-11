import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { build } from 'vite';
import { catalogCompatibility } from '../catalog-compat-plugin';
import { DatabaseClient } from '../src/main/db-client';
import { routerSnapshot, routerBody } from '../src/main/contracts';
import { recoverRouter } from '../src/main/router-recovery';
import { AppFailure } from '../src/main/errors';
import type { Store } from '../src/main/database';
import type { Gateway } from '../src/main/transport';
import type { Json } from '../src/shared/types';

let bundle: string;
beforeAll(async () => {
  mkdirSync('test-results', { recursive: true });
  bundle = mkdtempSync(resolve('test-results/router-worker-'));
  await build({ configFile: false, plugins: [catalogCompatibility()], logLevel: 'silent',
    build: { ssr: resolve('src/main/db-worker.ts'), outDir: bundle, minify: false,
      rollupOptions: { output: { format: 'cjs', entryFileNames: 'worker.cjs' } } } });
}, 30000);
afterAll(() => { if (bundle) rmSync(bundle, { recursive: true, force: true }); });

it.each([false, true])('persists Auto routing through the real worker (fallback: %s)', async fallback => {
  const directory = mkdtempSync(join(tmpdir(), 'stomylos-router-worker-'));
  const db = new DatabaseClient(join(bundle, 'worker.cjs'), directory, resolve('native/advisory-lock.node'), () => {});
  try {
    await db.ready;
    const session = await db.call('createSession');
    await db.call('searchMode', session.id, 'off');
    await db.call('submit', session.id, 'Explain this idea.');
    const saved = JSON.parse((await db.call('session', session.id)).chat_config);
    const first = await db.call('createRequest', session.id, 'router', routerSnapshot(saved));
    const content = JSON.stringify(Object.fromEntries(saved.characters.map((c: Json) => [c.id, c.id === 'model_09' ? 2 : 1])));
    let calls = 0;
    const gateway = { complete: vi.fn(async () => {
      if (++calls === 1 && fallback) throw new AppFailure('request_timeout');
      return { content, metadata: {} };
    }), stream: vi.fn() } as Gateway;
    const result = await recoverRouter(first, saved, routerBody(session.starter_text, 'Explain this idea.', saved), {
      prepare: (id, body, identity) => db.call('prepareProvider', 'model', id, body, identity),
      dispatch: id => db.call('dispatch', id),
      finish: (...args: Parameters<Store['finishRecoveryRoute']>) => db.call('finishRecoveryRoute', ...args),
      secondary: id => db.call('prepareRouterRecovery', id, randomUUID())
    }, gateway, new AbortController().signal);
    await db.call('commitRoute', session.id, result.scores, result.failure, result.request.id);
    expect((await db.call('session', session.id)).character).toBe('model_09');
    const attempts = await db.call('requests', session.id);
    expect(attempts).toHaveLength(fallback ? 2 : 1);
    expect(attempts.at(-1)?.status).toBe('succeeded');
    const routed = JSON.parse((attempts.at(-1) as any).provider_request);
    expect(routed.body.provider).toEqual({ require_parameters: true, allow_fallbacks: true, data_collection: 'deny' });
    expect(routed.identity.provider).toBeNull();
    expect(JSON.parse(first.config).parameters.provider.only).toEqual(['openai']);
    if (fallback) expect(attempts[1].parent_id).toBe(first.id);
    expect(gateway.complete).toHaveBeenCalledTimes(fallback ? 2 : 1);
    expect((await db.call('integrity')).foreignKeys).toEqual([]);
    await expect((db.call as Function)('unsupportedTestOperation')).rejects.toThrow('database_operation_unsupported');
    expect((await db.call('session', session.id)).character).toBe('model_09');
  } finally {
    await db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
