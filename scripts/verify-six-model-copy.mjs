// Packaged continuity on an explicitly prepared copy of the user's v8 database.
// The gateway is loopback-only; no copied transcript leaves this computer.
import { _electron as electron } from 'playwright-core';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { startMockGateway } from './mock-gateway.mjs';

const prepared = JSON.parse(readFileSync('test-results/six-normal-copy.json', 'utf8'));
assert.ok(prepared.directory.startsWith('/tmp/stomylos-six-normal-'));
assert.equal(createHash('sha256').update(readFileSync(prepared.original)).digest('hex'), prepared.original_sha256);
const inventoryCode = `
import sqlite3,json,hashlib,sys
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
assert c.execute('pragma user_version').fetchone()[0]==8
assert c.execute('pragma integrity_check').fetchone()[0]=='ok'
assert not c.execute('pragma foreign_key_check').fetchall()
tables=[x[0] for x in c.execute("select name from sqlite_master where type='table' order by name")]
def digest(x):return hashlib.sha256(json.dumps(x,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
print(json.dumps({'tables':{t:{str(row[0]):digest(row) for row in c.execute('select rowid,* from "'+t+'" order by rowid')} for t in tables},'schema':digest(c.execute('select type,name,tbl_name,sql from sqlite_master order by type,name').fetchall()),'sessions':{r[0]:{'state':r[1],'config':digest(r[2])} for r in c.execute('select id,state,chat_config from sessions')}}))
`;
const inventory = file => JSON.parse(execFileSync('python3', ['-c', inventoryCode, file], { encoding: 'utf8' }));
const before = inventory(prepared.original);
assert.deepEqual(inventory(prepared.copy), before, 'Use an untouched prepared copy');
const mock = await startMockGateway({ delay: 0, streamFinishes: ['length', 'stop', 'stop'] });
const env = { ...process.env, STOMYLOS_DATA_DIR: prepared.directory, STOMYLOS_TEST_ENDPOINT: mock.endpoint, STOMYLOS_PACKAGED_TEST: '1' };
for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'STOMYLOS_LIVE_VERIFY']) delete env[key];
const executablePath = resolve(process.env.STOMYLOS_VERIFY_BUNDLE ?? 'release/six-candidate/linux-unpacked/stomylos');
let app, page, oldId, newId, oldConfig;
const errors = [], checks = [];
const cmd = (name, args) => page.evaluate(([name, args]) => window.stomylos.command(name, args), [name, args]);
const button = name => page.getByRole('button', { name, exact: true });
async function poll(fn) { const end = Date.now() + 20000; while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 50)); } throw Error('Copy state did not settle'); }
async function launch() {
  app = await electron.launch({ executablePath, env, chromiumSandbox: true }); page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message)); await button('Settings').waitFor();
}
async function close() { const ended = new Promise(r => app.process().once('exit', r)); await cmd('close'); await ended; app = null; }
try {
  await launch(); let state = await cmd('snapshot');
  assert.equal(state.settings.appVersion, '0.14.0'); assert.equal(state.settings.dataPath, prepared.directory);
  for (const id of Object.keys(before.sessions)) {
    const view = await cmd('loadSession', { sessionId: id });
    assert.equal(createHash('sha256').update(JSON.stringify(view.session.chat_config)).digest('hex'), before.sessions[id].config);
  }
  assert.equal(mock.requests.length, 0); await close();
  assert.deepEqual(inventory(prepared.copy), before, 'Reading and closing the real-data copy must not rewrite any row');
  checks.push('All original v2/v3/v5 sessions readable; first candidate launch/close preserves every row and full schema');
  await launch(); state = await cmd('snapshot'); oldId = state.unfinished.id;
  const old = await cmd('loadSession', { sessionId: oldId }); oldConfig = old.session.chat_config;
  assert.equal(JSON.parse(oldConfig).version, 'stomylos_conversation_v5');
  await button('Partner: Automatic').click(); assert.equal(await page.getByRole('menuitemradio').count(), 5); await page.keyboard.press('Escape');
  await cmd('selectPartner', { sessionId: oldId, character: 'model_03' }); await cmd('searchMode', { sessionId: oldId, mode: 'off' });
  const text = 'A synthetic continuation used only to verify this isolated copy.';
  await page.getByRole('textbox', { name: 'Your message', exact: true }).fill(text); await button('Send').click();
  await button('Retry reply').waitFor(); const first = mock.requests.find(r => r.stream && !r.response_format);
  assert.ok(first.messages[0].content.startsWith(JSON.parse(oldConfig).system_prompt)); assert.equal(first.tools, undefined);
  const calls = mock.requests.length; await close(); await launch(); assert.equal(mock.requests.length, calls);
  await button('Retry reply').click();
  await poll(async () => { const last = (await cmd('loadSession', { sessionId: oldId })).messages.at(-1); return last?.origin === 'model' && last.delivery === 'complete'; });
  const chatRequests = mock.requests.filter(r => r.stream && !r.response_format); assert.equal(chatRequests.length, 2); assert.deepEqual(chatRequests[1], first);
  const afterReply = await cmd('loadSession', { sessionId: oldId }); assert.equal(afterReply.session.chat_config, oldConfig);
  await button('End chat').click();
  await poll(async () => { const v = await cmd('loadSession', { sessionId: oldId }); return v.session.analysis_state === 'completed' && v.memory.job?.state === 'completed' && v.renewal?.state === 'completed'; });
  checks.push('Actual v5 draft keeps five menu choices and exact config; synthetic failed reply survives restart and explicit byte-identical retry; ending completes jobs');
  await button('New chat').click(); await button('Partner: Automatic').waitFor();
  state = await cmd('snapshot'); newId = state.unfinished.id;
  const newer = await cmd('loadSession', { sessionId: newId }); assert.equal(JSON.parse(newer.session.chat_config).version, 'stomylos_conversation_v6');
  await button('Partner: Automatic').click(); assert.equal(await page.getByRole('menuitemradio').count(), 7);
  await page.getByRole('menuitemradio', { name: /^Stories/ }).click(); await button('Partner: Stories').waitFor();
  await cmd('searchMode', { sessionId: newId, mode: 'off' });
  await page.getByRole('textbox', { name: 'Your message', exact: true }).fill('Tell me a small invented everyday scene.'); await button('Send').click();
  await poll(async () => { const last = (await cmd('loadSession', { sessionId: newId })).messages.at(-1); return last?.origin === 'model' && last.delivery === 'complete'; });
  assert.equal((await cmd('loadSession', { sessionId: newId })).session.model, 'bytedance-seed/seed-2-1-turbo');
  const beforeClose = mock.requests.length; await close(); await launch(); assert.equal(mock.requests.length, beforeClose);
  assert.equal((await cmd('loadSession', { sessionId: newId })).session.character, 'model_07');
  assert.equal((await cmd('loadSession', { sessionId: oldId })).session.chat_config, oldConfig);
  await close();
  const after = inventory(prepared.copy); assert.equal(after.schema, before.schema);
  const preserved = ['messages', 'model_requests', 'grammar_units', 'character_memories', 'memory_jobs', 'memory_attempts', 'session_memories', 'route_decisions', 'chat_search_context', 'search_turns', 'search_router_attempts', 'message_times', 'pattern_report_attempts', 'pattern_reports', 'pattern_report_sources'];
  for (const table of preserved) for (const [row, hash] of Object.entries(before.tables[table])) assert.equal(after.tables[table][row], hash, `Historical row changed: ${table}/${row}`);
  const endedRows = execFileSync('python3', ['-c', "import sqlite3,json,sys;c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True);print(json.dumps([str(r[0]) for r in c.execute(\"select rowid from sessions where state='ended'\")]))", prepared.original], { encoding: 'utf8' });
  for (const row of JSON.parse(endedRows)) assert.equal(after.tables.sessions[row], before.tables.sessions[row]);
  checks.push('New v6 Stories chat persists independently; all original ended sessions/messages/requests/memories and schema remain exact; only intentional copy actions modify state');
  assert.deepEqual(errors, []);
  const report = { status: 'passed', directory: prepared.directory, executablePath, originalSha256: prepared.original_sha256, oldId, newId, checks, errors, paidRequests: 0, normalDataWrites: 0 };
  writeFileSync('test-results/six-copy-acceptance.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally { await app?.close().catch(() => undefined); await new Promise(r => mock.server.close(r)); }
