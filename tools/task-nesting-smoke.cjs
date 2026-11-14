'use strict';
// Runs against an isolated profile and temporary tasks, never the owner's data.
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { connect, freePort } = require('./guide-shots/cdp');
const { Store } = require('../storage');

(async () => {
  const root = path.resolve(__dirname, '..');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-nesting-ui-'));
  const profile = path.join(tmp, 'profile'), data = path.join(tmp, 'data');
  await fs.mkdir(profile); await fs.mkdir(data);
  await fs.writeFile(path.join(profile, 'settings.json'), JSON.stringify({ dataDir: data, tabs: { list: [{ kind: 'tasks' }, { kind: 'assistant' }], active: 1 } }));
  await fs.writeFile(path.join(data, 'profile.json'), JSON.stringify({ name: 'Тест', welcomed: true }));
  const store = await new Store(data).init();
  const parent = await store.saveTask({ title: 'Фильм' });
  const childTask = await store.saveTask({ title: 'Монтаж', note: 'Сохранить заметку', due: '2026-12-01', subtasks: [{ title: 'Черновик' }] });
  const sibling = await store.saveTask({ title: 'Звук' });
  const ids = { parent: parent.id, child: childTask.id, sibling: sibling.id };
  const port = await freePort();
  const child = spawn(require('electron'), [process.argv[3] || '.', '--remote-debugging-port=' + port, '--user-data-dir=' + profile], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-6000); });
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-6000); });
  let page;
  try {
    page = await connect(port, t => /index\.html/.test(t.url));
    if (process.env.SNOWBALL_TEST_TRACE) { const evaluate = page.ev; page.ev = text => { console.log('CHECK', text.slice(0, 120)); return evaluate(text); }; }
    await page.until('!!window.vsApi && document.querySelectorAll(".tab").length === 1');
    assert.match(await page.ev('document.querySelector(".tab").textContent'), /Главная/);
    await page.ev('document.querySelector("[data-page=tasks]").click(); true');
    await page.until('document.querySelectorAll(".task").length === 3');
    await page.ev(`window.nestingIds=${JSON.stringify(ids)}; window.dragTask=(from,to,edge=false)=>{
      const source=document.querySelector('.task[data-id="'+from+'"]');
      const target=to ? document.querySelector('.task[data-id="'+to+'"]') : document.querySelector('.tcol.tc-doing');
      const dt=new DataTransfer(), box=target.getBoundingClientRect();
      source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:dt}));
      target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt,clientY:box.top+(edge?2:25)}));
      const preview=target.classList.contains(edge?'before-target':'nest-target');
      target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt,clientY:box.top+(edge?2:25)}));
      source.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:dt}));
      return preview;
    }; true`);
    assert.equal(await page.ev('dragTask(nestingIds.child,nestingIds.parent)'), true);
    await page.until(`!document.querySelector('.task[data-id="${ids.child}"]') && document.querySelectorAll('.task').length===2`);
    assert.equal(await page.ev('document.querySelectorAll(".task .task").length'), 0);
    assert.match(await page.ev(`document.querySelector('.task[data-id="${ids.parent}"]').textContent`), /0\/1/);
    assert.match(await page.ev('document.querySelector("#tpanel").textContent'), /Монтаж/);
    const saved = (await page.ev('vsApi.load()')).tasks.find(t => t.id === ids.child);
    assert.equal(saved.note, 'Сохранить заметку'); assert.equal(saved.subtasks[0].title, 'Черновик');
    // Reproduce a deep chain: only the outer card is visible, with one counter.
    await page.ev('dragTask(nestingIds.parent,nestingIds.sibling)');
    await page.until('document.querySelectorAll(".task").length===1');
    assert.match(await page.ev('document.querySelector(".task").textContent'), /0\/1/);
    assert.doesNotMatch(await page.ev('document.querySelector(".task").textContent'), /Фильм|Монтаж/);
    // Moving a deep tree keeps one outer card and leaves no children in the old column.
    await page.ev('dragTask(nestingIds.sibling,null)');
    await page.until(`!!document.querySelector('.tc-doing .task[data-id="${ids.sibling}"]') && document.querySelectorAll('.task').length===1`);
    assert.equal(await page.ev('document.querySelectorAll(".tc-todo .task").length'), 0);
    const movedTasks = (await page.ev('vsApi.load()')).tasks;
    for (const id of Object.values(ids)) assert.equal(movedTasks.find(t => t.id === id).status, 'doing');
    await page.ev(`document.querySelector('.task[data-id="${ids.sibling}"]').click();true`);
    assert.match(await page.ev('document.querySelector("#tpanel").textContent'), /Фильм/);
    if (process.argv[2]) {
      await fs.mkdir(process.argv[2], { recursive: true });
      await page.ev('document.querySelector(".tp-close").click(); true');
      for (const look of ['light', 'dark']) {
        await page.ev(`document.querySelector('button[data-look="${look}"]').click(); true`);
        await page.until('document.documentElement.dataset.theme === "macos"');
        await page.sleep(400);
        const shot = await page.send('Page.captureScreenshot', { format: 'png' });
        await fs.writeFile(path.join(process.argv[2], 'task-nesting-' + look + '.png'), Buffer.from(shot.result.data, 'base64'));
      }
    }
    // A descendant search returns the outer task, without exposing extra cards.
    await page.ev('var q=document.querySelector("#tsearch");q.value="Черновик";q.dispatchEvent(new Event("input"));true');
    assert.equal(await page.ev('document.querySelectorAll(".task").length'), 1);
    assert.equal(await page.ev('document.querySelector(".task").dataset.id'), ids.sibling);
    await page.ev('var q=document.querySelector("#tsearch");q.value="";q.dispatchEvent(new Event("input"));document.querySelector("#tview [data-v=list]").click();true');
    assert.equal(await page.ev('document.querySelectorAll(".trow").length'), 1);
    await page.ev(`document.querySelector('.trow[data-id="${ids.sibling}"]').click();true`);
    await page.ev(`document.querySelector('.task-child-open').click();true`);
    assert.equal(await page.ev('document.querySelector(".task-child-open").textContent'), 'Монтаж');
    // Completion updates the parent's counter. Opening a child retains its full details.
    await page.ev(`document.querySelector('.tp-sub[data-task-id="${ids.child}"] .tchk').click();true`);
    await page.until('document.querySelector("#tpanel .tp-block-h").textContent.includes("1 из 1")');
    await page.ev('document.querySelector(".task-child-open").click();true');
    assert.equal(await page.ev('document.querySelector(".tp-note").value'), 'Сохранить заметку');
    assert.match(await page.ev('document.querySelector("#tpanel").textContent'), /Черновик/);
    await page.ev('Array.from(document.querySelectorAll("#tpanel button")).find(b=>b.textContent==="Сделать отдельной задачей").click();true');
    await page.until(`(async()=>{const r=await vsApi.load();return r.tasks.find(t=>t.id===${JSON.stringify(ids.child)}).parentId==='';})()`);
    assert.equal((await page.ev('vsApi.load()')).tasks.find(t=>t.id===ids.child).parentId, '');
    await page.ev('document.querySelector("#tview [data-v=board]").click();true');
    await page.until(`!!document.querySelector('.tc-done .task[data-id="${ids.child}"]')`);
    assert.equal(await page.ev('document.querySelectorAll(".task .task").length'), 0);
    console.log('OK: compact parent cards; deep nesting kept inside; progress counter; descendant search; list; preserved details; detach');
  } catch (e) {
    console.error('Test app:', child.exitCode, output);
    throw e;
  } finally {
    if (page) page.close();
    child.kill();
    await new Promise(resolve => child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('exit', resolve));
    if (path.resolve(tmp).startsWith(path.resolve(os.tmpdir()) + path.sep)) await fs.rm(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
