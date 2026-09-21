// Repository-only contract checks; external provenance belongs to audit-source-provenance.mjs.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

assert.ok(process.argv.slice(2).every(arg => arg === '--check'),
  'Use npm run audit:source-provenance for workspace provenance (and -- --audit-legacy-builders for legacy builders).');
const read = file => readFileSync(file, 'utf8');
const json = file => JSON.parse(read(file));
const sha = text => createHash('sha256').update(text).digest('hex');
const goldens = json('tests/fixtures/contract-goldens.json');
const current = json('src/main/runtime-config.json');
const previousSeven = json('src/main/conversation-v7-config.json');
const previousSix = json('src/main/conversation-v6-config.json');

const base = read('src/main/pattern-prompt.txt') + '\n' + read('src/main/pattern-scope.txt');
const style = read('src/main/pattern-style-v2.txt');
const assembled = base.replace('Return only a complete self-contained HTML document', style.trim() + '\n\nReturn only a complete self-contained HTML document');
assert.equal(assembled, read('tests/fixtures/pattern-reports/system-v2.txt'));
assert.equal(base, read('tests/fixtures/pattern-reports/system-v1.txt'));
assert.equal(sha(assembled), json('src/main/pattern-contract.json').system_sha256);
assert.equal(read('src/main/pattern-contract-v1.json'), read('tests/fixtures/pattern-reports/contract-v1.json'));
for (const [id, item] of Object.entries(json('tests/fixtures/pattern-reports/v2-provenance.json'))) {
  assert.equal(sha(readFileSync(`tests/fixtures/pattern-reports/${id}.html`)), item.sha256);
}

const reciprocal = read('src/main/reciprocal-replacement-prompt.txt');
assert.equal(current.conversationPrompt, reciprocal);
assert.equal(sha(reciprocal), 'c70cffeace85121e193f76373a69ccb77785bce8688ab82df88da3f9b95bca00');
assert.equal(current.routerPrompt, read('src/main/compact-router-six-partners-starter.txt'));
assert.equal(previousSeven.routerPrompt, read('src/main/starter-router-seven-prompt.txt'));
const directSeven = read('src/main/direct-router-seven-prompt.txt');
assert.equal(previousSeven.routerPrompt.split('Characters:')[1].split('The starter question')[0], directSeven.split('Characters:')[1].split('The first message')[0]);
for (const [version, expected] of Object.entries({
  5: '1169531c2ec10701c7c7c3db5e11b086216c654a86e010f2e56699cf0d031d24',
  6: '291ea61aa8be5945ac389427ba7bae943de14a1b73e7e2617c8865d1ba6251c7',
  8: 'c828e835c682fd251913c1e07b648dc5c4b398d240ab0ea7496799a60864d464',
  9: '995cb48b064c48b7c5623c3aab26e13b5898037387a7ecd55830474d37732ca4'
})) assert.equal(sha(readFileSync(`src/main/conversation-v${version}-config.json`)), expected);
assert.deepEqual(previousSix.conversation.characters, previousSeven.conversation.characters.slice(0, 6));
assert.deepEqual(previousSix.router.route_policy, previousSeven.router.route_policy);
assert.deepEqual(current.router.route_policy, { ...previousSeven.router.route_policy, insufficient_signal_pool: ['model_02', 'model_09'] });
assert.ok(!/cost|cheap|price|budget/i.test(current.routerPrompt + directSeven + current.conversation.characters.map(c => c.description).join(' ')));
assert.equal(sha(read('src/main/intention-prompt.txt')), '313e1f48b82b2b69aab058b8e88cba7b5ed215436bbc462ef2f05462162f4f19');
const cards = json('src/main/partner-router-cards.json');
for (const name of ['conversation-v7-config', 'conversation-v6-config', 'conversation-v5-config', 'universal-v1-config', 'c-conversation-config', 'legacy-conversation-config']) {
  const saved = json(`src/main/${name}.json`), reference = cards[saved.conversation.version];
  assert.equal(reference.source_sha256, sha(saved.routerPrompt));
  const begin = saved.routerPrompt.indexOf('Characters:'), end = saved.routerPrompt.indexOf('\n\nThe ', begin);
  assert.ok(begin >= 0 && end > begin);
  assert.equal(reference.text, saved.routerPrompt.slice(begin, end), `${name}: saved reselection cards`);
}
assert.deepEqual(cards.stomylos_conversation_v1, cards.stomylos_conversation_v2);
const order = ['model_01', 'model_03', 'model_02', 'model_07', 'model_05', 'model_09'];
assert.deepEqual(current.conversation.characters.map(c => c.id), order);
assert.deepEqual(Object.keys(current.router.response_format.json_schema.schema.properties), order);
assert.deepEqual(current.router.response_format.json_schema.schema.required, order);
for (const kind of ['direct', 'starter', 'reselection']) {
  const prompt = read(`src/main/compact-router-six-partners-${kind}.txt`);
  assert.deepEqual(prompt.match(/model_\d+/g), order);
  for (const c of current.conversation.characters) {
    const line = prompt.split('\n').find(l => l.startsWith(c.id + ' — '));
    assert.ok(line.startsWith(`${c.id} — ${c.label}: `));
  }
}
const oldEight = json('src/main/conversation-v8-config.json'), oldNine = json('src/main/conversation-v9-config.json');
assert.deepEqual(oldNine.conversation.characters, oldEight.conversation.characters.filter(c => c.id !== 'model_04'));
assert.deepEqual(current.conversation.characters, oldNine.conversation.characters.filter(c => c.id !== 'model_08'));
assert.equal(read('src/main/memory-add-prompt.txt'), read('tests/fixtures/memory-add/merge-only-l-prompt.txt'));

const grammarV1 = json('src/main/grammar-v1-config.json');
const grammarV2 = json('src/main/grammar-v2-config.json');
assert.equal(grammarV1.grammarPrompt, goldens.grammar.prompt);
assert.deepEqual(grammarV1.grammar.request_parameters, goldens.legacy.grammar_snapshot.parameters);
const indexed = structuredClone(goldens.legacy.grammar_snapshot.parameters);
indexed.reasoning.effort = 'low';
const item = indexed.response_format.json_schema.schema.properties.units.items;
item.properties = { index: { type: 'integer' }, corrected_text: { type: 'string' }, explanation: { type: 'string' } };
item.required = ['index', 'corrected_text', 'explanation'];
assert.equal(indexed.max_tokens, 8192);
assert.deepEqual(grammarV2.grammar.request_parameters, indexed);
assert.equal(current.grammarPrompt, grammarV2.grammarPrompt);
assert.deepEqual(current.grammar.request_parameters, { ...indexed, max_tokens: 128000 });
for (const [config, version, timeout] of [[grammarV1, 1, 120], [grammarV2, 2, 120], [current, 3, 600]]) {
  assert.equal(config.grammar.contract_version, `stomylos_grammar_analysis_v${version}`);
  assert.deepEqual(config.grammar.transport, { url: 'https://openrouter.ai/api/v1/chat/completions', timeout_seconds: timeout, follow_redirects: false });
}
console.log('Repository contract parity passed: current grammar v3 (128000 tokens / 600 seconds), frozen v1/v2, prompts, reports and conversation contracts.');
