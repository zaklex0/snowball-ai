'use strict';
// Real application, synthetic images and an isolated temporary profile.
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { ScreenshotStore } = require('../screenshot-store');
const { connect, freePort } = require('./guide-shots/cdp');

(async () => {
  const root = path.resolve(__dirname, '..');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-shots-recovery-'));
  const profile = path.join(tmp, 'profile'), data = path.join(tmp, 'data');
  await fs.mkdir(profile); await fs.mkdir(data);
  await fs.writeFile(path.join(profile, 'settings.json'), JSON.stringify({ dataDir: data, captureShortcut: 'Alt+Shift+F12', captureShortcutInitialized: true }));
  await fs.writeFile(path.join(data, 'profile.json'), JSON.stringify({ name: 'Тест', welcomed: true }));
  const store = new ScreenshotStore(data), png = await fs.readFile(path.join(root, 'assets', 'icon.png'));
  let shot;
  for (let i = 0; i < 300; i++) shot = await store.add(png);
  const started = performance.now();
  assert.equal((await store.list()).length, 300);
  const listMs = Math.round(performance.now() - started);
  const [inspectPort, debugPort] = await Promise.all([freePort(), freePort()]);
  const child = spawn(require('electron'), ['.', '--inspect=' + inspectPort, '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile], { cwd: root, stdio: 'ignore', windowsHide: true });
  try {
    const main = await connect(inspectPort, (t) => t.type === 'node');
    assert.equal(path.resolve(await main.ev("process.mainModule.require('electron').app.getPath('userData')")), path.resolve(profile));
    const page = await connect(debugPort, (t) => /index\.html/.test(t.url));
    await page.until('!!window.vsApi && document.readyState === "complete"');
    const firstId = (await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json()).find((t) => /index\.html/.test(t.url)).id;
    await page.ev(`document.querySelector('.capture-nav').click(); true`);
    await page.until(`window.screenshotEditor && document.querySelectorAll('.shot-card').length === 300`, 30000);
    await page.ev(`window.screenshotEditor.open(${JSON.stringify(shot.id)})`);
    await page.until(`document.querySelector('.shot-card.active')?.dataset.id === ${JSON.stringify(shot.id)}`);
    for (const section of ['home', 'prompts', 'calendar', 'tasks', 'assistant', 'transcribe', 'generator']) {
      await page.ev(`document.querySelector('[data-page=${section}]').click(); true`);
      assert.equal(await page.ev(`document.querySelector('[data-page=${section}]').getAttribute('aria-current')`), 'page');
    }
    await page.ev(`document.querySelector('.capture-nav').click(); true`);
    assert.equal(await page.ev(`document.querySelector('.shot-card.active')?.dataset.id`), shot.id);

    const meta = path.join(store.folder(shot.id), 'meta.json');
    await main.ev(`(() => { const fs=process.mainModule.require('fs').promises,e=process.mainModule.require('electron'); global.snowShotRename=fs.rename; global.snowShotFail=true; fs.rename=async(from,to)=>{if(global.snowShotFail && to===${JSON.stringify(meta)}){const e=new Error('disk full');e.code='ENOSPC';throw e}return global.snowShotRename(from,to)}; e.dialog.showSaveDialog=async()=>({canceled:false,filePath:${JSON.stringify(path.join(tmp, 'recovery.png'))}}); e.shell.trashItem=async(folder)=>{if(folder!==${JSON.stringify(store.folder(shot.id))})throw Error('unexpected path');await fs.rename(folder,${JSON.stringify(path.join(tmp, 'trash'))})}; return true; })()`);
    const rect = await page.ev(`(()=>{const r=document.querySelector('.shot-stage canvas').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})()`);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x + rect.w * .2, y: rect.y + rect.h * .2, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x + rect.w * .6, y: rect.y + rect.h * .6, button: 'left', buttons: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x + rect.w * .6, y: rect.y + rect.h * .6, button: 'left', clickCount: 1 });
    await page.until(`!document.querySelector('.shot-recovery').hidden && document.querySelector('.shot-status').textContent.includes('диске закончилось место')`);
    await page.ev(`document.querySelector('.shot-recover').click(); true`);
    await page.until(`document.querySelector('.shot-status').textContent.includes('сохранён в файл')`);
    assert.ok((await fs.stat(path.join(tmp, 'recovery.png'))).size > 0);
    assert.equal((await store.get(shot.id)).ops.length, 0);
    await main.ev('global.snowShotFail=false; true');
    assert.equal(await page.ev('window.screenshotEditor.flush()'), true);
    assert.equal((await store.get(shot.id)).ops.length, 1);

    await page.ev(`document.querySelector('.shot-card.active .shot-delete').click(); true`);
    await page.until(`!document.querySelector('.shot-toast').hidden`);
    await main.ev('global.snowShotFail=true; true');
    await page.ev(`document.querySelector('.shot-toast button').click(); true`);
    await page.until(`document.querySelector('.shot-status').textContent.includes('диске закончилось место')`);
    assert.equal(await page.ev(`!document.querySelector('.shot-toast').hidden`), true);
    await main.ev('global.snowShotFail=false; true');
    await page.ev(`document.querySelector('.shot-toast button').click(); true`);
    await page.until(`document.querySelector('.shot-status').textContent.includes('Снимок восстановлен')`);
    assert.equal((await store.get(shot.id)).ops.length, 1);

    const brokenDir = store.folder('s' + 'f'.repeat(32)), backup = path.join(tmp, 'existing.snowball');
    await fs.mkdir(brokenDir);
    await fs.writeFile(path.join(brokenDir, 'meta.json'), '{invalid json');
    await fs.writeFile(backup, 'Не заменять');
    await page.ev('window.screenshotEditor.refresh()');
    assert.equal(await page.ev(`!document.querySelector('.shot-library-warning').hidden`), true);
    await main.ev(`process.mainModule.require('electron').dialog.showSaveDialog=async()=>({canceled:false,filePath:${JSON.stringify(backup)}}); true`);
    const backupResult = await page.ev('vsApi.backupExport()');
    assert.equal(backupResult.ok, false);
    assert.ok(backupResult.error.includes('Резервная копия не создана'));
    assert.equal(await fs.readFile(backup, 'utf8'), 'Не заменять');
    await fs.unlink(path.join(brokenDir, 'meta.json')); await fs.rmdir(brokenDir);
    await page.ev('window.screenshotEditor.refresh()');
    assert.equal(await page.ev(`document.querySelector('.shot-library-warning').hidden`), true);

    assert.equal((await page.ev(`vsApi.windowOpen([{kind:'screenshots'}])`)).ok, true);
    const second = await connect(debugPort, (t) => /index\.html/.test(t.url) && t.id !== firstId);
    await second.until(`window.screenshotEditor && document.querySelectorAll('.shot-card').length === 300`, 30000);
    await second.ev(`window.screenshotEditor.open(${JSON.stringify(shot.id)})`);
    await second.until(`document.querySelector('.shot-card.active')?.dataset.id === ${JSON.stringify(shot.id)}`);
    const secondRect = await second.ev(`(()=>{const r=document.querySelector('.shot-stage canvas').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})()`);
    for (const [type, at, extra] of [['mousePressed', .25, {button:'left',clickCount:1}], ['mouseMoved', .5, {button:'left',buttons:1}], ['mouseReleased', .5, {button:'left',clickCount:1}]])
      await second.send('Input.dispatchMouseEvent', { type, x: secondRect.x + secondRect.w * at, y: secondRect.y + secondRect.h * at, ...extra });
    assert.equal(await second.ev('window.screenshotEditor.flush()'), true);
    assert.equal((await store.get(shot.id)).ops.length, 2);
    for (const [type, at, extra] of [['mousePressed', .3, {button:'left',clickCount:1}], ['mouseMoved', .7, {button:'left',buttons:1}], ['mouseReleased', .7, {button:'left',clickCount:1}]])
      await page.send('Input.dispatchMouseEvent', { type, x: rect.x + rect.w * at, y: rect.y + rect.h * at, ...extra });
    await page.until(`!document.querySelector('.shot-recovery').hidden && document.querySelector('.shot-status').textContent.includes('изменён в другом окне')`);
    assert.equal((await store.get(shot.id)).ops.length, 2);
    page.close(); second.close(); main.close();
    console.log(`OK: 300 screenshots listed in ${listMs} ms; navigation, recovery, backup safety and concurrent edits work`);
  } finally {
    child.kill();
    await new Promise((resolve) => child.exitCode !== null ? resolve() : child.once('exit', resolve));
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
