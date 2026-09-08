import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
const require = createRequire(import.meta.url);
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
const args = process.argv.slice(2);
const modes = args.filter(arg => ['--all', '--conversion', '--check'].includes(arg));
if (modes.length > 1) throw new Error('Choose only one of --all, --conversion or --check <name>.');
const mode = modes[0];
const options = [];
if (mode === '--check') {
  const index = args.indexOf(mode), name = args[index + 1];
  if (!name || !/^[a-z-]+$/.test(name) || !existsSync(`tests/${name}.check.ts`)) throw new Error('Supply an existing tests/<name>.check.ts check.');
  args.splice(index, 2);
  options.push('--config', 'vitest.checks.config.ts', `tests/${name}.check.ts`);
} else {
  // Ordinary test selection and fixture writes must never depend on a prior
  // release driver's environment. Explicit checks retain their own inputs.
  for (const key of Object.keys(env)) if (key.startsWith('STOMYLOS_')) delete env[key];
  if (mode) args.splice(args.indexOf(mode), 1);
  if (mode === '--conversion') options.push('conversion.test.ts');
  else if (mode !== '--all') options.push('--exclude', 'tests/*conversion.test.ts');
}
const result = spawnSync(require('electron'), ['node_modules/vitest/vitest.mjs', 'run', ...options, ...args], {
  stdio: 'inherit', env
});
process.exit(result.status ?? 1);
