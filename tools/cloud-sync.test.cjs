'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../storage');
const { CloudSync, digest } = require('../cloud-sync');
const { CloudLocal, refs } = require('../cloud-local');
const { ScreenshotStore } = require('../screenshot-store');

function server() {
  const records = {}, files = new Map();
  return { records, files,
    list: async () => structuredClone(records),
    put: async (key, expected, payload) => {
      if ((records[key]?.version || 0) !== expected) return { ok: false, record: structuredClone(records[key]) };
      const record = { key, version: expected + 1, payload: structuredClone(payload) }; records[key] = record;
      return { ok: true, record: structuredClone(record) };
    },
    upload: async (hash, bytes) => { files.set(hash, bytes); }, download: async hash => files.get(hash)
  };
}
async function device(t, remote) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-cloud-'));
  t.after(() => fs.rm(dir, { force: true, recursive: true }));
  const store = await new Store(dir).init(), state = { base: {}, conflicts: {}, manifests: {} };
  const local = new CloudLocal(store, { remote }); local.manifests = state.manifests;
  const save = async () => fs.writeFile(path.join(dir, 'test-sync-state.json'), JSON.stringify(state));
  const engine = new CloudSync({ remote, local, state, save });
  return { dir, store, engine, local, state };
}

test('two devices exchange independent tasks and offline edits without replacing a board', async t => {
  const remote = server(), a = await device(t, remote), b = await device(t, remote);
  const one = await a.store.saveTask({ title: 'Компьютер' }); await a.engine.sync(); await b.engine.sync();
  assert.equal(b.store.findTask(one.id).title, 'Компьютер');
  const two = await b.store.saveTask({ title: 'Ноутбук' });
  await a.store.saveTask({ id: one.id, title: 'Правка без интернета' });
  await b.engine.sync(); await a.engine.sync(); await b.engine.sync();
  assert.equal(a.store.findTask(two.id).title, 'Ноутбук');
  assert.equal(b.store.findTask(one.id).title, 'Правка без интернета');
  assert.deepEqual(a.state.conflicts, {}); assert.deepEqual(b.state.conflicts, {});
});

test('groups, nested tasks, checklist and column numbers survive two-device sync and restart', async t => {
  const remote = server(), a = await device(t, remote), b = await device(t, remote);
  const youtube = await a.store.addTaskGroup('YouTube'), course = await a.store.addTaskGroup('Курс');
  const parent = await a.store.saveTask({ title: 'Снять ролик', groupId: youtube.id, note: 'Детали', subtasks: [{ id: 'check1', title: 'Камера', done: true }] });
  const child = await a.store.saveTask({ title: 'Монтаж', groupId: youtube.id });
  await a.store.saveTask({ id: child.id, parentId: parent.id });
  await a.store.saveTask({ title: 'Урок', groupId: course.id, status: 'doing' });
  await a.engine.sync(); await b.engine.sync();
  assert.deepEqual(b.store.groupsView(), a.store.groupsView());
  assert.deepEqual(b.store.tasksView(), a.store.tasksView());
  const restarted = await new Store(b.dir).init();
  assert.deepEqual(restarted.tasksView(), a.store.tasksView());
  assert.deepEqual(restarted.groupsView(), a.store.groupsView());
  await b.store.saveTask({ id: parent.id, status: 'doing' });
  await b.engine.sync(); await a.engine.sync();
  assert.equal(a.store.findTask(child.id).parentId, parent.id);
  assert.equal(a.store.findTask(child.id).status, 'doing');
  assert.deepEqual(a.store.tasksView(), b.store.tasksView());
  assert.deepEqual(a.state.conflicts, {}); assert.deepEqual(b.state.conflicts, {});
});

test('first connection merges independent group catalogs instead of leaving tasks without names', async t => {
  const remote = server(), a = await device(t, remote), b = await device(t, remote);
  const ga = await a.store.addTaskGroup('Работа'), gb = await b.store.addTaskGroup('Курс');
  const ta = await a.store.saveTask({ title: 'Рабочая задача', groupId: ga.id });
  const tb = await b.store.saveTask({ title: 'Урок', groupId: gb.id });
  await a.engine.sync(); await b.engine.sync(); await a.engine.sync();
  assert.deepEqual(a.store.groupsView(), b.store.groupsView());
  for (const d of [a, b]) {
    assert.deepEqual(new Set(d.store.groupsView().map(g => g.id)), new Set([ga.id, gb.id]));
    assert.equal(d.store.findTask(ta.id).groupId, ga.id);
    assert.equal(d.store.findTask(tb.id).groupId, gb.id);
    assert.deepEqual(d.state.conflicts, {});
  }
});

test('offline group additions and independent renames merge with the saved common version', async t => {
  const remote = server(), a = await device(t, remote), b = await device(t, remote);
  const ga = await a.store.addTaskGroup('Работа'), gb = await a.store.addTaskGroup('Курс');
  await a.engine.sync(); await b.engine.sync();
  await a.store.renameTaskGroup(ga.id, 'Проекты', ga.name);
  await b.store.renameTaskGroup(gb.id, 'Обучение', gb.name);
  await a.store.addTaskGroup('YouTube'); await b.store.addTaskGroup('Личное');
  await a.engine.sync(); await b.engine.sync(); await a.engine.sync();
  assert.deepEqual(a.store.groupsView(), b.store.groupsView());
  assert.deepEqual(new Set(a.store.groupsView().map(g => g.name)), new Set(['Проекты', 'Обучение', 'YouTube', 'Личное']));
  assert.deepEqual(a.state.conflicts, {}); assert.deepEqual(b.state.conflicts, {});
});

test('legacy config hashes and existing compatible conflicts recover group names after an upgrade', async t => {
  const remote = server(), a = await device(t, remote), b = await device(t, remote);
  // Old apps stored config without the groups field; their checkpoints contain only a hash.
  const legacy = { value: { columns: [], archiveMode: 'manual' }, assets: [] };
  const first = await remote.put('config:tasks', 0, legacy);
  await a.engine.sync(); await b.engine.sync();
  b.state.base['config:tasks'] = { version: first.record.version, hash: digest(legacy) };
  const group = await a.store.addTaskGroup('YouTube');
  const task = await a.store.saveTask({ title: 'Видео', groupId: group.id });
  await a.engine.sync();
  b.state.conflicts['config:tasks'] = { local: (await b.local.snapshot())['config:tasks'], remote: remote.records['config:tasks'].payload, version: remote.records['config:tasks'].version };
  await b.engine.sync(); await a.engine.sync();
  assert.deepEqual(b.store.groupsView(), [group]);
  assert.equal(b.store.findTask(task.id).groupId, group.id);
  assert.deepEqual(b.state.conflicts, {});
  assert.deepEqual((await new Store(b.dir).init()).groupsView(), [group]);
});

test('a simultaneous rename of the same group still preserves both versions for manual choice', async t => {
  const remote = server(), a = await device(t, remote), b = await device(t, remote);
  const group = await a.store.addTaskGroup('Работа'); await a.engine.sync(); await b.engine.sync();
  await a.store.renameTaskGroup(group.id, 'Проекты', group.name);
  await b.store.renameTaskGroup(group.id, 'Клиенты', group.name);
  await a.engine.sync(); await b.engine.sync();
  assert.equal(b.state.conflicts['config:tasks'].local.value.groups[0].name, 'Клиенты');
  assert.equal(b.state.conflicts['config:tasks'].remote.value.groups[0].name, 'Проекты');
  await b.engine.resolve('config:tasks', 'remote');
  assert.deepEqual(b.store.groupsView(), a.store.groupsView());
});

test('an interrupted download installs board settings before tasks and retries after restart', async t => {
  const remote = server(), a = await device(t, remote), b = await device(t, remote);
  const column = await a.store.addColumn('Проверить'), group = await a.store.addTaskGroup('Работа');
  const task = await a.store.saveTask({ title: 'Проверка', status: column.id, groupId: group.id });
  await a.engine.sync();
  const apply = b.local.apply.bind(b.local), applied = [];
  b.local.apply = async (key, ...args) => {
    applied.push(key);
    if (key === 'task:' + task.id) throw Error('connection interrupted');
    return apply(key, ...args);
  };
  await assert.rejects(b.engine.sync(), /connection interrupted/);
  assert.equal(applied[0], 'config:tasks');
  const store = await new Store(b.dir).init();
  const state = JSON.parse(await fs.readFile(path.join(b.dir, 'test-sync-state.json')));
  const local = new CloudLocal(store, { remote }); local.manifests = state.manifests;
  const restarted = new CloudSync({ remote, local, state, save: async () => {} });
  await restarted.sync();
  assert.equal(store.findTask(task.id).status, column.id);
  assert.deepEqual(store.groupsView(), [group]);
  assert.deepEqual((await new Store(b.dir).init()).tasksView(), a.store.tasksView());
});

test('a network failure during a group merge retries without losing either catalog or resending forever', async t => {
  const remote = server(), a = await device(t, remote), b = await device(t, remote);
  const ga = await a.store.addTaskGroup('Работа'), gb = await b.store.addTaskGroup('Курс');
  await a.engine.sync();
  const put = remote.put; remote.put = async () => { throw Error('offline'); };
  await assert.rejects(b.engine.sync(), /offline/);
  assert.deepEqual(new Set(b.store.groupsView().map(g => g.id)), new Set([ga.id, gb.id]));
  remote.put = put;
  await b.engine.sync(); await a.engine.sync();
  const version = remote.records['config:tasks'].version;
  await b.engine.sync(); await a.engine.sync();
  assert.equal(remote.records['config:tasks'].version, version);
  assert.deepEqual(a.store.groupsView(), b.store.groupsView());
  assert.deepEqual(a.state.conflicts, {}); assert.deepEqual(b.state.conflicts, {});
});

test('a local group edit during merging is not overwritten', async t => {
  const remote = server(), a = await device(t, remote), b = await device(t, remote);
  await a.store.addTaskGroup('Работа'); const course = await b.store.addTaskGroup('Курс');
  await a.engine.sync();
  const download = b.local.download.bind(b.local);
  b.local.download = async (...args) => {
    await b.store.renameTaskGroup(course.id, 'Обучение', course.name);
    b.local.download = download;
    return download(...args);
  };
  await b.engine.sync();
  assert.deepEqual(b.store.groupsView(), [{ id: course.id, name: 'Обучение' }]);
  assert.equal(b.state.base['config:tasks'], undefined);
  await b.engine.sync(); await a.engine.sync();
  assert.deepEqual(a.store.groupsView(), b.store.groupsView());
  assert.deepEqual(new Set(a.store.groupsView().map(g => g.name)), new Set(['Работа', 'Обучение']));
});

test('a newer server version during merging is preserved and the next pass includes all groups', async t => {
  const remote = server(), a = await device(t, remote), b = await device(t, remote);
  await a.store.addTaskGroup('Работа'); await b.store.addTaskGroup('Курс');
  await a.engine.sync();
  const put = remote.put;
  remote.put = async (key, expected, payload) => {
    remote.put = put;
    const newer = structuredClone(remote.records[key].payload);
    newer.value.groups.push({ id: 'thirdGroup', name: 'Личное' });
    await put(key, expected, newer);
    return put(key, expected, payload);
  };
  await b.engine.sync();
  assert.ok(b.state.conflicts['config:tasks']);
  assert.ok(remote.records['config:tasks'].payload.value.groups.some(g => g.id === 'thirdGroup'));
  await b.engine.sync(); await a.engine.sync();
  assert.deepEqual(new Set(a.store.groupsView().map(g => g.name)), new Set(['Работа', 'Курс', 'Личное']));
  assert.deepEqual(a.store.groupsView(), b.store.groupsView());
  assert.deepEqual(b.state.conflicts, {});
});

test('concurrent edits preserve both versions, persist across restart and can be resolved', async t => {
  const remote = server(), a = await device(t, remote), b = await device(t, remote);
  const task = await a.store.saveTask({ title: 'Исходная' }); await a.engine.sync(); await b.engine.sync();
  await a.store.saveTask({ id: task.id, title: 'С компьютера' });
  await b.store.saveTask({ id: task.id, title: 'С ноутбука' });
  await a.engine.sync(); await b.engine.sync();
  const key = 'task:' + task.id;
  assert.equal(b.state.conflicts[key].local.value.title, 'С ноутбука');
  assert.equal(b.state.conflicts[key].remote.value.title, 'С компьютера');
  const state = JSON.parse(await fs.readFile(path.join(b.dir, 'test-sync-state.json')));
  const restarted = new CloudSync({ remote, local: b.local, state, save: async () => {} });
  await restarted.resolve(key, 'remote');
  assert.equal(b.store.findTask(task.id).title, 'С компьютера');
  const recovery = await fs.readdir(path.join(b.dir, '.cloud-sync', 'recovery'));
  assert.ok(recovery.length > 0);
});

test('deletions propagate, but an offline edit against a deletion becomes a conflict', async t => {
  const remote = server(), a = await device(t, remote), b = await device(t, remote);
  const task = await a.store.saveTask({ title: 'Удалить' }); await a.engine.sync(); await b.engine.sync();
  await a.store.deleteTask(task.id); await a.engine.sync(); await b.engine.sync();
  assert.equal(b.store.findTask(task.id), null);
  const edited = await a.store.saveTask({ title: 'Конфликт удаления' }); await a.engine.sync(); await b.engine.sync();
  await a.store.deleteTask(edited.id); await b.store.saveTask({ id: edited.id, title: 'Важная правка' });
  await a.engine.sync(); await b.engine.sync();
  assert.equal(b.store.findTask(edited.id).title, 'Важная правка');
  assert.equal(b.state.conflicts['task:' + edited.id].remote, null);
  await b.engine.resolve('task:' + edited.id, 'local'); await a.engine.sync();
  assert.equal(a.store.findTask(edited.id).title, 'Важная правка');
});

test('transcriptions transfer text, timings, cover and summary, never the source path or video bytes', async t => {
  const remote = server(), a = await device(t, remote), b = await device(t, remote);
  const transcript = await a.store.saveTranscript({ id: 'tr1', name: 'Видео 400 МБ', source: 'C:\\private\\movie.mp4', kind: 'video', size: 400000000,
    text: 'Текст записи', cues: [{ start: 2, end: 5, text: 'Текст записи' }], poster: 'data:image/jpeg;base64,YWJj', summary: { brief: 'Смысл', points: ['Пункт'] } });
  await a.engine.sync(); await b.engine.sync();
  const cloud = remote.records['transcript:' + transcript.id];
  assert.equal(cloud.payload.value.source, ''); assert.equal(cloud.payload.assets.length, 0); assert.equal(remote.files.size, 0);
  const result = b.store.getTranscript(transcript.id);
  assert.equal(result.source, ''); assert.equal(result.poster, transcript.poster); assert.deepEqual(result.cues, transcript.cues); assert.deepEqual(result.summary, transcript.summary);
  await b.store.saveTranscript({ id: result.id, text: 'Правка на ноутбуке' }); await b.engine.sync(); await a.engine.sync();
  assert.equal(a.store.getTranscript(result.id).source, 'C:\\private\\movie.mp4');
  assert.equal(a.store.getTranscript(result.id).text, 'Правка на ноутбуке');
});

test('small attachments, calendar and chats round-trip; a large attachment stays local after restart', async t => {
  const remote = server(), a = await device(t, remote), b = await device(t, remote);
  await a.store.run(() => a.store.applyCloudRecord('prompt:p1', { id: 'p1', title: 'Промт', text: 'Текст', type: 'static', files: [{ id: 'f1', name: 'tiny.txt', stored: 'tiny.txt', size: 4 }, { id: 'f2', name: 'large.mp4', stored: 'large.mp4', size: 22000000 }] }));
  await fs.mkdir(a.store.promptDir('p1'), { recursive: true });
  await fs.writeFile(path.join(a.store.promptDir('p1'), 'tiny.txt'), 'data');
  const large = await fs.open(path.join(a.store.promptDir('p1'), 'large.mp4'), 'w'); await large.truncate(22000000); await large.close();
  const event = await a.store.saveEvent({ date: '2026-11-11', title: 'Встреча', from: '14:00' });
  const chat = await a.store.saveChat({ id: 'chat1', title: 'Обсуждение', messages: [{ role: 'user', text: 'Привет' }], expectedUpdatedAt: null });
  await a.engine.sync(); await b.engine.sync();
  assert.equal(await fs.readFile(path.join(b.store.promptDir('p1'), 'tiny.txt'), 'utf8'), 'data');
  assert.equal(b.store.findEvent(event.id).title, 'Встреча'); assert.equal(b.store.getChat(chat.id).title, 'Обсуждение');
  await assert.rejects(fs.stat(path.join(b.store.promptDir('p1'), 'large.mp4')), { code: 'ENOENT' });
  const restarted = new CloudLocal(await new Store(b.dir).init(), { remote }); restarted.manifests = b.state.manifests;
  const snapshot = await restarted.snapshot();
  assert.equal(digest(snapshot['prompt:p1']), b.state.base['prompt:p1'].hash);
});

test('screenshots keep original and annotations and deletion is reflected on the other device', async t => {
  const remote = server(), a = await device(t, remote), b = await device(t, remote);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF1sAAAAASUVORK5CYII=', 'base64');
  const shots = new ScreenshotStore(a.dir), shot = await shots.add(png, '');
  await a.engine.sync(); await b.engine.sync();
  const copy = new ScreenshotStore(b.dir); assert.equal((await copy.list()).length, 1);
  const ops = [{ number: 8, hidden: true, type: 'pen', color: '#123456', width: 5, pressure: 35, points: [{ x: .5, y: .5 }] }];
  await copy.save(shot.id, { revision: (await copy.read(shot.id)).revision, blur: 3, ops, nextLayerNumber: 10 });
  await b.engine.sync(); await a.engine.sync();
  assert.equal((await shots.read(shot.id)).blur, 3);
  assert.deepEqual((await shots.read(shot.id)).ops, ops);
  assert.equal((await shots.read(shot.id)).nextLayerNumber, 10);
  await shots.remove(shot.id, p => fs.rm(p, { recursive: true, force: true }));
  await a.engine.sync(); await b.engine.sync(); assert.equal((await copy.list()).length, 0);
});

test('a local edit during download is not overwritten or acknowledged', async t => {
  const remote = server(), a = await device(t, remote), b = await device(t, remote);
  const task = await a.store.saveTask({ title: 'Один' }); await a.engine.sync(); await b.engine.sync();
  await a.store.saveTask({ id: task.id, title: 'Два' }); await a.engine.sync();
  const oldBase = b.state.base['task:' + task.id];
  b.local.download = async () => { await b.store.saveTask({ id: task.id, title: 'Пока скачивалось' }); return []; };
  await b.engine.sync(); assert.equal(b.store.findTask(task.id).title, 'Пока скачивалось');
  assert.deepEqual(b.state.base['task:' + task.id], oldBase);
  await b.engine.sync(); assert.ok(b.state.conflicts['task:' + task.id]);
});

test('disk failure does not publish or acknowledge a remote change', async t => {
  const remote = server(), a = await device(t, remote), b = await device(t, remote);
  const task = await a.store.saveTask({ title: 'Запись' }); await a.engine.sync();
  const apply = b.store.applyCloudRecord; b.store.applyCloudRecord = async () => { throw Error('disk failure'); };
  await assert.rejects(b.engine.sync(), /disk failure/);
  assert.equal(b.store.findTask(task.id), null); assert.equal(b.state.base['task:' + task.id], undefined);
  b.store.applyCloudRecord = apply; await b.engine.sync(); assert.equal(b.store.findTask(task.id).title, 'Запись');
});

test('cloud attachment paths cannot escape the selected record or data folder', async t => {
  assert.throws(() => refs('prompt:p1', { files: [{ stored: '..\\secret.txt' }] }));
  assert.throws(() => refs('prompt:..', { files: [] }));
  const a = await device(t, server());
  await assert.rejects(a.local.download('prompt:p1', { value: { files: [{ stored: 'ok.txt' }] }, assets: [{ path: '../secret.txt', hash: 'a'.repeat(64), size: 1 }] }), /путь/);
});

test('unchanged cloud versions do not redownload text or erase an offline edit', async t => {
  const remote = server(), originalList = remote.list;
  remote.list = async (base = {}) => {
    const rows = await originalList();
    for (const row of Object.values(rows)) if (base[row.key]?.version === row.version) delete row.payload;
    return rows;
  };
  const a = await device(t, remote), b = await device(t, remote);
  const task = await a.store.saveTask({ title: 'Исходная' }); await a.engine.sync(); await b.engine.sync();
  const key = 'task:' + task.id;
  assert.equal((await remote.list(b.state.base))[key].payload, undefined);
  await b.store.saveTask({ id: task.id, title: 'Правка без интернета' });
  await b.engine.sync(); await a.engine.sync();
  assert.equal(a.store.findTask(task.id).title, 'Правка без интернета');
  assert.deepEqual(b.state.conflicts, {});
});

test('a failed new screenshot write rolls back only its new original and can retry', async t => {
  const remote = server(), a = await device(t, remote), b = await device(t, remote);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF1sAAAAASUVORK5CYII=', 'base64');
  const shot = await new ScreenshotStore(a.dir).add(png, ''); await a.engine.sync();
  const rename = fs.rename;
  fs.rename = async (from, to) => { if (to === path.join(b.dir, 'Снимки', shot.id, 'meta.json')) throw Object.assign(Error('disk failure'), { code: 'ENOSPC' }); return rename(from, to); };
  try { await assert.rejects(b.engine.sync(), /disk failure/); } finally { fs.rename = rename; }
  assert.equal((await new ScreenshotStore(b.dir).listDetails()).broken, 0);
  await b.engine.sync(); assert.equal((await new ScreenshotStore(b.dir).list()).length, 1);
});
