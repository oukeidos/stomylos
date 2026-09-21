// Optional development-workspace audit; requires sibling experiments/ and auxiliary/.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

assert.ok(process.argv.slice(2).every(arg => arg === '--audit-legacy-builders'), 'Unknown provenance audit option');
for (const area of ['experiments', 'auxiliary']) {
  assert.ok(existsSync(resolve('..', area)),
    `Workspace provenance audit requires ../${area}/; use npm run test:source-parity for repository-only checks.`);
}
// Run the independent repository check without forwarding audit-only options.
execFileSync(process.execPath, ['scripts/export-parity.mjs', '--check'], { stdio: 'inherit' });
const read = file => readFileSync(file, 'utf8');
const json = file => JSON.parse(read(file));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const goldens = json('tests/fixtures/contract-goldens.json');
const current = json('src/main/runtime-config.json');
const sources = Object.entries(goldens.sources).filter(([file]) => file.startsWith('experiments/'));
assert.ok(sources.length > 0);
for (const [file, expected] of sources) assert.equal(sha(readFileSync(resolve('..', file))), expected, `Selected source changed: ${file}`);
if (process.argv.includes('--audit-legacy-builders')) {
  const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
  const router = JSON.parse(run('tclsh', ['tests/fixtures/export-router.tcl', '../experiments/EXP-002-character-router-selection']));
  const grammar = JSON.parse(run('python3', ['-B', '-c',
    'import sys,json;sys.path.insert(0,sys.argv[1]);import chat_prompt;print(json.dumps(chat_prompt.SCHEMA,ensure_ascii=False))', resolve('../experiments/EXP-009-authentic-conversation-grammar')]));
  assert.deepEqual(router, goldens.router);
  assert.deepEqual(grammar, goldens.grammar.schema);
  console.log('Optional legacy-builder audit passed (Tcl router and Python grammar).');
}
assert.equal(read('../experiments/EXP-009-authentic-conversation-grammar/chat-prompt-v2.txt'), goldens.grammar.prompt);
const reportArea = '../experiments/EXP-019-interactive-pattern-reports/';
const frozen = json(reportArea + 'style-v2-data/freeze.json');
const base = read('src/main/pattern-prompt.txt') + '\n' + read('src/main/pattern-scope.txt');
const style = read('src/main/pattern-style-v2.txt');
assert.equal(style, read(reportArea + 'style-guidance-v2.txt'));
const assembled = base.replace('Return only a complete self-contained HTML document', style.trim() + '\n\nReturn only a complete self-contained HTML document');
assert.equal(assembled, frozen.prompts.revised);
const { messages, ...settings } = frozen.jobs[0].body;
assert.deepEqual(json('src/main/pattern-contract.json').parameters, settings);
for (const [id, item] of Object.entries(json('tests/fixtures/pattern-reports/v2-provenance.json'))) {
  assert.deepEqual(readFileSync(`tests/fixtures/pattern-reports/${id}.html`), readFileSync(resolve('..', item.source)));
}
const selectionArea = '../auxiliary/conversation-model-evaluation/';
const selected = json(selectionArea + 'selected-conversation-models.json');
assert.deepEqual(current.conversation.characters.map(({ model, reasoning }) => ({ model, reasoning })),
  selected.models.filter(c => !['openai/gpt-6-astra', 'deepseek/deepseek-v4-pro-0813'].includes(c.model)).map(({ model, reasoning }) => ({ model, reasoning })));
assert.equal(current.conversationPrompt, read(selectionArea + 'reciprocal-replacement-prompt.txt'));
assert.deepEqual(json('src/main/conversation-v7-config.json').conversation.characters.map(({ model, reasoning }) => ({ model, reasoning })),
  json(selectionArea + 'selected-seven-conversation-models-2026-09-07.json').models.map(({ model, reasoning }) => ({ model, reasoning })));
assert.equal(read('src/main/intention-prompt.txt'), read('../experiments/EXP-021-intention-questions/prompt-single-v2.txt'));
const intention = json('tests/fixtures/intention-selected.json');
assert.equal(sha(readFileSync(resolve('..', intention.prompt_source))), intention.prompt_sha256);
const survivors = json(resolve('..', intention.source)).survivors;
for (const row of intention.routes) {
  const original = survivors.find(candidate => candidate.model === row.model);
  assert.ok(original, `Missing selected Intention source: ${row.model}`);
  assert.deepEqual(row, Object.fromEntries(Object.keys(row).map(key => [key, original[key]])));
}
assert.equal(read('src/main/explain-prompt.txt'), read('../experiments/EXP-023-sentence-explanation/thousand-prompt.txt'));
const explainCases = json('../experiments/EXP-023-sentence-explanation/format-fixtures.json').cases;
const explainSettings = json('../experiments/EXP-023-sentence-explanation/thousand-manifest.json').model.request_fields;
for (const fixture of json('tests/fixtures/explain-contract.json')) {
  const original = explainCases.find(c => c.id === fixture.id).input;
  assert.deepEqual(fixture.source, { preceding_message: original.preceding_user, full_passage: original.ai_reply, selected_text: original.selected_text, selection: original.selection });
  assert.deepEqual(fixture.body, { ...explainSettings, messages: [{ role: 'system', content: read('src/main/explain-prompt.txt').trim() }, { role: 'user', content: JSON.stringify(fixture.source) }] });
}
const matches = [
  ['memory-cleanup-prompt.txt', 'EXP-029-memory-capacity/prompt-v6.txt'],
  ['pattern-system-v3.txt', 'EXP-031-direct-learner-pattern-reports/round5-system.txt'],
  ['memory-prompt-compact.txt', 'EXP-017-character-memory/prompt-compression/prompt-full.txt'],
  ['memory-prompt-flat.txt', 'EXP-017-character-memory/gemini-product-comparison/prompt.md'],
  ['memory-add-prompt.txt', 'EXP-033-add-only-memory/paragraph-l-prompt.txt'],
  ['expression-prompt-v1.txt', 'EXP-042-coverage-report/prompt-v007.txt'],
  ['expression-format-v1.json', 'EXP-042-coverage-report/response-format-v007.json']
];
for (const kind of ['direct', 'starter', 'reselection']) matches.push([
  `compact-router-${kind}.txt`, `EXP-002-character-router-selection/prompt-compression-no-independent-2026-09-08/compact-${kind}.txt`
]);
for (const [product, experiment] of matches) assert.deepEqual(readFileSync('src/main/' + product), readFileSync('../experiments/' + experiment));
assert.equal(current.grammarPrompt, read('../experiments/EXP-009-authentic-conversation-grammar/context-ablation-2026-09-08/index-prompt.txt'));
const proposal = read('../experiments/EXP-022-conversation-model-selection/PROVISIONAL_EIGHT_PARTNERS.md');
for (const kind of ['direct', 'starter', 'reselection']) {
  const prompt = read(`src/main/compact-router-six-partners-${kind}.txt`);
  for (const c of current.conversation.characters) {
    const line = prompt.split('\n').find(l => l.startsWith(c.id + ' — '));
    assert.ok(proposal.includes(`| ${c.label} | ${line.split(': ').slice(1).join(': ')} |`));
  }
}
console.log('Workspace source provenance passed: experiment and auxiliary artifacts match product contracts; legacy builders run only when explicitly requested.');
