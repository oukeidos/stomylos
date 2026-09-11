// Current product source parity. Legacy builders are an optional provenance audit.
// Historical Electron-session compatibility is tested against immutable fixtures.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const goldens = JSON.parse(readFileSync('tests/fixtures/contract-goldens.json', 'utf8'));
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
const sources = Object.entries(goldens.sources).filter(([file]) => file.startsWith('experiments/'));
assert.ok(sources.length > 0);
for (const [file, expected] of sources) {
  assert.equal(createHash('sha256').update(readFileSync(resolve('..', file))).digest('hex'), expected, `Selected source changed: ${file}`);
}
if (process.argv.includes('--audit-legacy-builders')) {
  const router = JSON.parse(run('tclsh', ['tests/fixtures/export-router.tcl', '../experiments/EXP-002-character-router-selection']));
  const grammar = JSON.parse(run('python3', ['-B', '-c',
    'import sys,json;sys.path.insert(0,sys.argv[1]);import chat_prompt;print(json.dumps(chat_prompt.SCHEMA,ensure_ascii=False))', resolve('../experiments/EXP-009-authentic-conversation-grammar')]));
  assert.deepEqual(router, goldens.router, 'Selected router definition changed');
  assert.deepEqual(grammar, goldens.grammar.schema, 'Selected grammar schema changed');
  console.log('Optional legacy-builder audit passed (Tcl router and Python grammar).');
}
assert.equal(readFileSync('../experiments/EXP-009-authentic-conversation-grammar/chat-prompt-v2.txt', 'utf8'), goldens.grammar.prompt);
console.log('Frozen source hashes and grammar prompt match. Electron historical-session compatibility is covered by npm test; legacy builders are not a routine gate.');

const reportArea = '../experiments/EXP-019-interactive-pattern-reports/';
const frozen = JSON.parse(readFileSync(reportArea + 'style-v2-data/freeze.json', 'utf8'));
const base = readFileSync('src/main/pattern-prompt.txt', 'utf8') + '\n' + readFileSync('src/main/pattern-scope.txt', 'utf8');
const style = readFileSync('src/main/pattern-style-v2.txt', 'utf8');
assert.equal(style, readFileSync(reportArea + 'style-guidance-v2.txt', 'utf8'));
const assembled = base.replace('Return only a complete self-contained HTML document', style.trim() + '\n\nReturn only a complete self-contained HTML document');
assert.equal(assembled, frozen.prompts.revised);
assert.equal(assembled, readFileSync('tests/fixtures/pattern-reports/system-v2.txt', 'utf8'));
assert.equal(base, readFileSync('tests/fixtures/pattern-reports/system-v1.txt', 'utf8'));
const activeReport = JSON.parse(readFileSync('src/main/pattern-contract.json', 'utf8'));
const {messages, ...settings} = frozen.jobs[0].body;
assert.deepEqual(activeReport.parameters, settings);
assert.equal(createHash('sha256').update(assembled).digest('hex'), activeReport.system_sha256);
assert.equal(readFileSync('src/main/pattern-contract-v1.json', 'utf8'), readFileSync('tests/fixtures/pattern-reports/contract-v1.json', 'utf8'));
for (const [id, item] of Object.entries(JSON.parse(readFileSync('tests/fixtures/pattern-reports/v2-provenance.json', 'utf8')))) {
  const bytes = readFileSync(`tests/fixtures/pattern-reports/${id}.html`);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256);
  assert.deepEqual(bytes, readFileSync(resolve('..', item.source)));
}
console.log('Report v2 exact prompt/settings and five generated fixtures match the frozen experiment; v1 fixtures remain intact.');

const selectionArea = '../auxiliary/conversation-model-evaluation/';
const selectedSeven = JSON.parse(readFileSync(selectionArea + 'selected-conversation-models.json', 'utf8'));
const previousSeven = JSON.parse(readFileSync('src/main/conversation-v7-config.json', 'utf8'));
const current = JSON.parse(readFileSync('src/main/runtime-config.json', 'utf8'));
assert.deepEqual(current.conversation.characters.map(({model, reasoning}) => ({model, reasoning})), selectedSeven.models.map(({model, reasoning}) => ({model, reasoning})));
const reciprocal = readFileSync(selectionArea + 'reciprocal-replacement-prompt.txt', 'utf8');
assert.equal(current.conversationPrompt, reciprocal);
assert.equal(readFileSync('src/main/reciprocal-replacement-prompt.txt', 'utf8'), reciprocal);
assert.equal(createHash('sha256').update(reciprocal).digest('hex'), 'c70cffeace85121e193f76373a69ccb77785bce8688ab82df88da3f9b95bca00');
assert.equal(current.routerPrompt, readFileSync('src/main/compact-router-eight-starter.txt', 'utf8'));
assert.equal(previousSeven.routerPrompt, readFileSync('src/main/starter-router-seven-prompt.txt', 'utf8'));
const directSeven = readFileSync('src/main/direct-router-seven-prompt.txt', 'utf8');
assert.equal(previousSeven.routerPrompt.split('Characters:')[1].split('The starter question')[0], directSeven.split('Characters:')[1].split('The first message')[0]);
assert.equal(createHash('sha256').update(readFileSync('src/main/conversation-v5-config.json')).digest('hex'), '1169531c2ec10701c7c7c3db5e11b086216c654a86e010f2e56699cf0d031d24');
console.log('Seven-model selection and exact replacement bytes match; both router cards agree and frozen v5 is intact.');

assert.equal(createHash('sha256').update(readFileSync('src/main/conversation-v6-config.json')).digest('hex'), '291ea61aa8be5945ac389427ba7bae943de14a1b73e7e2617c8865d1ba6251c7');
const previousSix = JSON.parse(readFileSync('src/main/conversation-v6-config.json', 'utf8'));
assert.deepEqual(previousSix.conversation.characters, previousSeven.conversation.characters.slice(0, 6));
assert.deepEqual(previousSix.router.route_policy, previousSeven.router.route_policy);
assert.deepEqual(current.router.route_policy, { ...previousSeven.router.route_policy, insufficient_signal_pool: ['model_02', 'model_09'] });
assert.ok(!/cost|cheap|price|budget/i.test(current.routerPrompt + directSeven + current.conversation.characters.map(c => c.description).join(' ')));

assert.equal(readFileSync('src/main/intention-prompt.txt', 'utf8'), readFileSync('../experiments/EXP-021-intention-questions/prompt-single-v2.txt', 'utf8'));
assert.equal(createHash('sha256').update(readFileSync('src/main/intention-prompt.txt')).digest('hex'), '313e1f48b82b2b69aab058b8e88cba7b5ed215436bbc462ef2f05462162f4f19');
const intentionFixture = JSON.parse(readFileSync('tests/fixtures/intention-selected.json', 'utf8'));
assert.equal(createHash('sha256').update(readFileSync(resolve('..', intentionFixture.prompt_source))).digest('hex'), intentionFixture.prompt_sha256);
const intentionSurvivors = JSON.parse(readFileSync(resolve('..', intentionFixture.source), 'utf8')).survivors;
for (const row of intentionFixture.routes) {
  const original = intentionSurvivors.find(candidate => candidate.model === row.model);
  assert.ok(original, `Missing selected Intention source: ${row.model}`);
  assert.deepEqual(row, Object.fromEntries(Object.keys(row).map(key => [key, original[key]])));
}
console.log('Intention prompt and product-owned selected-route fixture match the experiment exactly.');

const reselectionCards = JSON.parse(readFileSync('src/main/partner-router-cards.json', 'utf8'));
for (const name of ['conversation-v7-config', 'conversation-v6-config', 'conversation-v5-config', 'universal-v1-config', 'c-conversation-config', 'legacy-conversation-config']) {
  const saved = JSON.parse(readFileSync(`src/main/${name}.json`, 'utf8'));
  const reference = reselectionCards[saved.conversation.version];
  assert.equal(reference.source_sha256, createHash('sha256').update(saved.routerPrompt).digest('hex'));
  const begin = saved.routerPrompt.indexOf('Characters:');
  const end = saved.routerPrompt.indexOf('\n\nThe ', begin);
  assert.ok(begin >= 0 && end > begin);
  assert.equal(reference.text, saved.routerPrompt.slice(begin, end), `${name}: reselection cards must match the saved roster exactly`);
}
assert.deepEqual(reselectionCards.stomylos_conversation_v1, reselectionCards.stomylos_conversation_v2);
console.log('Reselection cards match every supported saved roster; the initial router artifacts remain unchanged.');

assert.equal(readFileSync('src/main/explain-prompt.txt', 'utf8'), readFileSync('../experiments/EXP-023-sentence-explanation/thousand-prompt.txt', 'utf8'));
console.log('Explain exact final prompt matches the adopted experiment.');

const explainCases = JSON.parse(readFileSync('../experiments/EXP-023-sentence-explanation/format-fixtures.json','utf8')).cases;
const explainSettings = JSON.parse(readFileSync('../experiments/EXP-023-sentence-explanation/thousand-manifest.json','utf8')).model.request_fields;
for (const fixture of JSON.parse(readFileSync('tests/fixtures/explain-contract.json','utf8'))) {
  const original=explainCases.find(c=>c.id===fixture.id).input;
  assert.deepEqual(fixture.source,{preceding_message:original.preceding_user,full_passage:original.ai_reply,selected_text:original.selected_text,selection:original.selection});
  assert.deepEqual(fixture.body,{...explainSettings,messages:[{role:'system',content:readFileSync('src/main/explain-prompt.txt','utf8').trim()},{role:'user',content:JSON.stringify(fixture.source)}]});
}
console.log('Explain request goldens preserve tested settings, compact JSON input, UTF16 positions and final system text.');

assert.equal(readFileSync('src/main/memory-cleanup-prompt.txt', 'utf8'),
  readFileSync('../experiments/EXP-029-memory-capacity/prompt-v6.txt', 'utf8'));
console.log('Memory cleanup prompt matches the selected EXP-029 prompt-v6 bytes.');

for (const kind of ['direct', 'starter', 'reselection']) {
  assert.deepEqual(readFileSync(`src/main/compact-router-${kind}.txt`),
    readFileSync(`../experiments/EXP-002-character-router-selection/prompt-compression-no-independent-2026-09-08/compact-${kind}.txt`));
}
console.log('All three compact Auto prompts exactly match the selected no-independent experiment.');

const grammarV1 = JSON.parse(readFileSync('src/main/grammar-v1-config.json', 'utf8'));
assert.equal(grammarV1.grammarPrompt, goldens.grammar.prompt);
assert.deepEqual(grammarV1.grammar.request_parameters, goldens.legacy.grammar_snapshot.parameters);
assert.equal(current.grammarPrompt, readFileSync('../experiments/EXP-009-authentic-conversation-grammar/context-ablation-2026-09-08/index-prompt.txt', 'utf8'));
assert.equal(current.grammar.contract_version, 'stomylos_grammar_analysis_v2');
assert.deepEqual(current.grammar.request_parameters.reasoning, { exclude: true, effort: 'low' });
const expectedGrammar = structuredClone(goldens.legacy.grammar_snapshot.parameters);
expectedGrammar.reasoning.effort = 'low';
const grammarItem = expectedGrammar.response_format.json_schema.schema.properties.units.items;
grammarItem.properties = { index: { type: 'integer' }, corrected_text: { type: 'string' }, explanation: { type: 'string' } };
grammarItem.required = ['index', 'corrected_text', 'explanation'];
assert.deepEqual(current.grammar.request_parameters, expectedGrammar);
console.log('Grammar v2 exact index prompt/settings match selection; frozen v1 remains exact.');

assert.deepEqual(readFileSync('src/main/pattern-system-v3.txt'), readFileSync('../experiments/EXP-031-direct-learner-pattern-reports/round5-system.txt'));
console.log('Direct report v3 system exactly matches the selected EXP-031 round-five bytes.');

assert.equal(readFileSync('src/main/memory-prompt-compact.txt', 'utf8'), readFileSync('../experiments/EXP-017-character-memory/prompt-compression/prompt-full.txt', 'utf8'));

// Updater v7 uses the exact selected baseline; later rejected refinements stay out.
assert.equal(readFileSync('src/main/memory-prompt-flat.txt', 'utf8'), readFileSync('../experiments/EXP-017-character-memory/gemini-product-comparison/prompt.md', 'utf8'));

const order = ['model_01','model_03','model_02','model_04','model_07','model_08','model_05','model_09'];
assert.deepEqual(current.conversation.characters.map(c=>c.id),order);
assert.deepEqual(Object.keys(current.router.response_format.json_schema.schema.properties),order);
assert.deepEqual(current.router.response_format.json_schema.schema.required,order);
const proposal=readFileSync('../experiments/EXP-022-conversation-model-selection/PROVISIONAL_EIGHT_PARTNERS.md','utf8');
for(const kind of ['direct','starter','reselection']){
  const prompt=readFileSync(`src/main/compact-router-eight-${kind}.txt`,'utf8');
  assert.deepEqual(prompt.match(/model_\d+/g),order);
  for(const c of current.conversation.characters){
    const line=prompt.split('\n').find(l=>l.startsWith(c.id+' — '));
    assert.ok(line.startsWith(`${c.id} — ${c.label}: `));
    assert.ok(proposal.includes(`| ${c.label} | ${line.split(': ').slice(1).join(': ')} |`));
  }
}
assert.deepEqual(previousSeven.conversation.characters.map(({model,reasoning})=>({model,reasoning})),
  JSON.parse(readFileSync(selectionArea+'selected-seven-conversation-models-2026-09-07.json','utf8')).models.map(({model,reasoning})=>({model,reasoning})));
console.log('Eight adopted cards, display/schema order, model settings and preserved seven-model selection agree.');

assert.equal(readFileSync('src/main/memory-add-prompt.txt','utf8'),readFileSync('../experiments/EXP-033-add-only-memory/add-prompt.txt','utf8'));
console.log('Luna ADD prompt matches the selected EXP-033 bytes.');
