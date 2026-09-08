import { expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { DatabaseClient } from '../src/main/db-client';
it('rejects all outstanding work on a real worker exit and never silently replaces it', async () => {
  const failed = vi.fn();
  const client = new DatabaseClient(resolve('tests/fixtures/failing-worker.mjs'), '/unused', '/unused', failed);
  await client.ready;
  const results = await Promise.allSettled([client.call('sessions'), client.call('unfinished')]);
  expect(results.every(r => r.status === 'rejected' && r.reason.message === 'database_worker_stopped')).toBe(true);
  await expect(client.call('sessions')).rejects.toThrow('database_worker_stopped');
  expect(failed).toHaveBeenCalledTimes(1);
});
