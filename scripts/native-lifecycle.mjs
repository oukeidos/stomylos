/** Exercise normal save-first close, with a bounded failure instead of a hung driver. */
export async function closeNative(app, timeout = 10000) {
  if (!app || app.process().exitCode !== null) return;
  let timer;
  const exited = new Promise((resolve, reject) => {
    app.process().once('exit', resolve);
    timer = setTimeout(() => reject(new Error('Normal window close did not exit; inspect pending save/exit UI')), timeout);
  });
  try {
    await Promise.all([exited, app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())]);
  } finally { clearTimeout(timer); }
}
/** Explicitly generate an opener when a voice scenario needs an assistant source. */
export async function ensureSpeechSource(page) {
  await page.getByRole('textbox', {name:'Your message',exact:true}).waitFor();
  if (await page.getByRole('button',{name:'Give me something',exact:true}).count()) {
    await page.getByRole('button',{name:'Give me something',exact:true}).click();
    await page.getByRole('button',{name:'Listen',exact:true}).first().waitFor();
  }
}
