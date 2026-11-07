'use strict';
// Real archive import with a simulated disk failure, using an isolated profile and data folder.
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { connect, freePort } = require('./guide-shots/cdp');
const { Store } = require('../storage');
const { writeZip } = require('../archive');

(async () => {
  const root = path.resolve(__dirname, '..');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-import-ui-'));
  const profile = path.join(tmp, 'profile'), data = path.join(tmp, 'data'), sourceDir = path.join(tmp, 'source');
  await fs.mkdir(profile); await fs.mkdir(data); await fs.mkdir(sourceDir);
  await fs.writeFile(path.join(profile, 'settings.json'), JSON.stringify({ dataDir: data }));
  await fs.writeFile(path.join(data, 'profile.json'), JSON.stringify({ name: 'Тест', welcomed: true }));
  const source = await new Store(sourceDir).init();
  await source.savePrompt({ item: { title: 'Промт из копии', text: 'Текст' }, addFiles: [{ name: 'file.txt', data: Buffer.from('Вложение') }] });
  await source.saveEvent({ date: '2026-11-05', title: 'Дело из копии' });
  const pack = source.packEntries('backup');
  const archive = path.join(tmp, 'test.snowball');
  await writeZip(archive, [{ name: 'manifest.json', data: JSON.stringify({ format: 'snowball-backup', counts: pack.counts }) }, ...pack.entries]);
  const [inspectPort, debugPort] = await Promise.all([freePort(), freePort()]);
  const child = spawn(require('electron'), ['.', '--inspect=' + inspectPort, '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile],
    { cwd: root, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let diagnostics = '';
  child.stderr.on('data', (chunk) => { diagnostics += chunk; });
  try {
    const main = await Promise.race([connect(inspectPort, (t) => t.type === 'node'), new Promise((_, reject) => child.once('exit', () => reject(new Error('Test app exited: ' + diagnostics))))]);
    assert.equal(path.resolve(await main.ev("process.mainModule.require('electron').app.getPath('userData')")), path.resolve(profile));
    const page = await connect(debugPort, (t) => /index\.html/.test(t.url));
    await page.until('!!window.vsApi && document.readyState === "complete"');
    await main.ev(`(() => {
      const fs=process.mainModule.require('fs').promises, electron=process.mainModule.require('electron');
      global.snowImportRename=fs.rename;
      electron.dialog.showMessageBox=async()=>({response:0});
      fs.rename=async (from,to)=>{if(to===${JSON.stringify(path.join(data, 'calendar.json'))}){const e=new Error('disk full');e.code='ENOSPC';throw e}return global.snowImportRename(from,to)};
      return true;
    })()`);
    const first = await page.ev(`vsApi.archiveOpen(${JSON.stringify(archive)})`);
    assert.equal(first.ok, false);
    assert.match(first.error, /Часть данных могла уже добавиться/);
    await page.ev(`document.querySelector('[data-page="prompts"]').click(); true`);
    await page.until(`document.body.textContent.includes('Промт из копии')`);
    const prompts = JSON.parse(await fs.readFile(path.join(data, 'prompts.json'), 'utf8')).prompts;
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].title, 'Промт из копии');
    assert.equal(await fs.readFile(path.join(data, 'Файлы', prompts[0].id, prompts[0].files[0].stored), 'utf8'), 'Вложение');
    await main.ev(`process.mainModule.require('fs').promises.rename=global.snowImportRename; true`);
    const second = await page.ev(`vsApi.archiveOpen(${JSON.stringify(archive)})`);
    assert.equal(second.ok, true);
    assert.equal(second.result.prompts, 0);
    assert.equal(second.result.events, 1);
    assert.equal(JSON.parse(await fs.readFile(path.join(data, 'calendar.json'), 'utf8')).events[0].title, 'Дело из копии');
    assert.equal(JSON.parse(await fs.readFile(path.join(data, 'prompts.json'), 'utf8')).prompts.length, 1);
    page.close(); main.close();
    console.log('OK: interrupted archive import updates the window and retry restores the remaining data without duplicates');
  } finally {
    child.kill();
    await new Promise((resolve) => child.exitCode !== null ? resolve() : child.once('exit', resolve));
    await fs.rm(tmp, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
