'use strict';
// Exercise recovery and failed settings saves in a separate profile and separate data directories.
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { connect, freePort } = require('./guide-shots/cdp');

(async () => {
  const root = path.resolve(__dirname, '..'), tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-settings-ui-'));
  const profile = path.join(tmp, 'profile'), data = path.join(tmp, 'data'), nextData = path.join(tmp, 'new-data');
  await fs.mkdir(profile); await fs.mkdir(data); await fs.mkdir(nextData);
  await fs.writeFile(path.join(data, 'profile.json'), JSON.stringify({ name: 'Тест', welcomed: true }));
  await fs.writeFile(path.join(profile, 'settings.json'), '{broken');
  await fs.writeFile(path.join(profile, 'settings.backup.json'), JSON.stringify({ dataDir: data, theme: 'dark' }));
  let child;
  const launch = (inspect, debug) => spawn(require('electron'), ['.', '--inspect=' + inspect, '--remote-debugging-port=' + debug, '--user-data-dir=' + profile],
    { cwd: root, stdio: 'ignore', windowsHide: true });
  const stop = async () => {
    if (!child) return;
    child.kill();
    await new Promise((resolve) => child.exitCode !== null ? resolve() : child.once('exit', resolve));
    child = null;
  };
  try {
    let [inspectPort, debugPort] = await Promise.all([freePort(), freePort()]);
    child = launch(inspectPort, debugPort);
    const main = await connect(inspectPort, (t) => t.type === 'node');
    assert.equal(path.resolve(await main.ev("process.mainModule.require('electron').app.getPath('userData')")), path.resolve(profile));
    const page = await connect(debugPort, (t) => /index\.html/.test(t.url));
    await page.until('!!window.vsApi && document.readyState === "complete"');
    await page.until(`document.querySelector('#banner-text').textContent.includes('восстановлены из запасной копии')`);
    assert.equal(path.resolve((await page.ev('vsApi.load()')).info.dataDir), path.resolve(data));
    const broken = (await fs.readdir(profile)).find((name) => /^settings\.broken-/.test(name));
    assert.equal(await fs.readFile(path.join(profile, broken), 'utf8'), '{broken');
    await page.sleep(700); // let startup settings settle before the simulated disk failure
    const before = JSON.parse(await fs.readFile(path.join(profile, 'settings.json'), 'utf8'));
    await main.ev(`(() => {const fs=process.mainModule.require('fs');global.snowSettingsRename=fs.renameSync;
      fs.renameSync=(from,to)=>{if(to===${JSON.stringify(path.join(profile, 'settings.json'))}){const e=new Error('disk full');e.code='ENOSPC';throw e}return global.snowSettingsRename(from,to)};
      return true;})()`);
    assert.equal((await page.ev(`vsApi.setTheme('light')`)).ok, true);
    await page.until(`document.querySelector('#settings-persist-warning').textContent.includes('Не удалось сохранить настройки')`);
    assert.equal(JSON.parse(await fs.readFile(path.join(profile, 'settings.json'), 'utf8')).theme, before.theme);
    await main.ev(`process.mainModule.require('electron').dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(nextData)}]}); true`);
    const failed = await page.ev('vsApi.changeDataDir()');
    assert.equal(failed.ok, false);
    assert.match(failed.error, /Прежняя папка остаётся открытой/);
    assert.equal(path.resolve((await page.ev('vsApi.load()')).info.dataDir), path.resolve(data));
    assert.equal(path.resolve(JSON.parse(await fs.readFile(path.join(profile, 'settings.json'), 'utf8')).dataDir), path.resolve(data));
    await main.ev(`process.mainModule.require('fs').renameSync=global.snowSettingsRename; true`);
    const moved = await page.ev('vsApi.changeDataDir()');
    assert.equal(moved.ok, true);
    assert.equal(path.resolve(moved.info.dataDir), path.resolve(nextData));
    assert.equal(path.resolve(JSON.parse(await fs.readFile(path.join(profile, 'settings.json'), 'utf8')).dataDir), path.resolve(nextData));
    await page.until(`!document.querySelector('#settings-persist-warning').textContent.includes('Не удалось сохранить настройки')`);
    page.close(); main.close();
    await stop();
    [inspectPort, debugPort] = await Promise.all([freePort(), freePort()]);
    child = launch(inspectPort, debugPort);
    const againMain = await connect(inspectPort, (t) => t.type === 'node');
    assert.equal(path.resolve(await againMain.ev("process.mainModule.require('electron').app.getPath('userData')")), path.resolve(profile));
    const again = await connect(debugPort, (t) => /index\.html/.test(t.url));
    await again.until('!!window.vsApi && document.readyState === "complete"');
    assert.equal(path.resolve((await again.ev('vsApi.load()')).info.dataDir), path.resolve(nextData));
    again.close(); againMain.close();
    console.log('OK: settings recover, failures are reported, and changing folders is committed only after saving');
  } finally {
    await stop();
    await fs.rm(tmp, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
