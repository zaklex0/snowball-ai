'use strict';
// Isolated profile: completion keeps groups, resuming work restarts the timeline.
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { Store } = require('../storage');
const { connect, freePort } = require('./guide-shots/cdp');

(async () => {
  const root = path.resolve(__dirname, '..'), tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-task-lifecycle-'));
  const profile = path.join(tmp, 'profile'), data = path.join(tmp, 'data');
  await fs.mkdir(profile);
  await fs.writeFile(path.join(profile, 'settings.json'), JSON.stringify({ dataDir: data, theme: 'light' }));
  const store = await new Store(data).init();
  await store.setArchiveMode('manual');
  await fs.writeFile(path.join(data, 'profile.json'), JSON.stringify({ name: 'Гость', welcomed: true }));
  const group = await store.addTaskGroup('Работа'), empty = await store.addTaskGroup('Новая пустая');
  const archived = await store.addTaskGroup('Завершённый проект');
  const oldStart = Date.now() - 86400e3;
  const a = await store.saveTask({ title: 'Первая задача', groupId: group.id, startedAt: oldStart });
  const b = await store.saveTask({ title: 'Вторая задача', groupId: group.id, status: 'doing', startedAt: oldStart });
  const finished = await store.saveTask({ title: 'В архиве', groupId: archived.id, status: 'done' });
  await store.archiveDone([finished.id]);
  const [inspectPort, debugPort] = await Promise.all([freePort(), freePort()]);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [process.argv[2] || '.', '--inspect=' + inspectPort, '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile], { cwd: root, env, stdio: 'ignore', windowsHide: true });
  let page, main;
  try {
    main = await connect(inspectPort, t => t.type === 'node');
    assert.equal(path.resolve(await main.ev("process.mainModule.require('electron').app.getPath('userData')")), profile);
    page = await connect(debugPort, t => /index\.html/.test(t.url));
    const open = async () => {
      await page.until('!!window.vsApi && document.readyState==="complete"');
      await page.ev('document.querySelectorAll("dialog[open]").forEach(d=>d.close());document.querySelector("[data-page=tasks]").click();true');
      await page.until('!!document.querySelector(".tc-todo")');
    };
    const groupSelector = (status, id = group.id) => `.tc-${status} .task-group[data-group="${id}"]`;
    const hasGroup = (status, id) => page.ev(`!!document.querySelector(${JSON.stringify(groupSelector(status, id))})`);
    const loadTask = async id => (await page.ev('vsApi.load()')).tasks.find(t => t.id === id);
    const drag = async status => {
      await page.ev(`(()=>{const source=document.querySelector('.task[data-id="${a.id}"]'),target=document.querySelector('.tc-${status}'),dt=new DataTransfer();source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:dt}));target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));return true})()`);
      await page.until(`!!document.querySelector('.tc-${status} .task[data-id="${a.id}"]')`);
    };
    await open();
    assert.equal(await hasGroup('todo', empty.id), true);
    assert.equal(await hasGroup('todo', archived.id), true);
    await drag('doing');
    let saved = await loadTask(a.id);
    assert.ok(saved.startedAt > oldStart);
    const firstStart = saved.startedAt;
    await drag('todo');
    await drag('doing');
    saved = await loadTask(a.id);
    assert.ok(saved.startedAt > firstStart);
    await page.ev(`document.querySelector('.task[data-id="${a.id}"]').click();true`);
    await page.until('!!document.querySelector(".tl-step")');
    assert.equal(await page.ev(`Array.from(document.querySelectorAll('.tl-step')).find(e=>e.querySelector('.tl-name').textContent==='Начата').querySelector('.tl-at').title`), new Date(saved.startedAt).toLocaleString('ru-RU'));
    await page.ev('document.querySelector(".tp-close").click();true');
    for (const id of [a.id, b.id]) {
      await page.ev(`document.querySelector('.task[data-id="${id}"] .tchk').click();true`);
      await page.until(`!!document.querySelector('.tc-done .task[data-id="${id}"]')`);
      assert.equal(await hasGroup('todo'), true);
    }
    assert.equal(await hasGroup('doing'), false);
    assert.equal(await hasGroup('done'), true);
    assert.equal(await hasGroup('todo', empty.id), true);
    // Done tasks are visible in the list, including after completing one while its group was folded.
    await page.ev('document.querySelector("#tview [data-v=list]").click();true');
    assert.equal(await page.ev(`!!document.querySelector('.trow[data-id="${a.id}"]')`), true);
    await page.ev(`document.querySelector('.trow[data-id="${a.id}"] .tchk').click();true`);
    await page.until(`!!document.querySelector('.trow[data-id="${a.id}"]:not(.is-done)')`);
    await page.ev('document.querySelector(".tgroup-fold").click();true');
    await page.ev(`document.querySelector('.trow[data-id="${a.id}"] .tchk').click();true`);
    await page.until(`!!document.querySelector('.trow.is-done[data-id="${a.id}"]') && document.querySelector('.tgroup-fold').getAttribute('aria-expanded') === 'true'`);
    const restartedAt = (await loadTask(a.id)).startedAt;
    assert.ok(restartedAt >= saved.startedAt);
    await page.ev('document.querySelector("#tview [data-v=board]").click();true');
    await page.ev('document.querySelector(".tarch-btn").click();true');
    await page.until('!document.querySelector(".tc-done .task")');
    assert.equal(await hasGroup('todo'), true);
    await page.send('Page.reload'); await open();
    assert.equal(await hasGroup('todo'), true);
    assert.equal((await loadTask(a.id)).startedAt, restartedAt);
    // Returning an archived task restores its original group without creating a duplicate.
    await page.ev(`vsApi.taskSave({id:${JSON.stringify(a.id)},status:'todo'})`);
    await page.send('Page.reload'); await open();
    assert.equal(await hasGroup('todo'), true);
    assert.equal((await loadTask(a.id)).groupId, group.id);
    assert.equal(await page.ev(`document.querySelectorAll(${JSON.stringify(groupSelector('todo'))}).length`), 1);
    await page.ev(`document.querySelector(${JSON.stringify(groupSelector('todo'))} + ' .task-group-rename').click();true`);
    await page.ev(`Array.from(document.querySelectorAll(${JSON.stringify(groupSelector('todo'))} + ' .task-group-pop button')).find(b=>b.textContent.includes('Удалить подгруппу')).click();true`);
    await page.ev(`Array.from(document.querySelectorAll(${JSON.stringify(groupSelector('todo'))} + ' .task-group-pop button')).find(b=>b.textContent==='Удалить').click();true`);
    await page.until(`!document.querySelector(${JSON.stringify(groupSelector('todo'))})`);
    assert.equal((await loadTask(a.id)).groupId, '');
    assert.equal((await loadTask(b.id)).groupId, '');
    console.log('PASS: completion and archive keep groups; deletion preserves active and archived tasks.');
  } finally {
    if (page) page.close(); if (main) main.close(); child.kill();
    await new Promise(r => child.exitCode !== null || child.signalCode !== null ? r() : child.once('exit', r));
    const resolved = path.resolve(tmp);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) await fs.rm(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
