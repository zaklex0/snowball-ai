'use strict';
// Exercise failed conversation saves using a separate profile and the offline assistant.
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { connect, freePort } = require('./guide-shots/cdp');

(async () => {
  const root = path.resolve(__dirname, '..');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-chat-failure-'));
  const profile = path.join(tmp, 'profile'), data = path.join(tmp, 'data');
  await fs.mkdir(profile, { recursive: true });
  await fs.mkdir(data, { recursive: true });
  await fs.writeFile(path.join(profile, 'settings.json'), JSON.stringify({ dataDir: data }));
  await fs.writeFile(path.join(data, 'profile.json'), JSON.stringify({ name: 'Тест', welcomed: true }));
  const [inspectorPort, browserPort] = await Promise.all([freePort(), freePort()]);
  const child = spawn(require('electron'), ['.', '--inspect=' + inspectorPort, '--remote-debugging-port=' + browserPort, '--user-data-dir=' + profile],
    { cwd: root, stdio: 'ignore', windowsHide: true });
  try {
    const main = await connect(inspectorPort, (t) => t.type === 'node');
    assert.equal(path.resolve(await main.ev("process.mainModule.require('electron').app.getPath('userData')")), path.resolve(profile));
    const page = await connect(browserPort, (t) => /index\.html/.test(t.url));
    await page.until('!!window.vsApi && document.readyState === "complete"');
    await main.ev(`(() => {
      const fs=process.mainModule.require('fs').promises;
      global.snowChatRename=fs.rename;
      fs.rename=async (from,to)=>{if(to===${JSON.stringify(path.join(data, 'chats.json'))}){const e=new Error('disk full');e.code='ENOSPC';throw e}return global.snowChatRename(from,to)};
      return true;
    })()`);
    await page.ev(`document.querySelector('[data-page="assistant"]').click(); document.querySelector('#chat-input').value='Тестовый разговор'; document.querySelector('#chat-send').click(); true`);
    await page.until(`!document.querySelector('#banner').hidden && document.querySelector('#banner-text').textContent.includes('Не удалось сохранить разговор')`);
    await page.until(`!document.querySelector('#chat-send').disabled`);
    await page.ev(`document.querySelector('#chat-new').click(); true`);
    await main.ev(`process.mainModule.require('fs').promises.rename=global.snowChatRename; true`);
    await page.ev(`document.querySelector('#banner-action').click(); true`);
    await page.until(`document.querySelector('#banner').hidden`);
    const saved = JSON.parse(await fs.readFile(path.join(data, 'chats.json'), 'utf8'));
    assert.equal(saved.chats.length, 1);
    assert.ok(saved.chats[0].messages.some((m) => m.text === 'Тестовый разговор'));
    await page.until(`!!document.querySelector('.ch-open')`);
    await page.ev(`document.querySelector('.ch-open').click(); true`);
    await page.until(`document.querySelector('#chat').textContent.includes('Тестовый разговор')`);
    await main.ev(`(() => {
      const fs=process.mainModule.require('fs').promises;
      fs.rename=async (from,to)=>{if(to===${JSON.stringify(path.join(data, 'chats.json'))}){const e=new Error('disk full');e.code='ENOSPC';throw e}return global.snowChatRename(from,to)};
      return true;
    })()`);
    await page.ev(`document.querySelector('.ch-del').click(); document.querySelector('.ch-item.confirm .danger').click(); true`);
    await page.until(`document.querySelector('#toast').textContent.includes('диске закончилось место')`);
    assert.ok(await page.ev(`document.querySelector('#chat').textContent.includes('Тестовый разговор')`));
    assert.ok(await page.ev(`!!document.querySelector('.ch-open')`));
    assert.equal(JSON.parse(await fs.readFile(path.join(data, 'chats.json'), 'utf8')).chats.length, 1);
    page.close(); main.close();
    console.log('OK: failed save can be retried after switching chats; failed deletion keeps the conversation');
  } finally {
    child.kill();
    await new Promise((resolve) => child.exitCode !== null ? resolve() : child.once('exit', resolve));
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
