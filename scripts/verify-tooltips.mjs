// Focused tooltip geometry and interaction checks with disposable data.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const directory = mkdtempSync('/tmp/stomylos-tooltips-');
const output = 'test-results/tooltips'; mkdirSync(output, { recursive: true });
const env = { ...process.env, STOMYLOS_DATA_DIR: directory };
for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'STOMYLOS_TEST_ENDPOINT', 'OPENROUTER_API_KEY']) delete env[key];
let app;
const report = { checks: [], errors: [], paidRequests: 0 };
try {
  app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: ['.'], env, chromiumSandbox: true });
  const page = await app.firstWindow(); page.setDefaultTimeout(8000);
  page.on('pageerror', error => report.errors.push(error.message));
  const button = name => page.getByRole('button', { name, exact: true });
  async function check(name) {
    await button(name).scrollIntoViewIfNeeded();await page.waitForTimeout(100);await page.screenshot({path:output+'/before-hover.png'});await page.mouse.move(2,2);await page.waitForTimeout(50);await button(name).hover();
    const id = await button(name).getAttribute('aria-describedby');
    const tip = page.locator(`[id="${id}"]`);
    if(await button(name).isDisabled()){await tip.waitFor({state:'hidden'});return tip;}
    await tip.waitFor({ state: 'visible' }).catch(async error=>{report.trace=await page.evaluate(()=>window.tooltipTrace.slice(-30));throw error;});
    const result = await tip.evaluate(node => {
      const r = node.getBoundingClientRect();
      // Temporarily include the tooltip in hit-testing to detect occlusion.
      node.style.pointerEvents = 'auto';
      const unobscured = [[r.left + 2, r.top + 2], [r.right - 2, r.bottom - 2], [r.left + r.width / 2, r.top + r.height / 2]]
        .every(([x, y]) => document.elementFromPoint(x, y) === node);
      node.style.pointerEvents = '';
      return { inside: r.left >= 7 && r.top >= 7 && r.right <= innerWidth - 7 && r.bottom <= innerHeight - 7, unobscured, portal: node.parentElement === document.body };
    });
    assert.deepEqual(result, { inside: true, unobscured: true, portal: true }, name);
    await page.keyboard.press('Escape'); await tip.waitFor({ state: 'hidden' });
    return tip;
  }
  await button('Settings').waitFor();await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].focus());await page.waitForFunction(()=>document.hasFocus());
  await page.evaluate(()=>{window.tooltipTrace=[];for(const type of ['pointerenter','pointerleave','focusin','blur','scroll'])window.addEventListener(type,e=>window.tooltipTrace.push({type,target:e.target?.getAttribute?.('aria-label')??e.target?.tagName,at:performance.now()}),true);});
  if (await button('Show history').count()) await button('Show history').click();
  for (const width of [1180, 760]) {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 720), width);
    for (const name of ['New chat', 'Settings', 'Conversation details', 'End chat', 'Chats', 'Reports']) await check(name);
    await button('Reports').click(); await check('Chats');await button('Chats').click();await check('Conversation details');
    await button('Conversation details').click(); await page.getByRole('dialog').waitFor(); await page.keyboard.press('Escape');
    await button('Settings').click(); await button('Close settings').waitFor();
    await button('Close settings').hover();
    await page.screenshot({ path: `${output}/settings-${width}.png` });
    await check('Close settings');await page.getByRole('dialog',{name:'Settings',exact:true}).waitFor({state:'hidden'});
    await button('Chats').click();
    report.checks.push(`Visible navigation, Conversation details and Settings tooltip bounds/occlusion at ${width}px; menu and dialog composition`);
  }
  // Exercise clipping and all viewport edges on the real shared component.
  await button('Settings').evaluate(node => {
    node.parentElement.style.overflow = 'hidden';
    node.style.position = 'fixed'; node.style.left = '0'; node.style.bottom = '0';
  });
  await check('Settings');
  await button('Settings').evaluate(node => { node.style.left = 'auto'; node.style.right = '0'; });
  await check('Settings');
  await button('Settings').focus();
  await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
  const id = await button('Settings').getAttribute('aria-describedby'); const tip = page.locator(`[id="${id}"]`);
  await tip.waitFor({ state: 'visible' }).catch(async error=>{report.trace=await page.evaluate(()=>window.tooltipTrace.slice(-30));throw error;});
  await page.mouse.move(400, 300); await tip.waitFor({ state: 'visible' }).catch(async error=>{report.trace=await page.evaluate(()=>window.tooltipTrace.slice(-30));throw error;});
  await page.keyboard.press('Escape'); await tip.waitFor({ state: 'hidden' });
  await button('Settings').blur(); await button('Settings').hover(); await tip.waitFor({ state: 'visible' }).catch(async error=>{report.trace=await page.evaluate(()=>window.tooltipTrace.slice(-30));throw error;});
  await page.evaluate(() => window.dispatchEvent(new Event('scroll'))); await tip.waitFor({ state: 'hidden' });
  report.checks.push('Clipped parent, bottom-left/right flip and clamp; keyboard focus persists after pointer leave; Escape and scrolling dismiss');
  assert.deepEqual(report.errors, []); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.errors.push(error.stack); process.exitCode = 1; }
finally { if (app) await app.close(); writeFileSync(`${output}/report.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }
