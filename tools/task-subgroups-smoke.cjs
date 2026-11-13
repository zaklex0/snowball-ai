'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { connect, freePort } = require('./guide-shots/cdp');
const { Store } = require('../storage');
(async () => {
  const root = path.resolve(__dirname, '..'), tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-real-groups-'));
  const profile = path.join(tmp, 'profile'), data = path.join(tmp, 'data'); await fs.mkdir(profile);
  await fs.writeFile(path.join(profile, 'settings.json'), JSON.stringify({ dataDir: data, theme: 'light', bounds: { width: 1440, height: 900 } }));
  const s = await new Store(data).init(); await s.setArchiveMode('manual');
  await fs.writeFile(path.join(data, 'profile.json'), JSON.stringify({ name: 'Гость', welcomed: true }));
  const youtube = await s.addTaskGroup('YouTube'), course = await s.addTaskGroup('Курс');
  const a = await s.saveTask({ title: 'Написать сценарий', groupId: youtube.id, note: 'Сохранить заметку' });
  const b = await s.saveTask({ title: 'Записать урок', groupId: course.id });
  const c = await s.saveTask({ title: 'Смонтировать ролик', groupId: youtube.id, status: 'doing', subtasks: [{ title: 'Собрать черновик' }] });
  const [inspectPort, debugPort] = await Promise.all([freePort(), freePort()]);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [process.argv[2] || '.', '--inspect=' + inspectPort, '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile], { cwd: root, env, stdio: 'ignore', windowsHide: true });
  let page, main;
  try {
    main = await connect(inspectPort, t => t.type === 'node');
    assert.equal(path.resolve(await main.ev("process.mainModule.require('electron').app.getPath('userData')")), profile);
    page = await connect(debugPort, t => /index\.html/.test(t.url));
    await page.until('!!window.vsApi && document.readyState==="complete"');
    await page.ev('document.querySelectorAll("dialog[open]").forEach(d=>d.close());document.querySelector("[data-page=tasks]").click();true');
    await page.until('document.querySelectorAll(".task canvas").length===3');
    assert.equal(await page.ev('document.querySelectorAll(".task-add").length'), 0);
    assert.equal(await page.ev(`!!(document.querySelector('.tc-todo .task-group-add').compareDocumentPosition(document.querySelector('.tc-todo .task-group')) & Node.DOCUMENT_POSITION_FOLLOWING)`), true);
    assert.deepEqual(await page.ev('Array.from(document.querySelectorAll(".tc-todo .task .tchk"),e=>e.dataset.taskNumber)'), ['1', '2']);
    assert.deepEqual(await page.ev('Array.from(document.querySelectorAll(".tc-doing .task .tchk"),e=>e.dataset.taskNumber)'), ['1']);
    let r = await page.ev('vsApi.tasksAssistant("Удали задачу 1")');
    assert.match(r.reply, /нескольких столбцах/); assert.equal(r.tasks.length, 3);
    r = await page.ev('vsApi.tasksAssistant("Перенеси задачу 2 из Предстоит в В процессе")');
    assert.equal(r.tasks.find(t => t.id === b.id).status, 'doing'); assert.equal(r.tasks.find(t => t.id === b.id).groupId, course.id);
    assert.equal(r.tasks.find(t => t.id === b.id).number, 2);
    r = await page.ev('vsApi.tasksAssistant("Перенеси задачу 2 из В процессе в Готово")');
    assert.equal(r.tasks.find(t => t.id === b.id).status, 'done'); assert.equal(r.tasks.find(t => t.id === b.id).number, 1);
    r = await page.ev('vsApi.tasksAssistant("Переименуй задачу 1 из Готово в Подготовить курс")');
    assert.equal(r.tasks.find(t => t.id === b.id).title, 'Подготовить курс');
    const before = r.tasks;
    r = await page.ev('vsApi.tasksAssistant("Удали задачу 99 из Предстоит")'); assert.deepEqual(r.tasks, before);
    // Reload after direct IPC calls and verify destination groups appear once.
    await page.send('Page.reload'); await page.until('!!window.vsApi && document.readyState==="complete"');
    await page.ev('document.querySelector("[data-page=tasks]").click();true');
    await page.until(`document.querySelectorAll('.tc-done .task-group[data-group="${course.id}"]').length===1`);
    await page.ev('document.querySelector(".task-group-add").click();true');
    await page.until('!!document.querySelector(".task-group-input")');
    await page.ev('const g=document.querySelector(".task-group-input");g.value="Работа";g.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));true');
    await page.until('Array.from(document.querySelectorAll(".task-group-name")).some(e=>e.textContent==="Работа")');
    const work = (await page.ev('vsApi.load()')).taskGroups.find(g => g.name === 'Работа');
    await page.ev(`document.querySelector('.tc-todo .task-group[data-group="${work.id}"] .task-group-plus').click();true`);
    await page.until('!!document.querySelector(".task-input")');
    await page.ev('const t=document.querySelector(".task-input");t.value="Отправить правки";t.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));true');
    await page.until(`(async()=>{const r=await vsApi.load();return r.tasks.some(t=>t.title==='Отправить правки'&&t.groupId===${JSON.stringify(work.id)})})()`);
    await page.ev('document.querySelector(".task-input")?.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));true');
    // Drag onto another column's card: move, preserve category, do not accidentally nest.
    await page.ev(`(()=>{const source=document.querySelector('.task[data-id="${a.id}"]'),target=document.querySelector('.task[data-id="${c.id}"]'),r=target.getBoundingClientRect(),data=new DataTransfer();source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:data}));target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data,clientY:r.top+25}));return true})()`);
    await page.until(`!!document.querySelector('.tc-doing .task[data-id="${a.id}"]')`);
    r = await page.ev('vsApi.load()'); assert.equal(r.tasks.find(t=>t.id===a.id).parentId, ''); assert.equal(r.tasks.find(t=>t.id===a.id).note, 'Сохранить заметку');
    await page.ev(`document.querySelector('.task[data-id="${a.id}"]').click();true`);
    await page.until('!!document.querySelector(".task-group-select")');
    assert.equal(await page.ev('document.querySelector(".task-group-select").value'), youtube.id);
    await page.ev('document.querySelector(".tp-close").click();true');
    for (const style of [{ theme: 'light' }, { look: 'light', accent: 'blue' }, { look: 'dark', accent: 'blue' }]) {
      if (style.theme) await page.ev(`document.querySelector('button[data-theme="light"]').click();true`);
      else {
        await page.ev(`document.querySelector('button[data-accent="blue"]').click();true`);
        await page.until('document.documentElement.dataset.theme==="macos" && document.documentElement.dataset.accent==="blue"');
        await page.ev(`document.querySelector('button[data-look="${style.look}"]').click();true`);
      }
      await page.sleep(120);
      assert.equal(await page.ev('Array.from(document.querySelectorAll(".task .tchk")).every(b=>b.querySelector("canvas") && b.dataset.stampedNumber===b.dataset.taskNumber)'), true);
    }
    await page.ev(`document.querySelector('button[data-look="light"]').click();true`);
    await page.sleep(200);
    const image = await page.send('Page.captureScreenshot', { format: 'png' }); await fs.writeFile(path.join(root, 'mockups/tasks-implemented-macos.png'), Buffer.from(image.result.data, 'base64'));
    await page.ev('document.querySelector("button[data-guide=tasks]").click();true');
    await page.until('!!document.querySelector("dialog.guide-dlg[open]")');
    assert.equal(await page.ev('document.querySelectorAll(".gd-dots button").length'), 9);
    for (let step = 0; step < 9; step++) {
      await page.ev(`document.querySelectorAll('.gd-dots button')[${step}].click();true`);
      await page.until('(()=>{const i=document.querySelector(".gd-shot img");return i?.complete&&i.naturalWidth===1280})()');
      assert.equal(await page.ev('document.querySelectorAll(".gd-shot .gd-frame").length>0'), true);
    }
    await page.ev('document.querySelector(".gd-dots button").click();true');
    await page.until('document.querySelector(".gd-shot img")?.complete');
    const guideImage = await page.send('Page.captureScreenshot', { format: 'png' }); await fs.writeFile(path.join(root, 'mockups/task-groups-guide-preview.png'), Buffer.from(guideImage.result.data, 'base64'));
    console.log('PASS: real board groups, source-scoped assistant references, renumbering, move/nesting separation, group/task creation, retained details, canvas numbers and macOS light/dark.');
  } finally {
    if (page) page.close(); if (main) main.close(); child.kill();
    await new Promise(r => child.exitCode !== null || child.signalCode !== null ? r() : child.once('exit', r));
    if (path.resolve(tmp).startsWith(path.resolve(os.tmpdir()) + path.sep)) await fs.rm(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
