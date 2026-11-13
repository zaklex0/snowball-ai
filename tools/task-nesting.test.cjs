'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../storage');

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-nesting-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return new Store(dir).init();
}

test('nesting preserves task details, survives restart and cloud transfer, and can be reversed', async t => {
  const store = await setup(t), other = await setup(t);
  const parent = await store.saveTask({ title: 'Фильм' });
  const child = await store.saveTask({ title: 'Монтаж', note: 'Не потерять заметку', status: 'doing', due: '2026-12-01', time: '14:00', priority: 2, tags: ['Монтаж'], subtasks: [{ title: 'Собрать черновик', done: true }] });
  await store.saveTask({ id: child.id, parentId: parent.id, expectedFields: { parentId: JSON.stringify('') } });
  const nested = store.findTask(child.id);
  const { parentId, updatedAt, ...rest } = nested;
  const { parentId: oldParent, updatedAt: oldTime, ...original } = child;
  assert.equal(parentId, parent.id);
  assert.deepEqual(rest, original);
  const restarted = await new Store(store.dir).init();
  assert.equal(restarted.findTask(child.id).parentId, parent.id);
  for (const id of [child.id, parent.id]) await other.applyCloudRecord('task:' + id, store.cloudRecords()['task:' + id]);
  assert.deepEqual(other.findTask(child.id), nested);
  await restarted.saveTask({ id: child.id, parentId: '' });
  assert.equal(restarted.findTask(child.id).parentId, '');
  assert.deepEqual(restarted.findTask(child.id).subtasks, child.subtasks);
});

test('nesting rejects cycles, deleted parents and stale moves from another window', async t => {
  const store = await setup(t);
  const a = await store.saveTask({ title: 'A' }), b = await store.saveTask({ title: 'B' }), c = await store.saveTask({ title: 'C' });
  await store.saveTask({ id: b.id, parentId: a.id });
  await store.saveTask({ id: c.id, parentId: b.id });
  await assert.rejects(store.saveTask({ id: a.id, parentId: c.id }), /task cycle/);
  await assert.rejects(store.saveTask({ id: a.id, parentId: a.id }), /task cycle/);
  await assert.rejects(store.saveTask({ id: c.id, parentId: a.id, expectedFields: { parentId: JSON.stringify('') } }), /task changed/);
  await store.deleteTask(a.id);
  await assert.rejects(store.saveTask({ id: c.id, parentId: a.id }), /bad parent/);
  assert.equal(store.findTask(b.id).title, 'B');
  assert.equal(store.findTask(c.id).parentId, b.id);
});

test('a failed write leaves nesting unchanged in memory and on disk', async t => {
  const store = await setup(t);
  const parent = await store.saveTask({ title: 'Parent' }), child = await store.saveTask({ title: 'Child' });
  const before = await fs.readFile(store.tasksPath, 'utf8');
  const rename = fs.rename;
  fs.rename = async (from, to) => {
    if (to === store.tasksPath) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    return rename(from, to);
  };
  try { await assert.rejects(store.saveTask({ id: child.id, parentId: parent.id })); }
  finally { fs.rename = rename; }
  assert.equal(store.findTask(child.id).parentId, '');
  assert.equal(await fs.readFile(store.tasksPath, 'utf8'), before);
});
