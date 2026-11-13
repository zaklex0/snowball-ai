'use strict';
// Run with Electron. A memory-only browser session, generated tasks, no user data.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
app.whenReady().then(async () => {
  const root = path.resolve(__dirname, '..');
  const win = new BrowserWindow({ width: 1440, height: 1040, show: false, webPreferences: { partition: 'subgroups-check-' + Date.now(), contextIsolation: true, nodeIntegration: false } });
  const errors = [];
  win.webContents.on('console-message', e => { if (e.level === 'error') errors.push(e.message); });
  const macos = process.argv.includes('--macos');
  await win.loadFile(path.join(root, macos ? 'mockups/task-subgroups-macos-blue.html' : 'mockups/task-subgroups.html'));
  const ev = s => win.webContents.executeJavaScript(s);
  await ev('document.fonts.ready.then(()=>true)');
  const count = (status, group) => ev(`document.querySelectorAll('.column[data-status="${status}"] .group[data-group="${group}"]').length`);
  assert.equal(await ev('document.querySelectorAll(".task").length'), 7);
  assert.equal(await ev('document.querySelectorAll(".add-task").length'), 0, 'No duplicate new-task buttons under groups');
  assert.equal(await ev(`!!(document.querySelector('.column[data-status=todo] > .add-group').compareDocumentPosition(document.querySelector('.column[data-status=todo] .group')) & Node.DOCUMENT_POSITION_FOLLOWING)`), true, 'New subgroup button precedes all groups');
  const numbers = status => ev(`Array.from(document.querySelectorAll('.column[data-status="${status}"] .task-circle'), e=>e.dataset.stampedNumber)`);
  assert.deepEqual(await numbers('todo'), ['1', '2', '3', '4', '5']);
  assert.deepEqual(await numbers('doing'), ['1', '2']);
  assert.equal(await count('doing', 'course'), 0);
  // Exercise the actual dragstart/dragover/drop handlers, including category inheritance.
  await ev(`window.dragTask=(id,status)=>{const source=document.querySelector('[data-task="'+id+'"]'),target=document.querySelector('.column[data-status="'+status+'"]'),data=new DataTransfer();source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:data}));target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:data}));target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}));return true};true`);
  // A transfer where the ordinal must visibly change: doing #2 → empty done #1.
  await ev('dragTask("g","done")');
  assert.deepEqual(await numbers('doing'), ['1']);
  assert.deepEqual(await numbers('done'), ['1']);
  assert.equal(await ev('document.querySelector(".column[data-status=done] [data-task=g] .task-circle").dataset.stampedNumber'), '1');
  await ev('document.querySelector("#undo").click()');
  assert.deepEqual(await numbers('doing'), ['1', '2']);
  await ev('dragTask("c","doing")');
  assert.equal(await count('doing', 'course'), 1);
  assert.deepEqual(await numbers('todo'), ['1', '2', '3', '4']);
  assert.deepEqual(await numbers('doing'), ['1', '2', '3']);
  assert.equal(await ev('document.querySelector(".column[data-status=doing] .group[data-group=course] [data-task=c]")!==null'), true);
  await ev('dragTask("d","doing")');
  assert.equal(await count('doing', 'course'), 1, 'Moving a second task must reuse the subgroup');
  await ev('dragTask("c","done")');
  assert.equal(await count('done', 'course'), 1);
  assert.deepEqual(await numbers('doing'), ['1', '2', '3']);
  assert.deepEqual(await numbers('done'), ['1']);
  await ev('document.querySelector("#undo").click()');
  assert.equal(await count('done', 'course'), 0);
  assert.equal(await ev('!!document.querySelector(".column[data-status=doing] [data-task=c]")'), true);
  // Plus → immediate name entry → create subgroup → create a task within it.
  await ev(`document.querySelector('.column[data-status=todo] > .add-group').click()`);
  await ev(`const input=document.querySelector('[data-form=group] input');input.value='Личное';document.querySelector('[data-form=group]').requestSubmit();true`);
  const groupId = await ev(`Array.from(document.querySelectorAll('.column[data-status=todo] .group')).find(g=>g.querySelector('h3').textContent==='Личное').dataset.group`);
  await ev(`document.querySelector('.column[data-status=todo] .group[data-group="${groupId}"] .group-head .plus').click();document.querySelector('[data-form=task] input').value='Купить блокнот';document.querySelector('[data-form=task]').requestSubmit();true`);
  const newId = await ev(`document.querySelector('.group[data-group="${groupId}"] .task').dataset.task`);
  await ev(`dragTask(${JSON.stringify(newId)},"done")`);
  assert.equal(await count('done', groupId), 1);
  assert.equal(await ev(`document.querySelector('.column[data-status=done] .group[data-group="${groupId}"] .task-title').textContent`), 'Купить блокнот');
  // Persist across a reload of the prototype.
  await win.webContents.reload();
  await new Promise(r => win.webContents.once('did-finish-load', r));
  await ev('document.fonts.ready.then(()=>true)');
  assert.equal(await count('done', groupId), 1);
  // Menu move is an alternative to dragging, preserving the group as well.
  await ev(`document.querySelector('[data-task="${newId}"] .task-menu').click();Array.from(document.querySelectorAll('#menu button')).find(b=>b.textContent==='→ В процессе').click();true`);
  assert.equal(await count('doing', groupId), 1);
  // Restore the initial screen for a clean, shareable preview.
  await ev('document.querySelector("#reset").click();true');
  win.setContentSize(1440, 1120);
  await new Promise(r => setTimeout(r, 800));
  const image = await win.webContents.capturePage({ stayHidden: true, stayAwake: true });
  await fs.writeFile(path.join(root, macos ? 'mockups/task-subgroups-macos-blue.png' : 'mockups/task-subgroups.png'), image.toPNG());
  await ev(`document.querySelector('[data-task="c"] .task-menu').click();Array.from(document.querySelectorAll('#menu button')).find(b=>b.textContent==='→ В процессе').click();true`);
  await new Promise(r => setTimeout(r, 250));
  await fs.writeFile(path.join(root, macos ? 'mockups/task-subgroups-macos-blue-moved.png' : 'mockups/task-subgroups-moved.png'), (await win.webContents.capturePage({ stayHidden: true, stayAwake: true })).toPNG());
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('PASS: drag between all stages, automatic subgroup creation, reuse, undo, create group/task, reload persistence, move menu.');
  app.quit();
}).catch(e => { console.error(e); app.exit(1); });
