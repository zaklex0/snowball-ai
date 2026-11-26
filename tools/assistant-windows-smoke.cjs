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
    await first.ev(`document.querySelector('#chat-input').value='Создай подгруппу «Монтаж»'; document.querySelector('#chat-send').click(); true`);
    await first.until(`Array.from(document.querySelectorAll('.act-card')).at(-1).textContent.includes('Создать подгруппу «Монтаж»?')`);
    assert.deepEqual((await first.ev('vsApi.load()')).taskGroups, []);
    await first.ev(`Array.from(document.querySelectorAll('.act-card')).at(-1).querySelector('.btn-primary').click(); true`);
    await first.until(`Array.from(document.querySelectorAll('.act-card')).at(-1).textContent.includes('Подгруппа создана')`);
    assert.equal((await second.ev('vsApi.load()')).taskGroups[0].name, 'Монтаж');
    await first.until(`!document.querySelector('#chat-send').disabled`);
    assert.equal((await first.ev('vsApi.setConfirm(false)')).ok, true);
    await first.ev(`document.querySelector('#chat-input').value='Добавь подгруппу Съёмки'; document.querySelector('#chat-send').click(); true`);
    await first.until(`Array.from(document.querySelectorAll('.act-card')).at(-1).textContent.includes('Подгруппа создана') && Array.from(document.querySelectorAll('.act-card')).at(-1).querySelectorAll('.link-btn').length === 2`);
    assert.deepEqual((await first.ev('vsApi.load()')).taskGroups.map(g => g.name), ['Монтаж', 'Съёмки']);
    await first.ev(`Array.from(document.querySelectorAll('.act-card')).at(-1).querySelectorAll('.link-btn')[1].click(); true`);
    await first.until(`Array.from(document.querySelectorAll('.act-card')).at(-1).textContent.includes('всё вернул как было')`);
    assert.deepEqual((await first.ev('vsApi.load()')).taskGroups.map(g => g.name), ['Монтаж']);
    assert.equal((await first.ev('vsApi.setConfirm(true)')).ok, true);
    async function taskCard(text, label, before) {
      const count = await first.ev("document.querySelectorAll('.act-card').length");
      const card = "Array.from(document.querySelectorAll('.act-card')).at(-1)";
      await first.ev(`document.querySelector('#chat-input').value=${JSON.stringify(text)}; document.querySelector('#chat-send').click(); true`);
      await first.until(`document.querySelectorAll('.act-card').length === ${count + 1} && ${card}.textContent.includes(${JSON.stringify(label)})`);
      if (before) await before();
      await first.ev(`${card}.querySelector('.btn-primary').click(); true`);
      await first.until(`!!${card}.querySelector('.act-done') && !document.querySelector('#chat-send').disabled`);
      return first.ev('vsApi.load()');
    }
    let taskState = await taskCard('добавь задачу новую "привет как дела", положи ее в подгруппу "салам алейкум"', 'Подгруппа «салам алейкум»', async () => {
      assert.deepEqual((await first.ev('vsApi.load()')).tasks, []);
    });
    const greeting = taskState.tasks.find(t => t.title === 'привет как дела');
    assert.ok(greeting);
    assert.equal(taskState.taskGroups.find(g => g.id === greeting.groupId).name, 'салам алейкум');
    taskState = await taskCard('Перемести задачу «привет как дела» во вкладку «В процессе»', 'Станет: «привет как дела», В процессе');
    assert.equal(taskState.tasks.find(t => t.id === greeting.id).status, 'doing');
    taskState = await taskCard('Закрой задачу «привет как дела»', 'Станет: «привет как дела», Готово');
    const closed = taskState.tasks.find(t => t.id === greeting.id);
    assert.equal(closed.status, 'done');
    assert.equal(closed.groupId, greeting.groupId);
    first.close(); second.close(); main.close();
    console.log('OK: action retries, parallel conversations, calendar conflicts, group and task creation, moves, closing, confirmation and undo');
  } finally {
    child.kill();
    await new Promise((resolve) => child.exitCode !== null ? resolve() : child.once('exit', resolve));
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
