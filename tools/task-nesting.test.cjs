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

for (const method of ['saveTask', 'moveTasks']) {
  test(method + ': returning to doing restarts the timeline for the task and its nested tree', async t => {
    const store = await setup(t);
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const parent = await store.saveTask({ title: 'Parent' });
    const child = await store.saveTask({ title: 'Child', parentId: '' });
    const grandchild = await store.saveTask({ title: 'Grandchild' });
    await store.saveTask({ id: child.id, parentId: parent.id });
    await store.saveTask({ id: grandchild.id, parentId: child.id });
    const waiting = await store.addColumn('Отложено');
    const move = status => method === 'saveTask' ? store.saveTask({ id: parent.id, status }) : store.moveTasks([parent.id], { status });
    const ids = [parent.id, child.id, grandchild.id];
    for (const source of ['todo', waiting.id, 'done', 'todo']) {
      now += 60e3;
      await move(source);
      const before = structuredClone(store.tasks);
      now += 60e3;
      await move('doing');
      for (const id of ids) assert.equal(store.findTask(id).startedAt, now);
      const startedAt = now;
      now += 60e3;
      await store.saveTask({ id: parent.id, note: 'An edit must not restart work' });
      await move('doing');
      for (const id of ids) assert.equal(store.findTask(id).startedAt, startedAt);
      const restarted = await new Store(store.dir).init();
      for (const id of ids) assert.equal(restarted.findTask(id).startedAt, startedAt);
      const after = structuredClone(store.tasks);
      await store.restoreTaskChanges([before.map(task => ({ id: task.id, before: task, after: after.find(x => x.id === task.id) }))]);
      for (const task of before) assert.deepEqual(store.findTask(task.id), task);
      await move('doing');
    }
  });

  test(method + ': moving a parent moves its nested tree without exposing old-column cards', async t => {
    const store = await setup(t);
    const parent = await store.saveTask({ title: 'Parent' });
    let child = await store.saveTask({ title: 'Child', note: 'Keep details', subtasks: [{ title: 'Step' }] });
    let grandchild = await store.saveTask({ title: 'Grandchild' });
    let completed = await store.saveTask({ title: 'Completed', status: 'done' });
    child = await store.saveTask({ id: child.id, parentId: parent.id });
    grandchild = await store.saveTask({ id: grandchild.id, parentId: child.id });
    completed = await store.saveTask({ id: completed.id, parentId: parent.id });
    const before = structuredClone(store.tasks);
    const move = status => method === 'saveTask' ? store.saveTask({ id: parent.id, status }) : store.moveTasks([parent.id], { status });
    await move('doing');
    for (const id of [parent.id, child.id, grandchild.id]) {
      assert.equal(store.findTask(id).status, 'doing');
      assert.ok(store.findTask(id).startedAt);
    }
    assert.equal(store.findTask(child.id).parentId, parent.id);
    assert.equal(store.findTask(grandchild.id).parentId, child.id);
    assert.equal(store.findTask(child.id).note, child.note);
    assert.deepEqual(store.findTask(child.id).subtasks, child.subtasks);
    assert.deepEqual(store.findTask(completed.id), completed);
    assert.equal(store.tasks.some(task => task.status === 'todo'), false);
    const restarted = await new Store(store.dir).init();
    assert.equal(restarted.findTask(grandchild.id).status, 'doing');
    const after = structuredClone(store.tasks);
    await store.restoreTaskChanges([before.filter(task => JSON.stringify(task) !== JSON.stringify(after.find(x => x.id === task.id)))
      .map(task => ({ id: task.id, before: task, after: after.find(x => x.id === task.id) }))]);
    for (const task of before) assert.deepEqual(store.findTask(task.id), task);
    await move('doing');
    await move('done');
    for (const id of [parent.id, child.id, grandchild.id]) {
      assert.equal(store.findTask(id).status, 'done');
      assert.equal(store.findTask(id).doneFrom, 'doing');
      assert.ok(store.findTask(id).doneAt);
    }
    await move('todo');
    for (const id of [parent.id, child.id, grandchild.id]) {
      assert.equal(store.findTask(id).status, 'todo');
      assert.equal(store.findTask(id).doneAt, 0);
    }
  });
}

test('restoring a saved parent preserves start times instead of restarting nested tasks', async t => {
  const store = await setup(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const parent = await store.saveTask({ title: 'Parent' });
  const child = await store.saveTask({ title: 'Child' });
  await store.saveTask({ id: child.id, parentId: parent.id });
  now += 60e3;
  const working = await store.saveTask({ id: parent.id, status: 'doing' });
  const startedAt = now;
  now += 60e3;
  await store.saveTask({ id: parent.id, status: 'todo' });
  now += 60e3;
  await store.putTask(working);
  assert.deepEqual(store.findTask(parent.id), working);
  assert.equal(store.findTask(child.id).status, 'doing');
  assert.equal(store.findTask(child.id).startedAt, startedAt);
});

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
