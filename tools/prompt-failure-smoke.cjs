'use strict';
// Exercises a failed save in an isolated profile; the fake disk error never affects the real data folder.
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { connect, freePort } = require('./guide-shots/cdp');

(async () => {
  const root = path.resolve(__dirname, '..'), tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-save-failure-'));
  const profile = path.join(tmp, 'profile'), data = path.join(tmp, 'data'), dir = path.join(data, 'Файлы', 'p1');
  const attachment = path.join(dir, 'old.txt');
  await fs.mkdir(profile, { recursive: true }); await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(profile, 'settings.json'), JSON.stringify({ dataDir: data }));
  await fs.writeFile(path.join(data, 'profile.json'), JSON.stringify({ name: 'Тест', welcomed: true }));
  await fs.writeFile(attachment, 'Старый файл');
  await fs.writeFile(path.join(data, 'prompts.json'), JSON.stringify({ format: 'snowball', version: 1, prompts: [
    { id: 'p1', title: 'Тест', type: 'Видео', text: 'Старый текст', files: [{ id: 'f1', name: 'old.txt', stored: 'old.txt', size: 20 }] }
  ] }));
  const [inspectPort, debugPort] = await Promise.all([freePort(), freePort()]);
  const child = spawn(require('electron'), ['.', '--inspect=' + inspectPort, '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile],
    { cwd: root, stdio: 'ignore', windowsHide: true });
  try {
    const main = await connect(inspectPort, (t) => t.type === 'node');
    assert.equal(path.resolve(await main.ev("process.mainModule.require('electron').app.getPath('userData')")), path.resolve(profile));
    const page = await connect(debugPort, (t) => /index\.html/.test(t.url));
    await page.until('!!window.vsApi && document.readyState === "complete"');
    await page.ev(`document.querySelector('[data-page="prompts"]').click(); true`);
    await page.until(`!!document.querySelector('.edit-btn')`);
    await main.ev(`(() => {
      const fs=process.mainModule.require('fs').promises, electron=process.mainModule.require('electron');
      global.snowTestRename=fs.rename; global.snowTestTrash=electron.shell.trashItem;
      fs.rename=async (from,to)=>{if(to===${JSON.stringify(path.join(data, 'prompts.json'))}){const e=new Error('disk full');e.code='ENOSPC';throw e}return global.snowTestRename(from,to)};
      electron.shell.trashItem=async (p)=>{if(!p.startsWith(${JSON.stringify(dir + path.sep)}))throw Error('wrong test path');await fs.rm(p,{force:true})};
      return true;
    })()`);
    await page.ev(`document.querySelector('.edit-btn').click(); document.querySelector('#f-text').value='Новый текст'; document.querySelector('#f-files .tile-remove').click(); document.querySelector('#editor').requestSubmit(); true`);
    await page.until(`!document.querySelector('#save-btn').disabled && document.querySelector('#form-msg').textContent.includes('Не сохранилось')`);
    assert.equal(await page.ev(`document.querySelector('#f-text').value`), 'Новый текст');
    assert.match(await page.ev(`document.querySelector('#toast').textContent`), /диске закончилось место/);
    assert.equal(await fs.readFile(attachment, 'utf8'), 'Старый файл');
    assert.equal(JSON.parse(await fs.readFile(path.join(data, 'prompts.json'), 'utf8')).prompts[0].text, 'Старый текст');
    await main.ev(`process.mainModule.require('fs').promises.rename=global.snowTestRename; true`);
    await page.ev(`document.querySelector('#editor').requestSubmit(); true`);
    await page.until(`document.querySelector('#editor').hidden`);
    const saved = await page.ev('vsApi.load()');
    assert.equal(saved.prompts[0].text, 'Новый текст');
    assert.equal(saved.prompts[0].files.length, 0);
    await assert.rejects(fs.access(attachment), { code: 'ENOENT' });
    page.close(); main.close();
    console.log('OK: failed save keeps the form, prompt and attachment; successful retry commits changes');
  } finally {
    child.kill();
    await new Promise((resolve) => child.exitCode !== null ? resolve() : child.once('exit', resolve));
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
