import { expect, it } from 'vitest';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

it('checks repository-only contracts without sibling archives and detects current/legacy drift', () => {
  const directory = mkdtempSync('/tmp/stomylos-source-parity-');
  const product = join(directory, 'product');
  try {
    mkdirSync(join(product, 'scripts'), { recursive: true });
    cpSync(resolve('src/main'), join(product, 'src/main'), { recursive: true });
    cpSync(resolve('tests/fixtures'), join(product, 'tests/fixtures'), { recursive: true });
    for (const script of ['export-parity.mjs', 'audit-source-provenance.mjs']) {
      cpSync(resolve('scripts', script), join(product, 'scripts', script));
    }
    const run = (script = 'export-parity.mjs', args = ['--check']) => spawnSync(process.execPath,
      ['scripts/' + script, ...args], { cwd: product, encoding: 'utf8', timeout: 10000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    const baseline = run();
    expect(baseline.error).toBeUndefined();
    expect(baseline.status, baseline.stderr).toBe(0);
    expect(baseline.stdout).toContain('Repository contract parity passed');
    const audit = run('audit-source-provenance.mjs', []);
    expect(audit.status).not.toBe(0);
    expect(audit.stderr).toContain('Workspace provenance audit requires ../experiments/');
    const wrongCommand = run('export-parity.mjs', ['--audit-legacy-builders']);
    expect(wrongCommand.status).not.toBe(0);
    expect(wrongCommand.stderr).toContain('npm run audit:source-provenance');
    for (const [file, field, value] of [
      ['runtime-config.json', 'version', 'stomylos_grammar_analysis_v2'],
      ['runtime-config.json', 'tokens', 8192],
      ['runtime-config.json', 'timeout', 120],
      ['grammar-v2-config.json', 'tokens', 128000],
      ['grammar-v2-config.json', 'timeout', 600],
      ['grammar-v1-config.json', 'timeout', 600]
    ] as const) {
      const path = join(product, 'src/main', file), original = readFileSync(path, 'utf8');
      const config = JSON.parse(original);
      if (field === 'version') config.grammar.contract_version = value;
      else if (field === 'tokens') config.grammar.request_parameters.max_tokens = value;
      else config.grammar.transport.timeout_seconds = value;
      writeFileSync(path, JSON.stringify(config));
      try {
        const result = run();
        expect(result.status, `${file}: ${field}`).not.toBe(0);
        expect(result.stderr).toContain('AssertionError');
      } finally { writeFileSync(path, original); }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
