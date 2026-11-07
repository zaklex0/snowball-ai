'use strict';
// Profile tests use only temporary folders, a synthetic avatar and isolated app profiles.
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { connect, freePort } = require('./guide-shots/cdp');
const { writeZip } = require('../archive');

(async () => {
  const root = path.resolve(__dirname, '..'), tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-profile-ui-'));
  const profile = path.join(tmp, 'profile'), data = path.join(tmp, 'data'), image = path.join(tmp, 'new.png');
  await fs.mkdir(profile); await fs.mkdir(data);
  await fs.writeFile(path.join(profile, 'settings.json'), JSON.stringify({ dataDir: data }));
  await fs.writeFile(path.join(data, 'profile.json'), JSON.stringify({ name: 'Старый ник', welcomed: true, avatarAt: 123 }));
  const png = await fs.readFile(path.join(root, 'assets', 'icon.png'));
  await fs.writeFile(path.join(data, 'avatar.png'), png); await fs.writeFile(image, png);
  let child;
  const launch = (dir, inspect, debug) => spawn(require('electron'), ['.', '--inspect=' + inspect, '--remote-debugging-port=' + debug, '--user-data-dir=' + dir],
    { cwd: root, stdio: 'ignore', windowsHide: true });
  const stop = async () => { if (!child) return; child.kill(); await new Promise((resolve) => child.exitCode !== null ? resolve() : child.once('exit', resolve)); child = null; };
  try {
    let [inspectPort, debugPort] = await Promise.all([freePort(), freePort()]);
    child = launch(profile, inspectPort, debugPort);
    const main = await connect(inspectPort, (t) => t.type === 'node');
    assert.equal(path.resolve(await main.ev("process.mainModule.require('electron').app.getPath('userData')")), path.resolve(profile));
    const first = await connect(debugPort, (t) => /index\.html/.test(t.url));
    await first.until('!!window.vsApi && document.readyState === "complete"');
    const firstId = (await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json()).find((t) => /index\.html/.test(t.url)).id;
    await main.ev(`(() => {
      const fs=process.mainModule.require('fs').promises,electron=process.mainModule.require('electron');
      global.snowProfileRename=fs.rename;
      fs.rename=async(from,to)=>{if(to===${JSON.stringify(path.join(data, 'profile.json'))}){const e=new Error('disk full');e.code='ENOSPC';throw e}return global.snowProfileRename(from,to)};
      electron.dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(image)}]});
      electron.shell.trashItem=async(file)=>{if(!file.startsWith(${JSON.stringify(data + path.sep)}))throw Error('wrong test path');await fs.unlink(file)};
      return true;
    })()`);
    await first.ev(`document.querySelector('#stats-edit').click(); document.querySelector('#pd-name').value='Мой новый ник'; document.querySelector('#pd-pick').click(); true`);
    await first.until(`document.querySelector('#pd-avatar img') && document.querySelector('#pd-avatar img').src.startsWith('data:image/png')`);
    await first.ev(`document.querySelector('#pd-form').requestSubmit(); true`);
    await first.until(`document.querySelector('#pd-msg').textContent.includes('Не сохранилось')`);
    assert.equal(await first.ev(`document.querySelector('#profile-dlg').open`), true);
    assert.equal(await first.ev(`document.querySelector('#pd-name').value`), 'Мой новый ник');
    assert.ok(await first.ev(`document.querySelector('#pd-avatar img').src.startsWith('data:image/png')`));
    assert.deepEqual(await fs.readFile(path.join(data, 'avatar.png')), png);
    assert.equal(JSON.parse(await fs.readFile(path.join(data, 'profile.json'), 'utf8')).name, 'Старый ник');
    await main.ev(`process.mainModule.require('fs').promises.rename=global.snowProfileRename; true`);
    await first.ev(`document.querySelector('#pd-form').requestSubmit(); true`);
    await first.until(`!document.querySelector('#profile-dlg').open`);
    assert.equal((await first.ev('vsApi.load()')).profile.name, 'Мой новый ник');
    await assert.rejects(fs.access(path.join(data, 'avatar.png')), { code: 'ENOENT' });

    assert.equal((await first.ev(`vsApi.windowOpen([{kind:'home'}])`)).ok, true);
    const second = await connect(debugPort, (t) => /index\.html/.test(t.url) && t.id !== firstId);
    await second.until('!!window.vsApi && document.readyState === "complete"');
    await first.ev(`window.profileSync=null; vsApi.onSync(d=>{if(d.profile)window.profileSync=d.profile}); document.querySelector('#stats-edit').click(); document.querySelector('#pd-name').value='Черновик ника'; true`);
    assert.equal((await second.ev(`vsApi.saveProfile({name:'Ник из другого окна'})`)).ok, true);
    await first.until(`window.profileSync && window.profileSync.name==='Ник из другого окна'`);
    await first.ev(`document.querySelector('#pd-form').requestSubmit(); true`);
    await first.until(`document.querySelector('#toast').textContent.includes('Профиль изменили')`);
    assert.equal(await first.ev(`document.querySelector('#pd-name').value`), 'Черновик ника');
    assert.equal((await first.ev('vsApi.load()')).profile.name, 'Ник из другого окна');
    await first.ev(`document.querySelector('#pd-cancel').click(); document.querySelector('#stats-edit').click(); document.querySelector('#pd-name').value='Совмещённый ник'; window.profileSync=null; true`);
    const dataUrl = 'data:image/png;base64,' + png.toString('base64');
    const otherAvatar = await second.ev(`vsApi.saveProfile({avatar:${JSON.stringify(dataUrl)}})`);
    assert.equal(otherAvatar.ok, true);
    await first.until(`window.profileSync && window.profileSync.avatarVersion===${JSON.stringify(otherAvatar.profile.avatarVersion)}`);
    await first.ev(`document.querySelector('#pd-form').requestSubmit(); true`);
    await first.until(`!document.querySelector('#profile-dlg').open`);
    const combined = (await first.ev('vsApi.load()')).profile;
    assert.equal(combined.name, 'Совмещённый ник');
    assert.equal(combined.avatarVersion, otherAvatar.profile.avatarVersion);

    await first.ev(`document.querySelector('#stats-edit').click(); document.querySelector('#pd-remove').click(); window.profileSync=null; true`);
    const newer = await second.ev(`vsApi.saveProfile({avatar:${JSON.stringify(dataUrl)}})`);
    assert.equal(newer.ok, true);
    await first.until(`window.profileSync && window.profileSync.avatarVersion===${JSON.stringify(newer.profile.avatarVersion)}`);
    await first.ev(`document.querySelector('#pd-form').requestSubmit(); true`);
    await first.until(`document.querySelector('#pd-msg').textContent.includes('Не сохранилось')`);
    assert.equal(await first.ev(`document.querySelector('#profile-dlg').open`), true);
    assert.equal((await first.ev('vsApi.load()')).profile.avatarVersion, newer.profile.avatarVersion);
    await first.ev(`document.querySelector('#pd-cancel').click(); true`);
    const prompt = await first.ev(`vsApi.savePrompt({item:{title:'Тест переноса',text:'Текст'},addFiles:[{name:'file.txt',data:new TextEncoder().encode('Исходный файл')}]})`);
    assert.equal(prompt.ok, true);
    const destination = path.join(tmp, 'destination'), targetFile = path.join(destination, 'Файлы', prompt.id, 'file.txt');
    await fs.mkdir(path.dirname(targetFile), { recursive: true });
    await fs.writeFile(targetFile, 'Чужой файл');
    await main.ev(`process.mainModule.require('electron').dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(destination)}]}); true`);
    const failedMove = await first.ev('vsApi.changeDataDir()');
    assert.equal(failedMove.ok, false);
    assert.match(failedMove.error, /другой файл/);
    assert.equal(await fs.readFile(targetFile, 'utf8'), 'Чужой файл');
    assert.equal(path.resolve((await first.ev('vsApi.load()')).info.dataDir), path.resolve(data));
    await assert.rejects(fs.access(path.join(destination, 'prompts.json')), { code: 'ENOENT' });
    await fs.writeFile(targetFile, 'Исходный файл');
    const moved = await first.ev('vsApi.changeDataDir()');
    assert.equal(moved.ok, true);
    assert.equal(path.resolve(moved.info.dataDir), path.resolve(destination));
    assert.equal(moved.profile.name, 'Совмещённый ник');
    assert.ok(moved.profile.avatar);
    const movedProfile = JSON.parse(await fs.readFile(path.join(destination, 'profile.json'), 'utf8'));
    assert.deepEqual(await fs.readFile(path.join(destination, movedProfile.avatarFile)), png);
    first.close(); second.close(); main.close(); await stop();

    const profile2 = path.join(tmp, 'welcome-profile'), data2 = path.join(tmp, 'welcome-data');
    await fs.mkdir(profile2); await fs.mkdir(data2);
    await fs.writeFile(path.join(profile2, 'settings.json'), JSON.stringify({ dataDir: data2 }));
    [inspectPort, debugPort] = await Promise.all([freePort(), freePort()]);
    child = launch(profile2, inspectPort, debugPort);
    const main2 = await connect(inspectPort, (t) => t.type === 'node');
    assert.equal(path.resolve(await main2.ev("process.mainModule.require('electron').app.getPath('userData')")), path.resolve(profile2));
    const page2 = await connect(debugPort, (t) => /index\.html/.test(t.url));
    await page2.until(`!!document.querySelector('#profile-dlg[open]')`);
    await main2.ev(`(() => {const fs=process.mainModule.require('fs').promises;global.snowWelcomeRename=fs.rename;
      fs.rename=async(from,to)=>{if(to===${JSON.stringify(path.join(data2, 'profile.json'))}){const e=new Error('disk full');e.code='ENOSPC';throw e}return global.snowWelcomeRename(from,to)};return true;})()`);
    await page2.ev(`document.querySelector('#pd-cancel').click(); true`);
    await page2.until(`document.querySelector('#pd-msg').textContent.includes('Не получилось сохранить выбор')`);
    assert.equal(await page2.ev(`document.querySelector('#profile-dlg').open`), true);
    await main2.ev(`process.mainModule.require('fs').promises.rename=global.snowWelcomeRename; true`);
    await page2.ev(`document.querySelector('#pd-cancel').click(); true`);
    await page2.until(`!document.querySelector('#profile-dlg').open`);
    assert.equal(JSON.parse(await fs.readFile(path.join(data2, 'profile.json'), 'utf8')).welcomed, true);
    page2.close(); main2.close(); await stop();

    const profile3 = path.join(tmp, 'restore-profile'), data3 = path.join(tmp, 'restore-data'), archive = path.join(tmp, 'profile.snowball');
    await fs.mkdir(profile3); await fs.mkdir(data3);
    await fs.writeFile(path.join(profile3, 'settings.json'), JSON.stringify({ dataDir: data3 }));
    await writeZip(archive, [
      { name: 'manifest.json', data: JSON.stringify({ format: 'snowball-backup', counts: {} }) },
      { name: 'prompts.json', data: JSON.stringify({ prompts: [] }) },
      { name: 'profile.json', data: JSON.stringify({ name: 'Профиль из копии', welcomed: true, avatarAt: 123 }) },
      { name: 'avatar.png', file: image }
    ]);
    [inspectPort, debugPort] = await Promise.all([freePort(), freePort()]);
    child = launch(profile3, inspectPort, debugPort);
    const main3 = await connect(inspectPort, (t) => t.type === 'node');
    assert.equal(path.resolve(await main3.ev("process.mainModule.require('electron').app.getPath('userData')")), path.resolve(profile3));
    const page3 = await connect(debugPort, (t) => /index\.html/.test(t.url));
    await page3.until(`!!document.querySelector('#profile-dlg[open]')`);
    await main3.ev(`(() => {const d=process.mainModule.require('electron').dialog;
      d.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(archive)}]});d.showMessageBox=async()=>({response:0});return true;})()`);
    await page3.ev(`document.querySelector('#pd-restore-btn').click(); true`);
    await page3.until(`document.querySelector('#banner-text').textContent.includes('Восстановлено из копии: профиль')`);
    const restored = (await page3.ev('vsApi.load()')).profile;
    assert.equal(restored.name, 'Профиль из копии');
    assert.ok(restored.avatar);
    assert.equal(await page3.ev(`document.querySelector('#profile-dlg').open`), false);
    page3.close(); main3.close();
    console.log('OK: profile drafts survive failures and conflicts; welcome skip and restoring an avatar work');
  } finally {
    await stop();
    await fs.rm(tmp, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
