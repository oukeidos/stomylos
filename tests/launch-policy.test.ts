import { describe, expect, it } from 'vitest';
import { launchData } from '../src/main/launch-policy';

const normal = '/tmp/launch-policy-normal';
const personal = ['--stomylos-personal'];
describe('personal source execution and development isolation', () => {
  it('requires explicit personal execution for normal source data', () => {
    expect(launchData(false, personal, {}, normal)).toEqual({ directory: normal, normalData: true });
    expect(launchData(true, [], {}, normal)).toEqual({ directory: normal, normalData: true });
    expect(() => launchData(false, [], {}, normal)).toThrow('isolated absolute');
    expect(() => launchData(false, [], { STOMYLOS_DATA_DIR: normal + '/.' }, normal)).toThrow('isolated absolute');
    expect(() => launchData(false, [], { STOMYLOS_DATA_DIR: 'relative' }, normal)).toThrow('isolated absolute');
  });
  it('keeps development and mock execution on isolated data', () => {
    expect(launchData(false, [], { STOMYLOS_DATA_DIR: '/tmp/isolated', ELECTRON_RENDERER_URL: 'http://localhost:5173' }, normal))
      .toEqual({ directory: '/tmp/isolated', normalData: false });
    expect(launchData(true, [], { STOMYLOS_DATA_DIR: '/tmp/isolated', STOMYLOS_TEST_ENDPOINT: 'http://127.0.0.1:1234' }, normal).normalData).toBe(false);
    for (const env of [
      { STOMYLOS_DATA_DIR: '/tmp/isolated' }, { STOMYLOS_DATA_DIR: '' },
      { ELECTRON_RENDERER_URL: 'http://localhost:5173' }, { STOMYLOS_TEST_ENDPOINT: 'http://127.0.0.1:1234' },
    ]) expect(() => launchData(false, personal, env, normal)).toThrow('Personal execution');
    for (const env of [{ ELECTRON_RENDERER_URL: 'http://localhost:5173' }, { STOMYLOS_TEST_ENDPOINT: 'http://127.0.0.1:1234' }]) {
      expect(() => launchData(true, [], env, normal)).toThrow('Normal history');
    }
  });
});
