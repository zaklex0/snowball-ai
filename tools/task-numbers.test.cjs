'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { Store } = require('../storage');
const { taskReferences, taskReferenceSelection, taskColumnReferences, taskTargetGroup, resolveTaskSelection } = require('../task-reference');
test('ranges, ordinal endings, lists and exact subgroup targets', () => {
  for (const text of ['Задачи с 6-й по 9-ю перемести', 'Перенеси задачи 6–9', 'задачи от 6 до 9']) assert.deepEqual(taskReferences(text), [6, 7, 8, 9]);
  assert.deepEqual(taskReferences('Задачи 6, 7 и 9 перенеси'), [6, 7, 9]);
  assert.ok(taskReferenceSelection('задачи с 9 по 6').error);
  assert.ok(taskReferenceSelection('задачи 1-501').error);
  const groups = [{ id: 'a', name: 'YouTube' }, { id: 'b', name: 'YouTube Reels' }, { id: 'c', name: 'Работа' }];
  assert.equal(taskTargetGroup('Задачи с 6-й по 9-ю перемести в подгруппу YouTube Reels', groups).groupId, 'b');
  const target = taskTargetGroup('Перемести задачи 1-2 в подгруппу «Работа» из Предстоит', groups);
  assert.equal(target.groupId, 'c'); assert.deepEqual(taskColumnReferences(target.text, columns), { source: 'todo', target: null });
  assert.ok(taskTargetGroup('Перемести задачи 1-2 в подгруппу Несуществующая', groups).error);
});
test('bulk moves freeze original numbers, preserve details, undo and reject partial selections', async t => {
  const s = await setup(t), g = await s.addTaskGroup('YouTube Reels');
  for (let i = 1; i <= 10; i++) await s.saveTask({ title: 'Задача ' + i, note: 'Заметка ' + i, subtasks: [{ title: 'Шаг' }] });
  await s.saveTask({ title: 'Другая', status: 'doing' });
  const original = structuredClone(s.tasksView()), ids = original.filter(t => [6,7,8,9].includes(t.number) && t.status === 'todo').map(t => t.id);
  assert.deepEqual(resolveTaskSelection([6,7,8,9], original, null).ids, ids);
  assert.ok(resolveTaskSelection([1], original, null).error);
  assert.ok(resolveTaskSelection([9,10,11], original, 'todo').error);
  const moved = await s.moveTasks(ids, { groupId: g.id });
  assert.deepEqual(s.tasks.filter(t => t.groupId === g.id).map(t => t.id), ids);
  for (const id of ids) { const task = s.findTask(id), prev = original.find(t => t.id === id); assert.equal(task.status, 'todo'); assert.equal(task.note, prev.note); assert.deepEqual(task.subtasks, prev.subtasks); }
  for (const before of moved.before.slice().reverse()) await s.putTask(before);
  assert.deepEqual(s.tasksView(), original);
  await assert.rejects(s.moveTasks([ids[0], 'missing'], { groupId: g.id }));
  assert.deepEqual(s.tasksView(), original);
  const rename = fs.rename;
  fs.rename = async (from, to) => { if (to === s.tasksPath) throw new Error('disk full'); return rename(from, to); };
  try { await assert.rejects(s.moveTasks(ids, { groupId: g.id }), /disk full/); } finally { fs.rename = rename; }
  assert.deepEqual(s.tasksView(), original);
});
async function setup(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-task-groups-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return new Store(dir).init(); }
const columns = [{ id: 'todo', name: 'Предстоит' }, { id: 'doing', name: 'В процессе' }, { id: 'done', name: 'Готово' }, { id: 'colReview', name: 'На проверке' }];
test('references distinguish source and destination and ignore dates', () => {
  for (const ref of ['задача 3', 'задачу № 3', 'задачу номер 3', 'задачи под номером 3', '№3', '#3']) assert.deepEqual(taskReferences('Перенеси ' + ref + ' на завтра в 15:30'), [3]);
  assert.deepEqual(taskReferences('задачу 1.2 из Предстоит'), ['1.2']);
  assert.deepEqual(taskReferences('Поставь встречу на 3 декабря в 15:00'), []);
  assert.deepEqual(taskReferences('добавь задачу 3D моделирование'), []);
  assert.deepEqual(taskColumnReferences('Перемести задачу 2 из «Предстоит» в «В процессе»', columns), { source: 'todo', target: 'doing' });
  assert.deepEqual(taskColumnReferences('Перемести задачу 1 из столбца «В процессе» в столбец «Готово»', columns), { source: 'doing', target: 'done' });
  assert.deepEqual(taskColumnReferences('Удали задачу 1 в столбце «В процессе»', columns), { source: 'doing', target: null });
  assert.equal(taskColumnReferences('Удали задачу 1 в процессе', columns).source, 'doing');
  assert.equal(taskColumnReferences('Перенеси задачу 1 в «В процессе»', columns).source, null);
  assert.equal(taskColumnReferences('Перенеси задачу 1 из На проверке в Предстоит', columns).source, 'colReview');
});
test('each column has gapless numbering; moves, deletion, undo and restart recalculate it', async t => {
  let s = await setup(t); const a = await s.saveTask({ title: 'Та же' }), b = await s.saveTask({ title: 'Та же' }), c = await s.saveTask({ title: 'Та же', status: 'doing' });
  assert.equal(s.taskNumber(a.id), 1); assert.equal(s.taskNumber(b.id), 2); assert.equal(s.taskNumber(c.id), 1);
  assert.equal(s.findTaskByNumber(1), null); assert.equal(s.findTaskByNumber(1, 'doing').id, c.id);
  await s.saveTask({ id: b.id, status: 'done' }); assert.equal(s.taskNumber(b.id), 1);
  await s.saveTask({ id: c.id, status: 'todo' }); assert.equal(s.taskNumber(c.id), 2);
  await s.deleteTask(a.id); assert.equal(s.taskNumber(c.id), 1);
  await s.putTask(a); assert.equal(s.taskNumber(c.id), 2);
  s = await new Store(s.dir).init(); assert.equal(s.taskNumber(c.id), 2); assert.equal(s.taskNumber(b.id), 1);
});
test('groups persist across moves and restart; numbers follow group order and nesting leaves no board gaps', async t => {
  const s = await setup(t), youtube = await s.addTaskGroup('YouTube'), course = await s.addTaskGroup('Курс');
  const c = await s.saveTask({ title: 'Курс', groupId: course.id }), a = await s.saveTask({ title: 'YouTube', groupId: youtube.id }), b = await s.saveTask({ title: 'YouTube часть 2', groupId: youtube.id });
  assert.equal(s.taskNumber(a.id), 1); assert.equal(s.taskNumber(b.id), 2); assert.equal(s.taskNumber(c.id), 3);
  await s.saveTask({ id: b.id, parentId: a.id }); assert.equal(s.taskNumber(b.id), '1.1'); assert.equal(s.taskNumber(c.id), 2);
  await s.saveTask({ id: c.id, status: 'doing' }); assert.equal(s.findTask(c.id).groupId, course.id); assert.equal(s.taskNumber(c.id), 1);
  await s.renameTaskGroup(course.id, 'Обучение', 'Курс');
  const r = await new Store(s.dir).init(); assert.deepEqual(r.groupsView(), [{ id: youtube.id, name: 'YouTube' }, { id: course.id, name: 'Обучение' }]);
  assert.equal(r.findTask(c.id).groupId, course.id); assert.equal((await r.addTaskGroup('youtube')).id, youtube.id);
});
test('archive numbers are separate from active done tasks', async t => {
  const s = await setup(t), a = await s.saveTask({ title: 'Готовая', status: 'done' }); await s.archiveDone([a.id]);
  const b = await s.saveTask({ title: 'Другая', status: 'done' });
  assert.equal(s.findTaskByNumber(1, 'done').id, b.id); assert.equal(s.findTaskByNumber(1, 'done', true).id, a.id);
  await s.unarchive([a.id]); assert.deepEqual(s.tasksView().map(t => t.number), [1, 2]);
});
test('moving an ungrouped parent into a category keeps nested tasks and their details with it', async t => {
  const s = await setup(t), g = await s.addTaskGroup('YouTube');
  const parent = await s.saveTask({ title: 'Проект' }), child = await s.saveTask({ title: 'Монтаж', note: 'Не потерять', subtasks: [{ title: 'Черновик', done: true }] });
  await s.saveTask({ id: child.id, parentId: parent.id });
  await s.saveTask({ id: parent.id, groupId: g.id });
  const moved = s.findTask(child.id);
  assert.equal(moved.parentId, parent.id); assert.equal(moved.groupId, g.id);
  assert.equal(moved.note, child.note); assert.deepEqual(moved.subtasks, child.subtasks);
  assert.equal(s.taskNumber(child.id), '1.1');
  assert.equal((await new Store(s.dir).init()).findTask(child.id).groupId, g.id);
  await s.putTask(parent);
  assert.equal(s.findTask(child.id).groupId, '', 'Undo restores the child category with its parent');
  assert.equal(s.findTask(child.id).note, child.note);
});
test('failed writes publish no partial task or group state', async t => {
  const s = await setup(t), a = await s.saveTask({ title: 'Сохранённая' }), before = await fs.readFile(s.tasksPath, 'utf8'), rename = fs.rename;
  fs.rename = async (from, to) => { if (to === s.tasksPath) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); return rename(from, to); };
  try { await assert.rejects(s.saveTask({ id: a.id, status: 'doing' }), /disk full/); await assert.rejects(s.addTaskGroup('Не записана'), /disk full/); } finally { fs.rename = rename; }
  assert.equal(await fs.readFile(s.tasksPath, 'utf8'), before); assert.deepEqual(s.groupsView(), []); assert.equal(s.findTask(a.id).status, 'todo');
});
test('backup and cloud transfer preserve group identity; legacy config does not erase groups', async t => {
  const source = await setup(t), target = await setup(t), remote = await setup(t), g = await source.addTaskGroup('YouTube'), task = await source.saveTask({ title: 'Из копии', groupId: g.id });
  await target.mergeFrom(source.dir, 'backup'); assert.deepEqual(target.groupsView(), [g]); assert.equal(target.findTask(task.id).groupId, g.id);
  const records = source.cloudRecords(); await remote.applyCloudRecord('config:tasks', records['config:tasks']); await remote.applyCloudRecord('task:' + task.id, records['task:' + task.id]);
  assert.deepEqual(remote.groupsView(), [g]); assert.equal(remote.findTask(task.id).groupId, g.id);
  await remote.applyCloudRecord('config:tasks', { columns: [], archiveMode: 'day' }); assert.deepEqual(remote.groupsView(), [g]);
  await remote.saveTask({ id: task.id, status: 'doing' }); assert.equal(remote.findTask(task.id).groupId, g.id); assert.equal(remote.taskNumber(task.id), 1);
});
