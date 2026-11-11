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
  await copy.save(shot.id, { revision: (await copy.read(shot.id)).revision, blur: 3, ops: [] });
  await b.engine.sync(); await a.engine.sync();
  assert.equal((await shots.read(shot.id)).blur, 3);
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
