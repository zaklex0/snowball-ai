'use strict';
// Two windows and simulated disk failures in an isolated profile, with no real user files or keys.
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { Store } = require('../storage');
const { connect, freePort } = require('./guide-shots/cdp');

(async () => {
  const root = path.resolve(__dirname, '..');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-skill-ui-'));
  const profile = path.join(tmp, 'profile'), data = path.join(tmp, 'data');
  await fs.mkdir(profile); await fs.mkdir(data);
  await fs.writeFile(path.join(profile, 'settings.json'), JSON.stringify({ dataDir: data }));
  await fs.writeFile(path.join(data, 'profile.json'), JSON.stringify({ name: 'Тест', welcomed: true }));
  const store = await new Store(data).init();
  const skill = await store.addSkill({ name: 'skill.md', bytes: Buffer.from('# Тест'), desc: 'Начальное описание', type: 'text' });
  const [inspectPort, debugPort] = await Promise.all([freePort(), freePort()]);
  const child = spawn(require('electron'), ['.', '--inspect=' + inspectPort, '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile],
    { cwd: root, stdio: 'ignore', windowsHide: true });
  try {
    const main = await connect(inspectPort, (t) => t.type === 'node');
    assert.equal(path.resolve(await main.ev("process.mainModule.require('electron').app.getPath('userData')")), path.resolve(profile));
    const first = await connect(debugPort, (t) => /index\.html/.test(t.url));
    await first.until('!!window.vsApi && document.readyState === "complete"');
    const firstId = (await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json()).find((t) => /index\.html/.test(t.url)).id;
    await first.ev(`document.querySelector('[data-page="prompts"]').click(); document.querySelector('[data-lib="skills"]').click(); true`);
    await first.until(`!!document.querySelector('button[title="Поправить название, тип и описание"]')`);
    await first.ev(`document.querySelector('button[title="Поправить название, тип и описание"]').click(); const x=document.querySelector('.sk-edit textarea'); x.value='Мой несохранённый текст'; x.dispatchEvent(new Event('input',{bubbles:true})); true`);
    await main.ev(`(() => {
      const fs=process.mainModule.require('fs').promises;
      global.snowSkillRename=fs.rename;
      fs.rename=async (from,to)=>{if(to===${JSON.stringify(path.join(data, 'skills.json'))}){const e=new Error('disk full');e.code='ENOSPC';throw e}return global.snowSkillRename(from,to)};
      return true;
    })()`);
    await first.ev(`document.querySelector('.sk-edit .btn-primary').click(); true`);
    await first.until(`document.querySelector('#toast').textContent.includes('диске закончилось место')`);
    assert.equal(await first.ev(`document.querySelector('.sk-edit textarea').value`), 'Мой несохранённый текст');
    await main.ev(`process.mainModule.require('fs').promises.rename=global.snowSkillRename; true`);
    assert.equal((await first.ev(`vsApi.windowOpen([{kind:'prompts'}])`)).ok, true);
    const second = await connect(debugPort, (t) => /index\.html/.test(t.url) && t.id !== firstId);
    await second.until('!!window.vsApi && document.readyState === "complete"');
    assert.equal((await second.ev(`vsApi.skillSave({id:${JSON.stringify(skill.id)},desc:'Другая версия'})`)).ok, true);
    await first.until(`document.querySelector('.sk-edit textarea') && document.querySelector('.sk-edit textarea').value === 'Мой несохранённый текст'`);
    await first.ev(`document.querySelector('.sk-edit .btn-primary').click(); true`);
    await first.until(`document.querySelector('#toast').textContent.includes('изменили или удалили')`);
    assert.equal(await first.ev(`document.querySelector('.sk-edit textarea').value`), 'Мой несохранённый текст');
    assert.equal(JSON.parse(await fs.readFile(path.join(data, 'skills.json'), 'utf8')).skills[0].desc, 'Другая версия');
    await main.ev(`process.mainModule.require('electron').shell.trashItem=async()=>{throw new Error('unavailable')}; true`);
    const deleted = await second.ev(`vsApi.skillDelete(${JSON.stringify(skill.id)})`);
    assert.equal(deleted.skillFileStatus, 'left');
    await first.until(`document.body.textContent.includes('Этот скилл удалили в другом окне')`);
    assert.equal(await first.ev(`document.querySelector('.sk-edit textarea').value`), 'Мой несохранённый текст');
    assert.equal(await first.ev(`document.querySelector('.sk-edit .btn-primary').disabled`), true);
    assert.equal(await fs.readFile(path.join(data, 'Скиллы', skill.id, skill.file.stored), 'utf8'), '# Тест');
    first.close(); second.close(); main.close();
    console.log('OK: failed saves and edits or deletions in another window preserve the draft and skill file');
  } finally {
    child.kill();
    await new Promise((resolve) => child.exitCode !== null ? resolve() : child.once('exit', resolve));
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
