'use strict';
// Sources by default, or an explicitly supplied built app.asar. Isolated profile and fake tasks only.
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { connect, freePort } = require('./guide-shots/cdp');
const { Store } = require('../storage');
(async () => {
  const root = path.resolve(__dirname, '..'), tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-columns-ui-'));
  const profile = path.join(tmp, 'profile'), data = path.join(tmp, 'data');
  await fs.mkdir(profile); await fs.mkdir(data);
  await fs.writeFile(path.join(profile, 'settings.json'), JSON.stringify({ dataDir: data, theme: 'light', tabs: { list: [{ kind: 'tasks' }], active: 0 } }));
  await fs.writeFile(path.join(data, 'profile.json'), JSON.stringify({ name: 'Тест', welcomed: true }));
  const store = await new Store(data).init();
  const columns = [];
  for (const name of ['YouTube', 'Обучение', 'Личное']) columns.push(await store.addColumn(name));
  const task = await store.saveTask({ title: 'Выпуск', note: 'Сохранить заметку', due: '2026-12-01', subtasks: [{ title: 'Референсы' }] });
  const parent = await store.saveTask({ title: 'Проект' });
  const nested = await store.saveTask({ title: 'Монтаж' });
  await store.saveTask({ id: nested.id, parentId: parent.id });
  const [debugPort, inspectPort] = await Promise.all([freePort(), freePort()]);
  const child = spawn(require('electron'), [process.argv[2] || '.', '--inspect=' + inspectPort, '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile], { cwd: root, stdio: 'ignore', windowsHide: true });
  let page, main;
  try {
    main = await connect(inspectPort, t => t.type === 'node');
    assert.equal(path.resolve(await main.ev("process.mainModule.require('electron').app.getPath('userData')")), path.resolve(profile));
    await main.ev("process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].setContentSize(1280,820)");
    page = await connect(debugPort, t => /index\.html/.test(t.url));
    await page.until('document.querySelectorAll(".tab").length === 1');
    assert.match(await page.ev('document.querySelector(".tab").textContent'), /Главная/);
    await page.ev('document.querySelector("[data-page=tasks]").click();true');
    await page.until('document.querySelectorAll(".tcol").length===6 && !document.querySelector("#task-board-nav").hidden');
    await page.ev('document.querySelector("#task-board-next").click();true');
    await page.until('document.querySelector("#board").scrollLeft>150');
    await page.ev('document.querySelector("#board").scrollLeft=0;true');
    await page.sleep(250);
    const context = async (id, row = false) => {
      await page.ev(`(()=>{const card=document.querySelector('${row ? '.trow' : '.task'}[data-id="${id}"]'),r=card.getBoundingClientRect();card.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:r.left+60,clientY:r.top+20}));document.querySelector('.task-ctx [data-task-action=move]').click();return true;})()`);
    };
    const choose = id => page.ev(`document.querySelector('.task-ctx [data-column="${id}"]').click();true`);
    await context(task.id);
    assert.equal(await page.ev('document.querySelectorAll(".task-ctx button[data-column]").length'), 6);
    await choose(columns[2].id);
    await page.until(`document.querySelector('.tcol.tcc-2 > .task[data-id="${task.id}"]') !== null`);
    assert.ok(await page.ev('document.querySelector("#board").scrollLeft<5'));
    let saved = (await page.ev('vsApi.load()')).tasks.find(t => t.id === task.id);
    assert.equal(saved.note, task.note); assert.equal(saved.due, task.due); assert.deepEqual(saved.subtasks, task.subtasks);
    // Nested cards receive their own menu, and a menu move detaches them even within the same column.
    await context(nested.id); await choose('todo');
    await page.until(`document.querySelector('.tc-todo > .task[data-id="${nested.id}"]') !== null`);
    // A stale menu must not overwrite a newer status from another window.
    await context(nested.id);
    await page.ev(`vsApi.taskSave({id:${JSON.stringify(nested.id)},status:'doing'})`);
    await choose(columns[0].id);
    await page.until('document.querySelector("#toast").textContent.includes("другом окне")');
    saved = (await page.ev('vsApi.load()')).tasks.find(t => t.id === nested.id); assert.equal(saved.status, 'doing');
    // Add a column through the visible header control.
    await page.ev('document.querySelector("#task-column-add").click();true');
    await page.until('!!document.querySelector(".tcol-new input")');
    await page.ev('const input=document.querySelector(".tcol-new input");input.value="Проекты";input.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));true');
    await page.until('document.querySelectorAll(".tcol:not(.tcol-new)").length===7');
    // The same menu works in the list and archive; archived tasks can be restored by moving.
    await page.ev('document.querySelector("#tview [data-v=list]").click();true');
    assert.equal(await page.ev('document.querySelector("#task-board-nav").hidden'), true);
    await context(task.id, true); await choose('done');
    await page.until(`(async()=>{const r=await vsApi.load();return r.tasks.find(t=>t.id===${JSON.stringify(task.id)}).status==='done'})()`);
    await page.ev(`vsApi.tasksArchive([${JSON.stringify(task.id)}])`);
    // Force an ordinary refresh via another window's sync, as the direct API save bypassed the originating renderer.
    await main.ev("process.mainModule.require('electron').BrowserWindow.getAllWindows().filter(w=>/index\\.html/.test(w.webContents.getURL())).forEach(w=>w.webContents.reload())");
    await page.until('document.querySelectorAll(".tab").length===1');
    await page.ev('document.querySelector("[data-page=tasks]").click();document.querySelector("#tview [data-v=archive]").click();true');
    await page.until(`!!document.querySelector('.trow[data-id="${task.id}"]')`);
    await context(task.id, true); await choose('todo');
    await page.until(`(async()=>{const r=await vsApi.load();return r.tasks.find(t=>t.id===${JSON.stringify(task.id)}).archivedAt===0})()`);
    await page.ev('document.querySelector("#tview [data-v=board]").click();true');
    await page.until(`!!document.querySelector('.task[data-id="${task.id}"]')`);
    // Keyboard access and both new themes, plus the existing macOS light/dark look.
    await page.ev(`const card=document.querySelector('.task[data-id="${task.id}"]');card.focus();card.dispatchEvent(new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true}));true`);
    assert.equal(await page.ev('document.querySelector(".task-ctx").hidden'), false);
    await page.ev('document.querySelector(".task-ctx").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));true');
    await page.ev('document.querySelector("[data-guide=tasks]").click();true');
    await page.until('document.querySelector(".guide-dlg[open] img")?.naturalWidth > 0');
    await page.ev('document.querySelector(".guide-dlg").close();true');
    for (const theme of ['codex-absolutely', 'codex-everforest']) {
      await page.ev(`document.querySelector('button[data-theme="${theme}"]').click();true`);
      await page.until(`document.documentElement.dataset.theme==='${theme}'`);
      assert.equal(await page.ev('document.querySelector("#board").clientWidth>400'), true);
    }
    for (const look of ['light', 'dark']) {
      await page.ev(`document.querySelector('button[data-look="${look}"]').click();true`);
      await page.until('document.documentElement.dataset.theme === "macos"');
      await context(task.id); assert.equal(await page.ev('document.querySelector(".task-ctx").getBoundingClientRect().right <= innerWidth'), true);
      await page.ev('document.querySelector(".task-ctx").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));true');
    }
    console.log('OK: scrolling; offscreen move; preserved fields; detach; stale menu conflict; add column; list/archive; keyboard; Codex and macOS themes');
  } finally {
    if (page) page.close(); if (main) main.close(); child.kill();
    await new Promise(resolve => child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('exit', resolve));
    if (path.resolve(tmp).startsWith(path.resolve(os.tmpdir()) + path.sep)) await fs.rm(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
