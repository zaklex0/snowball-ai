'use strict';
// Check all export buttons against a simulated disk error using an isolated profile and test files only.
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { Store } = require('../storage');
const { ScreenshotStore } = require('../screenshot-store');
const { extractZip } = require('../archive');
const { connect, freePort } = require('./guide-shots/cdp');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9hoAAAAASUVORK5CYII=', 'base64');

(async () => {
  const root = path.resolve(__dirname, '..'), tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-export-ui-'));
  const profile = path.join(tmp, 'profile'), data = path.join(tmp, 'data');
  await fs.mkdir(profile); await fs.mkdir(data);
  await fs.writeFile(path.join(profile, 'settings.json'), JSON.stringify({ dataDir: data }));
  await fs.writeFile(path.join(data, 'profile.json'), JSON.stringify({ name: 'Тест', welcomed: true }));
  const store = await new Store(data).init();
  const prompt = await store.savePrompt({ item: { title: 'Тест', text: 'Промт' }, addFiles: [{ name: 'file.txt', data: Buffer.from('Вложение') }] });
  const attachment = path.join(store.promptDir(prompt.id), store.find(prompt.id).files[0].stored);
  await store.saveTranscript({ id: 'tr1', name: 'Тест.wav', text: 'Текст', cues: [{ start: 0, end: 1, text: 'Текст' }] });
  const skill = await store.addSkill({ name: 'skill.md', bytes: Buffer.from('# Тестовый скилл') });
  const screenshot = await new ScreenshotStore(data).add(png);
  const [inspectPort, debugPort] = await Promise.all([freePort(), freePort()]);
  const child = spawn(require('electron'), ['.', '--inspect=' + inspectPort, '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile],
    { cwd: root, stdio: 'ignore', windowsHide: true });
  try {
    const main = await connect(inspectPort, (t) => t.type === 'node');
    assert.equal(path.resolve(await main.ev("process.mainModule.require('electron').app.getPath('userData')")), path.resolve(profile));
    const page = await connect(debugPort, (t) => /index\.html/.test(t.url));
    await page.until('!!window.vsApi && document.readyState === "complete"');
    await main.ev(`(() => {
      const fs=process.mainModule.require('fs').promises, electron=process.mainModule.require('electron');
      global.snowExportRename=fs.rename;
      electron.dialog.showSaveDialog=async()=>({canceled:false,filePath:global.snowExportTarget});
      fs.rename=async (from,to)=>{if(to===global.snowExportTarget){const e=new Error('disk full');e.code='ENOSPC';throw e}return global.snowExportRename(from,to)};
      return true;
    })()`);
    const cases = [
      ['backup.snowball', `vsApi.backupExport()`],
      ['prompts.snowprompt', `vsApi.promptsExport([])`],
      ['transcript.txt', `vsApi.transcriptExport('tr1','txt',${JSON.stringify('Русский текст\nВторая строка')})`],
      ['skill.md', `vsApi.skillDownload(${JSON.stringify(skill.id)})`],
      ['image.png', `(async()=>{const s=await vsApi.captureState();const b=Uint8Array.from(atob(${JSON.stringify(png.toString('base64'))}),c=>c.charCodeAt(0));return vsApi.captureExport(${JSON.stringify(screenshot.id)},s.token,b)})()`]
    ];
    for (const [name, expr] of cases) {
      const target = path.join(tmp, name);
      await fs.writeFile(target, 'Предыдущий файл');
      await main.ev(`global.snowExportTarget=${JSON.stringify(target)}; true`);
      const result = await page.ev(expr);
      assert.equal(result.ok, false, name + ': ' + JSON.stringify(result));
      assert.match(result.error, /диске закончилось место/i);
      assert.equal(await fs.readFile(target, 'utf8'), 'Предыдущий файл');
      assert.equal((await fs.readdir(tmp)).some((x) => x.startsWith('.snowball-export-')), false);
    }
    await main.ev(`(() => {
      const fs=process.mainModule.require('fs'); fs.promises.rename=global.snowExportRename;
      global.snowExportRead=fs.createReadStream;
      fs.createReadStream=(file,...args)=>file===${JSON.stringify(attachment)}
        ? process.mainModule.require('stream').Readable.from((async function*(){yield Buffer.from('part');const e=new Error('read failed');e.code='EIO';throw e})())
        : global.snowExportRead(file,...args);
      global.snowExportTarget=${JSON.stringify(path.join(tmp, 'backup.snowball'))}; return true;
    })()`);
    const readFailure = await page.ev('vsApi.backupExport()');
    assert.equal(readFailure.ok, false);
    assert.match(readFailure.error, /Не удалось прочитать исходный файл/);
    assert.equal(await fs.readFile(path.join(tmp, 'backup.snowball'), 'utf8'), 'Предыдущий файл');
    await main.ev(`process.mainModule.require('fs').createReadStream=global.snowExportRead; true`);
    for (const [name, expr] of cases) {
      await main.ev(`global.snowExportTarget=${JSON.stringify(path.join(tmp, name))}; true`);
      const result = await page.ev(expr);
      assert.equal(result.ok, true, name + ': ' + JSON.stringify(result));
    }
    await extractZip(path.join(tmp, 'backup.snowball'), path.join(tmp, 'backup'));
    await extractZip(path.join(tmp, 'prompts.snowprompt'), path.join(tmp, 'shared'));
    assert.equal(JSON.parse(await fs.readFile(path.join(tmp, 'backup', 'prompts.json'), 'utf8')).prompts[0].text, 'Промт');
    assert.equal(JSON.parse(await fs.readFile(path.join(tmp, 'shared', 'prompts.json'), 'utf8')).prompts[0].text, 'Промт');
    assert.equal(await fs.readFile(path.join(tmp, 'transcript.txt'), 'utf8'), '\uFEFFРусский текст\r\nВторая строка');
    assert.equal(await fs.readFile(path.join(tmp, 'skill.md'), 'utf8'), '# Тестовый скилл');
    assert.deepEqual(await fs.readFile(path.join(tmp, 'image.png')), png);
    page.close(); main.close();
    console.log('OK: all exports keep an existing file on failure and produce valid output on retry');
  } finally {
    child.kill();
    await new Promise((resolve) => child.exitCode !== null ? resolve() : child.once('exit', resolve));
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
