import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
if (process.platform !== 'linux') throw new Error('Only Linux native builds are supported');
const includes = process.env.STOMYLOS_NODE_HEADERS || '/usr/include/node';
if (!existsSync(`${includes}/node_api.h`)) throw new Error('Node-API headers unavailable; set STOMYLOS_NODE_HEADERS');
const result = spawnSync('cc', ['-shared', '-fPIC', '-O2', '-Wall', '-Wextra', '-Werror', '-DNAPI_VERSION=8',
  `-I${includes}`, 'native/advisory-lock.c', '-o', 'native/advisory-lock.node'], { stdio: 'inherit' });
process.exit(result.status ?? 1);
