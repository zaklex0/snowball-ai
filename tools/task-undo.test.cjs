'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { Store } = require('../storage');
const { TaskUndoHistory, taskUndoRequest } = require('../task-undo');
async function setup(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-undo-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return new Store(dir).init(); }
function diff(before, after) { const old = new Map(before.map(t => [t.id, t])), current = new Map(after.map(t => [t.id, t])); return [...new Set([...old.keys(), ...current.keys()])].map(id => ({ id, before: old.get(id) || null, after: current.get(id) || null })).filter(c => JSON.stringify(c.before) !== JSON.stringify(c.after)); }
test('undo phrases distinguish history from task commands', () => {
  for (const s of ['отмени', 'отмени последнее действие', 'верни как было', 'откати действие']) assert.equal(taskUndoRequest(s), 1);
  assert.equal(taskUndoRequest('Отмени последние 2 действия'), 2);
  for (const s of ['перемести задачи 6-10', 'отмени задачу 2', 'верни задачу 1 в Предстоит']) assert.equal(taskUndoRequest(s), null);
});
test('history restores creation, nested category moves and deletion in reverse order', async t => {
  const s = await setup(t), h = new TaskUndoHistory(), group = await s.addTaskGroup('YouTube Reels');
  const parent = await s.saveTask({ title: 'Родитель' }), child = await s.saveTask({ title: 'Ребёнок', note: 'Сохранить' }); await s.saveTask({ id: child.id, parentId: parent.id });
  const initial = structuredClone(s.tasksView());
  let before = structuredClone(s.tasks); await s.moveTasks([parent.id], { groupId: group.id }); h.record(diff(before, s.tasks), 'Перенос');
  before = structuredClone(s.tasks); await s.deleteTask(parent.id); h.record(diff(before, s.tasks), 'Удаление');
  await assert.rejects(h.undo(s, { id: 'u1' }), /undo order/); assert.equal(h.state().count, 2);
  await h.undo(s, { count: 2 }); assert.deepEqual(s.tasksView(), initial); assert.equal(h.state().count, 0);
  before = structuredClone(s.tasks); const made = await s.saveTask({ title: 'Новая' }); h.record(diff(before, s.tasks), 'Создание');
  await h.undo(s); assert.equal(s.findTask(made.id), null);
});
test('conflicts and disk errors keep the tasks and history untouched', async t => {
  const s = await setup(t), h = new TaskUndoHistory(), a = await s.saveTask({ title: 'Первая' });
  let before = structuredClone(s.tasks); await s.saveTask({ id: a.id, status: 'doing' }); h.record(diff(before, s.tasks), 'Перенос');
  await s.saveTask({ id: a.id, note: 'Новая ручная правка' });
  const edited = structuredClone(s.tasks); await assert.rejects(h.undo(s), /undo conflict/); assert.deepEqual(s.tasks, edited); assert.equal(h.state().count, 1);
  const h2 = new TaskUndoHistory(); before = structuredClone(s.tasks); await s.saveTask({ id: a.id, status: 'done' }); h2.record(diff(before, s.tasks), 'Готово');
  const current = structuredClone(s.tasks), rename = fs.rename;
  fs.rename = async (from, to) => { if (to === s.tasksPath) throw new Error('disk full'); return rename(from, to); };
  try { await assert.rejects(h2.undo(s), /disk full/); } finally { fs.rename = rename; }
  assert.deepEqual(s.tasks, current); assert.equal(h2.state().count, 1);
  await h2.undo(s); assert.deepEqual(s.tasks, before);
});
