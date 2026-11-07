'use strict';
// Isolated profile, offline assistant and temporary data only.
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { connect, freePort } = require('./guide-shots/cdp');

(async () => {
  const root = path.resolve(__dirname, '..');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-assistant-windows-'));
  const profile = path.join(tmp, 'profile'), data = path.join(tmp, 'data');
  await fs.mkdir(profile); await fs.mkdir(data);
  await fs.writeFile(path.join(profile, 'settings.json'), JSON.stringify({ dataDir: data }));
  await fs.writeFile(path.join(data, 'profile.json'), JSON.stringify({ name: 'Тест', welcomed: true }));
  const [inspectPort, debugPort] = await Promise.all([freePort(), freePort()]);
  const child = spawn(require('electron'), ['.', '--inspect=' + inspectPort, '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile], { cwd: root, stdio: 'ignore', windowsHide: true });
  try {
    const main = await connect(inspectPort, (t) => t.type === 'node');
    assert.equal(path.resolve(await main.ev("process.mainModule.require('electron').app.getPath('userData')")), path.resolve(profile));
    const first = await connect(debugPort, (t) => /index\.html/.test(t.url));
    await first.until('!!window.vsApi && document.readyState === "complete"');
    const firstId = (await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json()).find((t) => /index\.html/.test(t.url)).id;
    await first.ev(`document.querySelector('[data-page="assistant"]').click(); document.querySelector('#chat-input').value='Добавь промт «Тест карточки»'; document.querySelector('#chat-send').click(); true`);
    await first.until(`!!document.querySelector('.act-card .btn-primary') && !document.querySelector('#chat-send').disabled`, 30000);
    await main.ev(`(() => { const fs=process.mainModule.require('fs').promises; global.snowAssistantRename=fs.rename; fs.rename=async (from,to)=>{if(to===${JSON.stringify(path.join(data, 'prompts.json'))}){const e=new Error('disk full');e.code='ENOSPC';throw e}return global.snowAssistantRename(from,to)}; return true; })()`);
    await first.ev(`document.querySelector('.act-card .btn-primary').click(); true`);
    await first.until(`document.querySelector('#toast').textContent.includes('диске закончилось место')`);
    assert.equal(await first.ev(`document.querySelector('.act-card .btn-primary').disabled`), false);
    await main.ev(`process.mainModule.require('fs').promises.rename=global.snowAssistantRename; true`);
    await first.ev(`document.querySelector('.act-card .btn-primary').click(); true`);
    await first.until(`document.querySelector('.act-card').textContent.includes('Промт сохранён')`);
    assert.equal((await first.ev('vsApi.load()')).prompts.length, 1);

    const id = (await first.ev('vsApi.chatList()')).chats[0].id;
    assert.equal((await first.ev(`vsApi.windowOpen([{kind:'assistant',chatId:${JSON.stringify(id)}}])`)).ok, true);
    const second = await connect(debugPort, (t) => /index\.html/.test(t.url) && t.id !== firstId);
    await second.until(`document.querySelector('#chat') && document.querySelector('#chat').textContent.includes('Тест карточки')`);
    await first.ev(`document.querySelector('#chat-input').value='Сообщение из первого окна'; document.querySelector('#chat-send').click(); true`);
    await first.until(`!document.querySelector('#chat-send').disabled && document.querySelector('#chat').textContent.includes('Сообщение из первого окна')`, 30000);
    await first.until(`(async()=>{const r=await vsApi.chatGet(${JSON.stringify(id)});return r.chat.messages.some(m=>m.text==='Сообщение из первого окна') && r.chat.messages.at(-1).role==='assistant'})()`);
    await second.ev(`document.querySelector('#chat-input').value='Несохранённый текст второго окна'; document.querySelector('#chat-send').click(); true`);
    await second.until(`!document.querySelector('#banner').hidden && document.querySelector('#banner-text').textContent.includes('другом окне')`);
    const saved = (await first.ev(`vsApi.chatGet(${JSON.stringify(id)})`)).chat;
    assert.ok(saved.messages.some((m) => m.text === 'Сообщение из первого окна'));
    assert.ok(!saved.messages.some((m) => m.text === 'Несохранённый текст второго окна'));
    await main.ev(`process.mainModule.require('electron').clipboard.writeText=(text)=>{global.snowCopiedText=text}; true`);
    await second.ev(`document.querySelector('#banner-action').click(); true`);
    await main.until(`typeof global.snowCopiedText==='string' && global.snowCopiedText.includes('Несохранённый текст второго окна')`);

    const event = await first.ev(`vsApi.calSave({date:'2026-11-06',from:'15:00',title:'Встреча Альфа'})`);
    assert.equal(event.ok, true);
    await first.ev(`document.querySelector('#chat-input').value='Удали встречу Альфа'; document.querySelector('#chat-send').click(); true`);
    await first.until(`document.querySelectorAll('.act-card').length === 2 && !document.querySelector('#chat-send').disabled`, 30000);
    assert.equal((await second.ev(`vsApi.calSave({id:${JSON.stringify(event.id)},date:'2026-11-06',from:'16:00',title:'Встреча Альфа'})`)).ok, true);
    await first.ev(`Array.from(document.querySelectorAll('.act-card')).at(-1).querySelector('.btn-danger').click(); true`);
    await first.until(`document.querySelector('#toast').textContent.includes('уже изменили')`);
    assert.equal((await first.ev('vsApi.load()')).events.find((e) => e.id === event.id).from, '16:00');
    first.close(); second.close(); main.close();
    console.log('OK: actions retry safely; newer conversations and events survive changes in another window');
  } finally {
    child.kill();
    await new Promise((resolve) => child.exitCode !== null ? resolve() : child.once('exit', resolve));
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
