'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { Store } = require('../storage');
const { connect, freePort } = require('./guide-shots/cdp');
(async () => {
  const root = path.resolve(__dirname, '..'), tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-task-range-'));
  const profile = path.join(tmp, 'profile'), data = path.join(tmp, 'data'); await fs.mkdir(profile);
  await fs.writeFile(path.join(profile, 'settings.json'), JSON.stringify({ dataDir: data, theme: 'light' }));
  const store = await new Store(data).init(); await store.setArchiveMode('manual');
  await fs.writeFile(path.join(data, 'profile.json'), JSON.stringify({ name: 'Гость', welcomed: true }));
  const group = await store.addTaskGroup('YouTube Reels');
  for (let i = 1; i <= 10; i++) await store.saveTask({ title: 'Задача ' + i, note: 'Заметка ' + i, subtasks: [{ title: 'Шаг' }] });
  await store.saveTask({ title: 'Уже в Reels', groupId: group.id });
  await store.saveTask({ title: 'В работе', status: 'doing' });
  const original = store.tasksView(), expected = original.filter(t => t.status === 'todo' && [6,7,8,9,10].includes(t.number)).map(t => t.id);
  const existing = original.filter(t => t.groupId === group.id).map(t => t.id);
  const [inspectPort, debugPort] = await Promise.all([freePort(), freePort()]);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [process.argv[2] || '.', '--inspect=' + inspectPort, '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile], { cwd: root, env, stdio: 'ignore', windowsHide: true });
  let main, page;
  try {
    main = await connect(inspectPort, t => t.type === 'node');
    assert.equal(path.resolve(await main.ev("process.mainModule.require('electron').app.getPath('userData')")), profile);
    page = await connect(debugPort, t => /index\.html/.test(t.url));
    await page.until('!!window.vsApi && document.readyState==="complete"');
    const ask = text => page.ev('vsApi.tasksAssistant(' + JSON.stringify(text) + ')');
    await page.ev('document.querySelectorAll("dialog[open]").forEach(d=>d.close());document.querySelector("[data-page=tasks]").click();true');
    await page.until('document.querySelectorAll(".task").length===12');
    const visible = await page.ev('Array.from(document.querySelectorAll(".tc-todo .task"),t=>({id:t.dataset.id,number:Number(t.querySelector(".tchk").dataset.taskNumber)})).filter(t=>t.number>=6&&t.number<=10).map(t=>t.id)');
    assert.deepEqual(visible, expected);
    let r = await ask('Задачи с 6-й по 10-ю перемести в подгруппу YouTube Reels');
    assert.equal(r.failed, false); assert.ok(r.undoId); assert.deepEqual(r.tasks.filter(t => t.groupId === group.id).map(t => t.id).sort(), expected.concat(existing).sort());
    for (const id of expected) assert.ok(r.reply.includes(original.find(t => t.id === id).title));
    for (const id of expected) { const t = r.tasks.find(t => t.id === id), prev = original.find(t => t.id === id); assert.equal(t.status, 'todo'); assert.equal(t.note, prev.note); assert.deepEqual(t.subtasks, prev.subtasks); }
    r = await page.ev('vsApi.tasksAssistantUndo(' + JSON.stringify(r.undoId) + ')'); assert.deepEqual(r.tasks, original);
    r = await ask('Задачи 1 перемести в подгруппу YouTube Reels'); assert.equal(r.undoId, null); assert.deepEqual(r.tasks, original); assert.match(r.reply, /столбц/);
    r = await ask('Задачи с 6-й по 9-ю из Предстоит перемести в подгруппу Несуществующая'); assert.equal(r.undoId, null); assert.deepEqual(r.tasks, original);
    r = await ask('Задачи с 6-й по 19-ю из Предстоит перемести в подгруппу YouTube Reels'); assert.equal(r.undoId, null); assert.deepEqual(r.tasks, original);
    r = await ask('Задачи 6, 8 и 9 из Предстоит перемести в подгруппу YouTube Reels'); assert.equal(r.tasks.filter(t => t.groupId === group.id).length, 4);
    await page.ev('vsApi.tasksAssistantUndo(' + JSON.stringify(r.undoId) + ')');
    r = await ask('Перемести задачи 6-9 из Предстоит в В процессе'); assert.equal(r.tasks.filter(t => t.status === 'doing').length, 5);
    await ask('Отмени последнее действие');
    r = await ask('Перемести задачи 6-10 из Предстоит в подгруппу YouTube Reels');
    assert.deepEqual(r.tasks.filter(t => t.groupId === group.id).map(t => t.id).sort(), expected.concat(existing).sort());
    r = await ask('Переименуй задачу 1 из Предстоит в Новое название'); assert.equal(r.taskUndo.count, 2);
    r = await ask('Отмени последние 2 действия'); assert.deepEqual(r.tasks, original); assert.equal(r.taskUndo.count, 0);
    // The persistent button survives a renderer reload, after the original toast disappears.
    await ask('Перемести задачи 6-10 из Предстоит в подгруппу YouTube Reels');
    await page.send('Page.reload'); await page.until('!!window.vsApi && document.readyState==="complete"');
    await page.ev('document.querySelectorAll("dialog[open]").forEach(d=>d.close());document.querySelector("[data-page=tasks]").click();true');
    await page.until('!document.querySelector("#task-undo").disabled');
    await page.ev('document.querySelector("#task-undo").click();true');
    await page.until('document.querySelector("#task-undo").disabled && document.querySelectorAll(".tnote").length>0');
    assert.deepEqual((await page.ev('vsApi.load()')).tasks, original);
    console.log('PASS: exact user phrase, frozen IDs, details, undo, ambiguous column, missing group/number, lists and column ranges.');
  } finally {
    if (page) page.close(); if (main) main.close(); child.kill();
    await new Promise(r => child.exitCode !== null || child.signalCode !== null ? r() : child.once('exit', r));
    if (path.resolve(tmp).startsWith(path.resolve(os.tmpdir()) + path.sep)) await fs.rm(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
