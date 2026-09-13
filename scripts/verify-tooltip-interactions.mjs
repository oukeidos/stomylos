import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { startMockGateway } from './mock-gateway.mjs';
const directory = mkdtempSync('/tmp/stomylos-tooltip-audit-'),
  output = 'test-results/tooltip-interactions';
mkdirSync(output, {
  recursive: true
});
const mock = await startMockGateway();
const env = {
  ...process.env,
  STOMYLOS_DATA_DIR: directory,
  STOMYLOS_TEST_ENDPOINT: mock.endpoint
};
for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'STOMYLOS_LIVE_VERIFY', 'OPENROUTER_API_KEY']) delete env[key];
let app;
const report = {
  cases: [],
  errors: [],
  mockRequests: 0
};
try {
  app = await electron.launch({
    executablePath: createRequire(import.meta.url)('electron'),
    args: ['.'],
    env,
    chromiumSandbox: true,
    timeout: 20000
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(8000);
  page.on('pageerror', e => report.errors.push(e.message));
  const button = name => page.getByRole('button', {
    name,
    exact: true
  });
  await button('Settings').waitFor();
  const record = async name => {
    await page.waitForTimeout(250);
    const state = await page.evaluate(() => ({
      active: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent?.slice(0, 80),
      tips: [...document.querySelectorAll('[role="tooltip"]')].filter(n => getComputedStyle(n).visibility === 'visible' && n.getBoundingClientRect().width > 0).map(n => ({
        text: n.textContent,
        ownerHidden: (() => {
          const owner = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-describedby') === n.id);
          return !owner?.getClientRects().length;
        })()
      }))
    }));
    report.cases.push({
      name,
      ...state
    });
    assert.equal(state.tips.length, name === 'two icons focus About memory and hover Close settings' ? 1 : 0, name);
    return state;
  };
  const reset = async () => {
    await page.keyboard.press('Escape');
    await page.mouse.move(650, 400);
    await page.locator('textarea[aria-label="Your message"]').focus();
  };
  await reset();
  const toggle = page.locator('.history-toggle');
  await toggle.evaluate(node => {
    window.auditEvents = [];
    for (const type of ['pointerenter', 'pointerdown', 'focus', 'click', 'pointerleave', 'blur']) node.addEventListener(type, e => window.auditEvents.push({
      type: e.type,
      active: document.activeElement === node
    }));
  });
  await toggle.hover();
  await toggle.click();
  await page.mouse.move(650, 400);
  await record('trace pointer click');
  report.eventOrder = await page.evaluate(() => window.auditEvents);
  if (await page.locator('#conversation-sidebar').isHidden()) await toggle.click();
  await reset();
  await page.getByRole('switch', {
    name: 'Show bookmarked chats only',
    exact: true
  }).click();
  await page.mouse.move(650, 400);
  await record('bookmarked-only switch pointer click');
  await reset();
  await button('Settings').click();
  await button('Close settings').waitFor();
  await page.getByRole('tab', {
    name: 'Memory',
    exact: true
  }).click();
  await button('About memory').waitFor();
  await button('About memory').click();
  await page.mouse.move(650, 500);
  await record('About memory pointer click while popover open');
  await page.keyboard.press('Escape');
  await record('About memory popover Escape');
  await app.evaluate(({
    app
  }, directory) => {
    const require = process.getBuiltinModule('node:module').createRequire(app.getAppPath() + '/package.json');
    const db = new (require('better-sqlite3'))(directory + '/stomylos.sqlite3');
    const hash = text => require('node:crypto').createHash('sha256').update(text).digest('hex');
    const document = JSON.stringify({
      character_id: 'shared',
      revision: 0,
      database_records: [{
        id: 'audit-note',
        text: 'A public synthetic note.'
      }]
    });
    db.prepare('UPDATE shared_memory SET document=?,document_hash=?').run(document, hash(document));
    db.prepare("INSERT INTO memory_item_metadata(id,source_order,item_index,origin) VALUES('audit-note',1,0,'legacy')").run();
    db.close();
  }, directory);
  await button('Close settings').click();
  await page.getByRole('dialog', {
    name: 'Settings',
    exact: true
  }).waitFor({
    state: 'hidden'
  });
  await button('Settings').click();
  await page.getByRole('tab', {
    name: 'Memory',
    exact: true
  }).click();
  await button('Edit').waitFor();
  await button('Delete').click();
  await page.mouse.move(650, 500);
  await record('Recent memory Delete inline confirmation');
  await button('Cancel').click();
  await page.mouse.move(650, 500);
  await record('Recent memory Delete Cancel focus return');
  await button('Edit').click();
  await page.getByRole('textbox', {
    name: 'Edit memory'
  }).waitFor();
  await record('Recent memory Edit focuses textarea');
  await button('Cancel').click();
  await page.mouse.move(650, 500);
  await record('Recent memory Edit Cancel focus return');
  await button('About memory').focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await page.locator('[role=tooltip]:visible').waitFor();
  await page.mouse.move(1100, 680);
  await button('Close settings').hover();
  await page.waitForTimeout(750);
  await record('two icons focus About memory and hover Close settings');
  await page.getByRole('tab', {
    name: 'Voice',
    exact: true
  }).click();
  await record('Memory panel hidden after Voice tab click');
  await button('Close settings').click();
  await page.getByRole('dialog', {
    name: 'Settings',
    exact: true
  }).waitFor({
    state: 'hidden'
  });
  await page.waitForTimeout(700);
  await record('Settings close after settled transition');
  await reset();
  await button('Conversation details').click();
  await page.getByRole('dialog', {
    name: 'Conversation details',
    exact: true
  }).waitFor();
  await record('Conversation details open');
  await page.getByRole('dialog', {
    name: 'Conversation details',
    exact: true
  }).getByRole('button', {
    name: 'Close dialog',
    exact: true
  }).click();
  await page.getByRole('dialog', {
    name: 'Conversation details',
    exact: true
  }).waitFor({
    state: 'hidden'
  });
  await page.mouse.move(650, 400);
  await record('Conversation details close return');

  // Keyboard discovery and activation, plus the formerly native-title controls.
  await reset();
  await toggle.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  const visibleTips = page.locator('[role="tooltip"]:visible');
  await visibleTips.waitFor();
  assert.equal(await visibleTips.count(), 1);
  await page.keyboard.press('Enter');
  await record('Enter dismisses');
  await page.keyboard.press('Space');
  await record('Space dismisses');
  await button('Reports').click();
  await button('Reports options').click();
  await page.getByRole('menu').waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('menu').waitFor({
    state: 'hidden'
  });
  await page.waitForTimeout(350);
  await record('Reports menu focus return');
  await button('Chats').click();
  assert.equal(await page.locator('button[title]').count(), 0, 'No competing native button titles');
  await button('Settings').hover();
  await visibleTips.waitFor();
  await button('Settings').evaluate(node => node.hidden = true);
  await visibleTips.waitFor({
    state: 'hidden'
  });
  await page.getByRole('button', {
    name: 'Settings',
    exact: true,
    includeHidden: true
  }).evaluate(node => node.hidden = false);
  await page.mouse.move(650, 400);
  await button('Settings').hover();
  await visibleTips.waitFor();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await visibleTips.waitFor({
    state: 'hidden'
  });
  await page.mouse.move(650, 400);
  await button('Settings').hover();
  await visibleTips.waitFor();
  await button('Settings').evaluate(node => node.disabled = true);
  await visibleTips.waitFor({
    state: 'hidden'
  });
  await button('Settings').evaluate(node => node.disabled = false);
  await record('Re-enable does not resurrect tooltip');
  await button('Settings').click();
  await page.getByRole('dialog', {
    name: 'Settings',
    exact: true
  }).waitFor();
  await page.getByRole('tab', {
    name: 'Memory',
    exact: true
  }).click();
  await button('About memory').click();
  await page.mouse.move(650, 500);
  await button('About memory').hover();
  await visibleTips.waitFor();
  await page.keyboard.press('Escape');
  await record('Escape dismisses hovered tooltip and memory popover together');
  await button('Close settings').click();
  await page.getByRole('dialog', {
    name: 'Settings',
    exact: true
  }).waitFor({
    state: 'hidden'
  });
  await button('Conversation details').click();
  const dialog = page.getByRole('dialog', {
    name: 'Conversation details',
    exact: true
  });
  await dialog.waitFor();
  await dialog.getByRole('button', {
    name: 'Close dialog',
    exact: true
  }).hover();
  await visibleTips.waitFor();
  assert.equal(await visibleTips.textContent(), 'Close');
  await dialog.getByRole('button', {
    name: 'Close dialog',
    exact: true
  }).click();
  await dialog.waitFor({
    state: 'hidden'
  });
  await record('Converted native dialog close dismisses');
  report.mockRequests = mock.requests.length;
  assert.equal(report.mockRequests, 0);
  assert.deepEqual(report.errors, []);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.errors.push(String(error));
  process.exitCode = 1;
} finally {
  await app?.close().catch(() => {});
  await new Promise(resolve => mock.server.close(resolve));
  rmSync(directory, {
    recursive: true,
    force: true
  });
  writeFileSync(`${output}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
