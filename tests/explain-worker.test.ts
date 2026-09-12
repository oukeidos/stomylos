import { expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { build } from 'vite';
import { catalogCompatibility } from '../catalog-compat-plugin';
import { Store } from '../src/main/database';
import { DatabaseClient } from '../src/main/db-client';
import { ExplainController } from '../src/main/explain-controller';
import { AppFailure } from '../src/main/errors';
import type { Gateway } from '../src/main/transport';

it('opens, retries, saves and reloads explanations through the real worker', async () => {
  mkdirSync('test-results', { recursive: true });
  const bundle = mkdtempSync(resolve('test-results/explain-worker-'));
  const directory = mkdtempSync(join(tmpdir(), 'stomylos-explain-worker-'));
  const native = resolve('native/advisory-lock.node');
  let db: DatabaseClient | undefined;
  let controller: ExplainController | undefined;
  try {
    const store = new Store(directory, native);
    const session = store.createSession();
    store.setOpening(session.id, randomUUID(), session.opening_revision, 'user');
    const user = store.submit(session.id, 'I watched a movie.');
    const source = 'What stuck with you most?', messageId = randomUUID();
    const fixture = (store as unknown as { db: Database.Database }).db;
    fixture.prepare("INSERT INTO messages(id,session_id,sequence,role,content,origin,delivery) VALUES(?,?,?,'assistant',?,'model','complete')")
      .run(messageId, session.id, user.sequence + 1, source);
    store.close();
    await build({ configFile: false, plugins: [catalogCompatibility()], logLevel: 'silent',
      build: { ssr: resolve('src/main/db-worker.ts'), outDir: bundle, minify: false,
        rollupOptions: { output: { format: 'cjs', entryFileNames: 'worker.cjs' } } } });
    db = new DatabaseClient(join(bundle, 'worker.cjs'), directory, native, () => {});
    await db.ready;
    const complete = vi.fn().mockRejectedValueOnce(new AppFailure('request_timeout'))
      .mockResolvedValue({ content: 'What do you remember most?', metadata: {} });
    controller = new ExplainController(db, { complete } as unknown as Gateway, () => {}, () => true);
    const target = { sessionId: session.id, messageId, source, start: 0, end: source.length };
    const record = await controller.open(target);
    await vi.waitFor(async () => expect((await db!.call('explainGet', record.id)).state).toBe('failed'));
    expect((await controller.open(target)).state).toBe('failed');
    expect(complete).toHaveBeenCalledTimes(1);
    await controller.retry(record.id);
    await vi.waitFor(async () => expect((await db!.call('explainGet', record.id)).state).toBe('ready'));
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1][0].provider).toEqual({ require_parameters: true, allow_fallbacks: true, data_collection: 'deny' });
    expect((await controller.history(session.id, messageId))[0].content).toBe('What do you remember most?');
    controller.closeDialog();
    await controller.dispose();
    await db.close();
    db = new DatabaseClient(join(bundle, 'worker.cjs'), directory, native, () => {});
    await db.ready;
    controller = new ExplainController(db, { complete } as unknown as Gateway, () => {}, () => true);
    expect((await controller.open(target)).state).toBe('ready');
    expect(complete).toHaveBeenCalledTimes(2);
    await expect((db.call as Function)('unsupportedTestOperation')).rejects.toThrow('database_operation_unsupported');
  } finally {
    await controller?.dispose();
    await db?.close();
    rmSync(directory, { recursive: true, force: true });
    rmSync(bundle, { recursive: true, force: true });
  }
}, 30000);
