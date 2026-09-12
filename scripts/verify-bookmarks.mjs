// Native and packaged bookmark acceptance; invented history and local HTTP only.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { startMockGateway } from './mock-gateway.mjs';
const require = createRequire(import.meta.url);
if (['--fail-write', '--restore-write', '--fail-read', '--restore-read'].includes(process.argv[2])) {
  const directory = process.argv[3]; assert.ok(basename(directory).startsWith('stomylos-bookmarks-ui-'));
  const Database = require('better-sqlite3'), db = new Database(join(directory, 'stomylos.sqlite3'));
  const sql = {
    '--fail-write': "CREATE TRIGGER bookmark_test_failure BEFORE DELETE ON session_bookmarks BEGIN SELECT RAISE(ABORT,'bookmark_test_failure'); END",
    '--restore-write': 'DROP TRIGGER bookmark_test_failure',
    '--fail-read': 'ALTER TABLE session_bookmarks RENAME TO bookmark_test_hidden',
    // Renaming back changes sqlite_master quoting; restore the exact supported schema.
    '--restore-read': readFileSync('src/main/schema.sql', 'utf8').match(/CREATE TABLE session_bookmarks \([\s\S]+?\n\);/)[0]
      + ' INSERT INTO session_bookmarks SELECT * FROM bookmark_test_hidden; DROP TABLE bookmark_test_hidden;'
  };
  db.transaction(() => db.exec(sql[process.argv[2]]))(); db.close(); process.exit(0);
}
if (process.argv[2] === '--seed') {
  const directory = process.argv[3];
  assert.ok(basename(directory).startsWith('stomylos-bookmarks-ui-'));
  const Database = require('better-sqlite3'), db = new Database(join(directory, 'stomylos.sqlite3'));
  assert.equal(db.pragma('user_version', { simple: true }), 13);
  const template = db.prepare('SELECT * FROM sessions LIMIT 1').get();
  db.pragma('foreign_keys=ON');
  db.transaction(() => {
    db.prepare("UPDATE sessions SET state='ended' WHERE id=?").run(template.id);
    for (let i = 0; i < 83; i++) {
      const id = `public-history-${String(i).padStart(3, '0')}`, direct = i % 2 === 1;
      const config = JSON.parse(template.chat_config); config.opening.kind = direct ? 'user' : 'starter';
      const row = { ...template, id, state: 'active', ended_at: '2026-09-06T12:00:00Z',
        created_at: `2026-09-06T${String(Math.floor(i / 4)).padStart(2, '0')}:00:00Z`,
        character: 'model_04', analysis_state: 'none', draft: '', opening_kind: direct ? 'user' : 'starter',
        starter_id: direct ? null : template.starter_id, starter_version: direct ? null : template.starter_version,
        starter_text: direct ? null : `A remembered conversation ${i}: what makes a familiar place worth revisiting?`, chat_config: JSON.stringify(config) };
      db.prepare(`INSERT INTO sessions(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
      db.prepare("INSERT INTO messages(id,session_id,sequence,role,content,origin,delivery) VALUES(?,?,1,'user',?,'learner','complete')").run(`${id}-learner`, id, `I remember public topic ${i} and would like to return to it.`);
      db.prepare("INSERT INTO messages(id,session_id,sequence,role,content,origin,delivery) VALUES(?,?,2,'assistant',?,'model','complete')").run(`${id}-reply`, id, `### Public topic ${i}\n\n` + 'A familiar place can hold different memories each time you visit.\n\n'.repeat(28));
      db.prepare("UPDATE sessions SET state='ended' WHERE id=?").run(id);
      if (i % 2 === 0) db.prepare('INSERT INTO session_bookmarks VALUES(?)').run(id);
    }
    db.prepare('UPDATE sessions SET state=? WHERE id=?').run(template.state, template.id);
  })();
  assert.deepEqual(db.pragma('foreign_key_check'), []); db.close(); process.exit(0);
}
const packaged = process.argv.includes('--packaged');
const output = `test-results/bookmarks-${packaged ? 'packaged' : 'native'}`;
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(join(tmpdir(), 'stomylos-bookmarks-ui-'));
let conversationCalls = 0;
const mock = await startMockGateway({ chatHandler: async (input, response) => {
  conversationCalls++;
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (let i = 0; i < 16; i++) {
    if (response.destroyed) return;
    response.write(`data: ${JSON.stringify({ model: input.model, provider: 'Public mock', choices: [{ delta: { content: 'A quiet conversation leaves room to notice something new.\n\n'.repeat(3) }, finish_reason: null }] })}\n\n`);
    await new Promise(done => setTimeout(done, 70));
  }
  response.end(`data: ${JSON.stringify({ model: input.model, provider: 'Public mock', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 100, cost: 0 } })}\n\ndata: [DONE]\n\n`);
} });
const env = { ...process.env, STOMYLOS_DATA_DIR: directory, STOMYLOS_TEST_ENDPOINT: mock.endpoint, ...(packaged ? { STOMYLOS_PACKAGED_TEST: '1' } : {}) };
for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'STOMYLOS_LIVE_VERIFY']) delete env[key];
let app, page;
const report = { status: 'running', directory, packaged, checks: [], errors: [], measurements: {}, paidRequests: 0 };
const command = (name, args) => page.evaluate(([name, args]) => window.stomylos.command(name, args), [name, args]);
const button = name => page.getByRole('button', { name, exact: true });
const filterSwitch = () => page.getByRole('switch', { name: 'Show bookmarked chats only' });
async function setFilter(name) { await filterSwitch().setChecked(name === 'bookmarked'); }
const settled = async () => page.locator('nav[aria-label="Conversation history"][aria-busy="false"]').waitFor();
const header = () => page.locator('.bookmark-toggle');
function inject(flag) {
  const result = spawnSync(require('electron'), [resolve('scripts/verify-bookmarks.mjs'), flag, directory], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
async function wait(fn) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { if (await fn()) return; await new Promise(done => setTimeout(done, 40)); }
  throw new Error('Bookmark state did not settle');
}
async function launch() {
  app = await electron.launch({ executablePath: packaged ? resolve(process.env.STOMYLOS_VERIFY_BUNDLE ?? 'release/linux-unpacked/stomylos') : require('electron'), args: packaged ? [] : ['.'], env, chromiumSandbox: true, timeout: 20000 });
  page = await app.firstWindow({ timeout: 15000 }); page.setDefaultTimeout(10000);
  page.on('pageerror', error => report.errors.push(error.message));
  await button('Settings').waitFor(); await page.locator('.composer textarea').waitFor();
}
async function close() {
  const exited = new Promise(done => app.process().once('exit', done)); await command('close'); await exited; app = null;
}
async function choose(name) { await setFilter(name); await settled(); }
async function rowAction(index, action) {
  await page.locator('.history-row').nth(index).locator('.history-more').click();
  await page.getByRole('menuitem', { name: action, exact: true }).click(); await settled();
}
const measure = () => page.locator('main').evaluate(n => ({ top: n.scrollTop, height: n.clientHeight, gap: n.scrollHeight - n.scrollTop - n.clientHeight }));
try {
  await launch(); await close();
  const seeded = spawnSync(require('electron'), [resolve('scripts/verify-bookmarks.mjs'), '--seed', directory], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' });
  assert.equal(seeded.status, 0, seeded.stderr); await launch();
  const active = (await command('snapshot')).unfinished.id;
  assert.equal(await header().count(), 0);
  assert.equal(await button('Chat options').count(), 0, 'The redundant header menu is removed');
  await button('Show history').click(); await settled();
  assert.equal(await page.locator('.history-row').count(), 40);
  const draft = '작성 중인 초안\nA second line with exact punctuation.';
  await page.locator('.composer textarea').fill(draft);
  const textarea = await page.locator('.composer textarea').elementHandle();
  await choose('bookmarked'); assert.equal(await page.locator('.history-row').count(), 40);
  assert.equal(await page.locator('.composer textarea').inputValue(), draft);
  assert.ok(await textarea.evaluate(n => n === document.querySelector('.composer textarea')));
  await button('Older').click(); await settled(); assert.equal(await page.locator('.history-row').count(), 2);
  await button('Hide history').click(); await button('Show history').click();
  assert.equal(await filterSwitch().getAttribute('aria-checked'), 'true'); assert.equal(await page.locator('.history-row').count(), 2);
  await button('Reports').click(); await button('Chats').click();
  assert.equal(await page.locator('.history-row').count(), 2); assert.equal(await page.locator('.composer textarea').inputValue(), draft);
  report.checks.push('84-chat library: 42 marks across both entry modes; full-history filtering, paging and library/Learning state preserve selected draft and composer node');

  // Removing the last two matches on page two must clamp to page one.
  await rowAction(0, 'Remove bookmark'); await wait(async () => await page.locator('.history-row').count() === 1);
  await rowAction(0, 'Remove bookmark'); await wait(async () => await page.locator('.history-row').count() === 40);
  assert.equal(await button('Newer').count(), 0);
  const focused = await page.evaluate(() => document.activeElement?.className);
  assert.match(focused, /history-more/);
  await button('Undo').click(); await wait(async () => (await command('listSessions', { offset: 40, filter: 'bookmarked' })).sessions.length === 1);
  report.checks.push('Filtered last-page removal refills/clamps, transfers row-menu focus and Undo restores the exact target');

  await choose('all'); await page.locator('.composer textarea').fill('I enjoy returning to quiet places.');
  await button('Send').click(); await header().waitFor();
  await header().click(); await wait(async () => (await command('loadSession', { sessionId: active })).bookmarked);
  assert.equal(await header().getAttribute('aria-pressed'), 'true');
  await wait(async () => (await command('snapshot')).activity.phase === 'idle');
  assert.equal(conversationCalls, 1);
  await page.locator('.composer textarea').fill(draft);
  await page.locator('main').hover(); await page.mouse.wheel(0, -100000); await button('Go to latest message').waitFor();
  const before = await measure(); report.measurements.readerBefore = before;
  await choose('bookmarked'); await header().click(); await button('Undo').waitFor(); await settled();
  const after = await measure(); report.measurements.readerAfter = after;
  assert.ok(Math.abs(before.top - after.top) <= 2); assert.equal(before.height, after.height);
  assert.equal(await page.locator('.composer textarea').inputValue(), draft);
  await choose('all'); await button('Undo').click();
  await wait(async () => (await command('loadSession', { sessionId: active })).bookmarked);
  assert.equal(conversationCalls, 1);
  report.checks.push('Header marking during streaming and unmark/Undo across filters preserve reader position, viewport, draft and single dispatch');

  // Keyboard operation, timeout pause and actual layouts at normal/minimum size.
  await header().focus(); await page.keyboard.press('Space'); await button('Undo').waitFor();
  await page.clock.install(); await button('Undo').focus(); await page.clock.fastForward(9000);
  assert.equal(await button('Undo').count(), 1);
  await header().focus(); await page.mouse.move(0, 0); await page.clock.fastForward(8100);
  await wait(async () => await button('Undo').count() === 0); await page.clock.resume();
  await header().click(); await wait(async () => (await command('loadSession', { sessionId: active })).bookmarked);
  for (const [width, height] of [[1180, 860], [760, 620]]) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height]);
    await choose('bookmarked');
    await page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished.catch(() => undefined))));
    await page.screenshot({ path: `${output}/${width}x${height}.png` });
    const geometry = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('header button, .history-filter-switch, .composer textarea')];
      return { width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth,
        outside: nodes.filter(n => { const r = n.getBoundingClientRect(); return r.left < 0 || r.right > innerWidth || r.bottom > innerHeight; }).map(n => n.getAttribute('aria-label') ?? n.textContent) };
    });
    report.measurements[`${width}x${height}`] = geometry; assert.equal(geometry.overflow, false); assert.deepEqual(geometry.outside, []);
  }
  report.checks.push('Space/pressed state, focus-paused Undo expiration, and visible controls at 1180x860 and 760x620');

  inject('--fail-write'); await header().click();
  await button('Retry saving').waitFor();
  assert.equal(await header().isDisabled(), true); assert.equal(await header().getAttribute('aria-pressed'), 'true');
  assert.equal(await button('Undo').count(), 0);
  inject('--restore-write'); await button('Retry saving').click(); await button('Undo').waitFor();
  await wait(async () => !(await command('loadSession', { sessionId: active })).bookmarked);
  await button('Undo').click(); await wait(async () => (await command('loadSession', { sessionId: active })).bookmarked);
  report.checks.push('Actual SQLite write failure keeps the committed icon, disables duplicate action and recovers through save-only Retry saving');

  await choose('all'); inject('--fail-read'); await setFilter('bookmarked');
  await button('Try loading again').waitFor();
  assert.equal(await page.getByText('No bookmarked chats yet.', { exact: false }).count(), 0);
  inject('--restore-read'); await button('Try loading again').click(); await settled();
  await wait(async () => await button('Try loading again').count() === 0);
  assert.ok(await page.locator('.history-row').count() > 0);
  for (let i = 0; i < 5; i++) { await setFilter('all'); await setFilter('bookmarked'); }
  await settled(); assert.equal(await page.locator('.history-row').count(), await page.locator('.history-bookmark').count());
  assert.equal(await page.locator('.composer textarea').inputValue(), draft); assert.equal(conversationCalls, 1);
  report.checks.push('Read failure is distinct from an empty library; retry and rapid filter changes return matching rows without changing the current draft');

  await choose('all');
  const lock = spawn('python3', ['-u', '-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("BEGIN EXCLUSIVE"); print("ready",flush=True); sys.stdin.readline(); c.rollback(); c.close()', join(directory, 'stomylos.sqlite3')]);
  try {
    await new Promise((done, reject) => { lock.stdout.once('data', done); lock.once('error', reject); });
    await setFilter('bookmarked');
    await page.locator('nav[aria-busy="true"]').waitFor();
    await setFilter('all'); await settled();
  } finally { lock.stdin.end('\n'); await new Promise(done => lock.once('exit', done)); }
  await command('listSessions', { offset: 0, filter: 'all' });
  assert.equal(await filterSwitch().getAttribute('aria-checked'), 'false');
  assert.ok(await page.locator('.history-bookmark').count() < await page.locator('.history-row').count());
  await choose('bookmarked');
  report.checks.push('A database-delayed obsolete Bookmarked response cannot replace the later All selection');

  await page.locator('.history-item').nth(1).click(); await page.locator('.ended-footer').waitFor();
  await wait(async () => (await measure()).gap <= 2);
  assert.equal(await page.locator('.composer textarea').count(), 0);
  await header().click(); await button('Undo').waitFor();
  const removed = await page.locator('.history-item[aria-current="page"]').count();
  assert.equal(removed, 0);
  await button('Delete chat').click();
  await page.getByRole('dialog', { name: 'Delete this chat?' }).getByRole('button', { name: 'Delete chat', exact: true }).click();
  await page.getByRole('dialog', { name: 'Delete this chat?' }).waitFor({ state: 'hidden' });
  await page.locator('.composer textarea').waitFor(); assert.equal(await button('Undo').count(), 0);
  // Reopen a different ended conversation and use ordinary Return navigation too.
  await page.locator('.history-item').nth(1).click(); await page.locator('.ended-footer').waitFor();
  await header().click(); await button('Undo').waitFor();
  await button('Return to current chat').click(); await page.locator('.composer textarea').waitFor();
  assert.equal(await button('Undo').count(), 0); assert.equal(await page.locator('.composer textarea').inputValue(), draft);
  report.checks.push('Ended originals stay read-only and land at bottom; source deletion clears Undo and selects the current chat; Return preserves draft and clears old Undo');

  // All-filter startup and durable marks; no request is sent by a restart.
  await choose('bookmarked'); await close(); await launch(); await settled();
  assert.equal(await filterSwitch().getAttribute('aria-checked'), 'false');
  assert.equal(await header().getAttribute('aria-pressed'), 'true'); assert.equal(await page.locator('.composer textarea').inputValue(), draft);
  assert.equal(conversationCalls, 1);
  // Remove all marks through the public setter to exercise the real empty/filter UI.
  let marks = (await command('listSessions', { offset: 0, filter: 'bookmarked' })).sessions;
  while (marks.length) {
    for (const s of marks) await command('setSessionBookmark', { sessionId: s.id, bookmarked: false });
    marks = (await command('listSessions', { offset: 0, filter: 'bookmarked' })).sessions;
  }
  await choose('bookmarked'); await page.getByText('No bookmarked chats yet.', { exact: false }).waitFor();
  assert.equal(await button('Show all chats').count(), 0); await setFilter('all'); await settled(); assert.equal(await filterSwitch().getAttribute('aria-checked'), 'false');
  report.checks.push('Restart retains marks and exact draft, starts All, sends no inference; empty state returns to All');
  await header().click(); await wait(async () => (await command('loadSession', { sessionId: active })).bookmarked);
  await choose('bookmarked'); await button('New chat').click(); await button('Keep current chat').click();
  assert.equal(await filterSwitch().getAttribute('aria-checked'), 'true');
  assert.equal(await page.locator('.composer textarea').inputValue(), draft);
  await button('New chat').click(); await button('End and start new').click();
  await wait(async () => (await command('snapshot')).unfinished?.id !== active);
  await page.locator('.composer textarea').waitFor();
  assert.equal(await filterSwitch().getAttribute('aria-checked'), 'false'); assert.equal(await header().count(), 0);
  assert.equal((await command('loadSession', { sessionId: active })).session.draft, draft);
  report.checks.push('New-chat cancellation preserves the filter and draft; successful New chat resets All/page zero and retains the ended unsent draft');
  assert.deepEqual(report.errors, []); await close(); report.status = 'passed';
  writeFileSync(`${output}/report.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) {
  report.status = 'failed'; report.failure = String(error); writeFileSync(`${output}/report.json`, JSON.stringify(report, null, 2));
  if (page && !page.isClosed()) { await page.screenshot({ path: `${output}/failure.png` }); console.error(await page.locator('body').innerText()); }
  app?.process().kill('SIGTERM'); throw error;
} finally { await app?.close().catch(() => undefined); await new Promise(done => mock.server.close(done)); }
