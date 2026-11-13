'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { Store } = require('../storage');
const { connect, freePort } = require('./guide-shots/cdp');
(async () => {
  const root = path.resolve(__dirname, '..'), tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-group-drop-'));
  const profile = path.join(tmp, 'profile'), data = path.join(tmp, 'data'); await fs.mkdir(profile);
  await fs.writeFile(path.join(profile, 'settings.json'), JSON.stringify({ dataDir: data, theme: 'light' }));
  const store = await new Store(data).init(); await store.setArchiveMode('manual');
  await fs.writeFile(path.join(data, 'profile.json'), JSON.stringify({ name: 'Гость', welcomed: true }));
  const a = await store.addTaskGroup('YouTube'), b = await store.addTaskGroup('Курс');
  const legacy = await store.saveTask({ title: 'Старая задача', note: 'Не потерять заметку', priority: 2, due: '2026-12-01', subtasks: [{ title: 'Проверить результат' }] });
  await store.saveTask({ title: 'Другая без подгруппы' });
  const target = await store.saveTask({ title: 'Задача курса', groupId: b.id });
  const [inspectPort, debugPort] = await Promise.all([freePort(), freePort()]);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [process.argv[2] || '.', '--inspect=' + inspectPort, '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile], { cwd: root, env, stdio: 'ignore', windowsHide: true });
  let main, page;
  try {
    main = await connect(inspectPort, t => t.type === 'node');
    assert.equal(path.resolve(await main.ev("process.mainModule.require('electron').app.getPath('userData')")), profile);
    page = await connect(debugPort, t => /index\.html/.test(t.url));
    await page.until('!!window.vsApi && document.readyState==="complete"');
    await page.ev('document.querySelectorAll("dialog[open]").forEach(d=>d.close());document.querySelector("[data-page=tasks]").click();true');
    await page.until('document.querySelectorAll(".task").length===3');
    const drag = async selector => {
      await page.ev(`(()=>{const source=document.querySelector('.task[data-id="${legacy.id}"]'),target=document.querySelector(${JSON.stringify(selector)}),r=target.getBoundingClientRect(),dt=new DataTransfer();source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:dt}));target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt,clientY:r.top+20}));target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt,clientY:r.top+20}));source.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:dt}));return true})()`);
    };
    const placed = (status, groupId) => page.until(`!!document.querySelector('.tc-${status} .task-group[data-group="${groupId}"] .task[data-id="${legacy.id}"]')`);
    // Empty group, via its header.
    await drag(`.tc-todo .task-group[data-group="${a.id}"] .task-group-head`); await placed('todo', a.id);
    let saved = (await page.ev('vsApi.load()')).tasks.find(t => t.id === legacy.id);
    assert.equal(saved.note, legacy.note); assert.equal(saved.priority, 2); assert.equal(saved.due, legacy.due); assert.deepEqual(saved.subtasks, legacy.subtasks);
    // A collapsed group remains a valid drop target and opens after the move.
    await page.ev(`document.querySelector('.tc-todo .task-group[data-group="${b.id}"] .task-group-fold').click();true`);
    await drag(`.tc-todo .task-group[data-group="${b.id}"] .task-group-head`); await placed('todo', b.id);
    assert.equal(await page.ev(`document.querySelector('.tc-todo .task-group[data-group="${b.id}"] .task-group-fold').getAttribute('aria-expanded')`), 'true');
    // Moving back to the ungrouped area.
    await drag('.tc-todo .task-group[data-group=""] .task-group-head'); await placed('todo', '');
    // Dropping on a card in a different group changes the category, not nesting.
    await drag(`.task[data-id="${target.id}"]`); await placed('todo', b.id);
    saved = (await page.ev('vsApi.load()')).tasks.find(t => t.id === legacy.id); assert.equal(saved.parentId, '');
    // A drop on empty column space still preserves the category and creates it there.
    await drag('.tc-doing'); await placed('doing', b.id);
    saved = (await page.ev('vsApi.load()')).tasks.find(t => t.id === legacy.id); assert.equal(saved.groupId, b.id);
    // Reload persistence and proper numbering after category changes.
    await page.send('Page.reload'); await page.until('!!window.vsApi && document.readyState==="complete"');
    await page.ev('document.querySelector("[data-page=tasks]").click();true'); await placed('doing', b.id);
    saved = (await page.ev('vsApi.load()')).tasks.find(t => t.id === legacy.id); assert.equal(saved.number, 1); assert.equal(saved.note, legacy.note);
    console.log('PASS: ungrouped → empty group, collapsed group, back to ungrouped, card drop, column drop preserving category, details and restart.');
  } finally {
    if (page) page.close(); if (main) main.close(); child.kill();
    await new Promise(r => child.exitCode !== null || child.signalCode !== null ? r() : child.once('exit', r));
    if (path.resolve(tmp).startsWith(path.resolve(os.tmpdir()) + path.sep)) await fs.rm(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
