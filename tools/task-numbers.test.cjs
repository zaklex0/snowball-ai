'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { Store } = require('../storage');
const { taskReferences, taskColumnReferences } = require('../task-reference');
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
