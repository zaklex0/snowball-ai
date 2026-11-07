'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Store, copyDataTo } = require('../storage');
const { writeZip, extractZip } = require('../archive');

async function legacyProfile(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-profile-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'profile.json'), JSON.stringify({ name: 'Старый ник', welcomed: true, avatarAt: 123 }));
  await fs.writeFile(path.join(dir, 'avatar.png'), 'Старая картинка');
  const trashed = [];
  const store = await new Store(dir, { trash: async (p) => { trashed.push(p); await fs.unlink(p); } }).init();
  return { dir, store, trashed };
}

test('failed profile saves leave the old name and avatar intact', async (t) => {
  const { dir, store, trashed } = await legacyProfile(t);
  const before = store.profileView(), old = await fs.readFile(store.profilePath, 'utf8');
  const rename = fs.rename;
  fs.rename = async (from, to) => {
    if (to === store.profilePath) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    return rename(from, to);
  };
  t.after(() => { fs.rename = rename; });
  await assert.rejects(store.saveProfile({ name: 'Новый ник', avatar: Buffer.from('Новая картинка') }), { code: 'ENOSPC' });
  await assert.rejects(store.saveProfile({ name: 'Новый ник', avatar: null }), { code: 'ENOSPC' });
  assert.deepEqual(store.profileView(), before);
  assert.equal(await fs.readFile(store.profilePath, 'utf8'), old);
  assert.equal(await fs.readFile(path.join(dir, 'avatar.png'), 'utf8'), 'Старая картинка');
  assert.deepEqual(trashed, []);
  assert.deepEqual((await fs.readdir(dir)).filter((name) => /^avatar-/.test(name)), []);
  fs.rename = rename;
  const result = await store.saveProfile({ name: 'Новый ник', avatar: Buffer.from('Новая картинка') });
  assert.equal(result.backupUpdated, true);
  assert.equal(store.profileView().name, 'Новый ник');
  assert.equal(await fs.readFile(store.profileAvatarPath(store.profile), 'utf8'), 'Новая картинка');
  assert.deepEqual(trashed, [path.join(dir, 'avatar.png')]);
});

test('profile changes appear to other readers only after saving completes', async (t) => {
  const { store } = await legacyProfile(t);
  const previous = store.profileView();
  const rename = fs.rename;
  let entered, release;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  fs.rename = async (from, to) => { if (to === store.profilePath) { entered(); await gate; } return rename(from, to); };
  t.after(() => { fs.rename = rename; });
  const saving = store.saveProfile({ name: 'Новый ник', avatar: Buffer.from('Новая картинка') });
  await started;
  assert.deepEqual(store.profileView(), previous);
  release();
  await saving;
  assert.equal(store.profileView().name, 'Новый ник');
  assert.notEqual(store.profileView().avatar, previous.avatar);
  fs.rename = rename;
});

test('conflicting profile changes are rejected without blocking independent fields', async (t) => {
  const { store } = await legacyProfile(t);
  const old = store.profileView();
  await store.saveProfile({ name: 'Из другого окна' });
  await assert.rejects(store.saveProfile({ name: 'Старая правка', expected: { name: old.name } }), /profile changed/);
  await store.saveProfile({ avatar: Buffer.from('Другая картинка'), expected: { avatar: old.avatarVersion } });
  assert.equal(store.profileView().name, 'Из другого окна');
  await assert.rejects(store.saveProfile({ avatar: null, expected: { avatar: old.avatarVersion } }), /profile changed/);
  assert.ok(store.profileView().avatar);
});

test('old avatar survives a failed backup update and can be recovered', async (t) => {
  const { dir, store } = await legacyProfile(t);
  const backup = path.join(dir, 'profile.backup.json');
  const rename = fs.rename, log = console.error;
  fs.rename = async (from, to) => { if (to === backup) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); return rename(from, to); };
  console.error = () => {};
  t.after(() => { fs.rename = rename; console.error = log; });
  const result = await store.saveProfile({ name: 'Новый ник', avatar: Buffer.from('Новая картинка') });
  assert.equal(result.backupUpdated, false);
  assert.equal(result.oldAvatarLeft, true);
  assert.equal(await fs.readFile(path.join(dir, 'avatar.png'), 'utf8'), 'Старая картинка');
  fs.rename = rename; console.error = log;
  await fs.writeFile(store.profilePath, '{broken');
  const restored = await new Store(dir).init();
  assert.equal(restored.profileView().name, 'Старый ник');
  assert.ok(restored.profileView().avatar);
  assert.equal(await fs.readFile(restored.profileAvatarPath(restored.profile), 'utf8'), 'Старая картинка');
  assert.equal(restored.dataWarnings.find((w) => w.file === 'profile.json').restored, true);
});

test('moving a profile preserves both the active avatar and an older backup avatar', async (t) => {
  const { dir, store } = await legacyProfile(t);
  const rename = fs.rename, log = console.error;
  fs.rename = async (from, to) => { if (to === path.join(dir, 'profile.backup.json')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); return rename(from, to); };
  console.error = () => {};
  t.after(() => { fs.rename = rename; console.error = log; });
  await store.saveProfile({ name: 'Новый ник', avatar: Buffer.from('Новая картинка') });
  fs.rename = rename; console.error = log;
  const destination = path.join(dir, 'moved-with-backup');
  await copyDataTo(dir, destination);
  const moved = await new Store(destination).init();
  assert.equal(await fs.readFile(moved.profileAvatarPath(moved.profile), 'utf8'), 'Новая картинка');
  await fs.writeFile(moved.profilePath, '{broken');
  const restored = await new Store(destination).init();
  assert.equal(restored.profileView().name, 'Старый ник');
  assert.equal(await fs.readFile(restored.profileAvatarPath(restored.profile), 'utf8'), 'Старая картинка');
});

test('an avatar is retained if the recycle bin fails', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-profile-trash-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = await new Store(dir, { trash: async () => { throw new Error('unavailable'); } }).init();
  await store.saveProfile({ name: 'Тест', avatar: Buffer.from('Картинка') });
  const oldFile = store.profileAvatarPath(store.profile);
  const result = await store.saveProfile({ avatar: null });
  assert.equal(result.oldAvatarLeft, true);
  assert.equal(store.profileView().avatar, null);
  assert.equal(await fs.readFile(oldFile, 'utf8'), 'Картинка');
});

test('profile avatar survives backup, restore, and a move to a new folder', async (t) => {
  const { dir, store } = await legacyProfile(t);
  await store.saveProfile({ name: 'Новый ник', avatar: Buffer.from('Новая картинка') });
  const pack = store.packEntries('backup'), archive = path.join(dir, 'backup.snowball');
  await writeZip(archive, pack.entries);
  const unpacked = path.join(dir, 'unpacked'); await extractZip(archive, unpacked);
  assert.equal(await fs.readFile(path.join(unpacked, 'avatar.png'), 'utf8'), 'Новая картинка');
  const restoredDir = path.join(dir, 'restored'); await fs.mkdir(restoredDir);
  const restored = await new Store(restoredDir).init();
  assert.equal((await restored.mergeFrom(unpacked, 'backup')).profile, true);
  assert.equal(restored.profileView().name, 'Новый ник');
  assert.equal(await fs.readFile(restored.profileAvatarPath(restored.profile), 'utf8'), 'Новая картинка');
  const destination = path.join(dir, 'moved');
  await copyDataTo(dir, destination);
  const moved = await new Store(destination).init();
  assert.equal(moved.profileView().name, 'Новый ник');
  assert.equal(await fs.readFile(moved.profileAvatarPath(moved.profile), 'utf8'), 'Новая картинка');
});

test('failed profile restore and a destination avatar collision preserve both original files', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-profile-restore-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'backup'), dest = path.join(dir, 'data');
  await fs.mkdir(source); await fs.mkdir(dest);
  await fs.writeFile(path.join(source, 'prompts.json'), JSON.stringify({ prompts: [] }));
  await fs.writeFile(path.join(source, 'profile.json'), JSON.stringify({ name: 'Ник из копии', avatarAt: 123 }));
  await fs.writeFile(path.join(source, 'avatar.png'), 'Картинка из копии');
  await fs.writeFile(path.join(dest, 'avatar.png'), 'Существующий файл');
  const store = await new Store(dest).init();
  const rename = fs.rename;
  fs.rename = async (from, to) => { if (to === store.profilePath) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); return rename(from, to); };
  t.after(() => { fs.rename = rename; });
  await assert.rejects(store.mergeFrom(source, 'backup'), { code: 'ENOSPC' });
  assert.equal(store.profileView().name, '');
  assert.equal(await fs.readFile(path.join(dest, 'avatar.png'), 'utf8'), 'Существующий файл');
  assert.deepEqual((await fs.readdir(dest)).filter((name) => /^avatar-/.test(name)), []);
  fs.rename = rename;
  await store.mergeFrom(source, 'backup');
  assert.equal(store.profileView().name, 'Ник из копии');
  assert.equal(await fs.readFile(store.profileAvatarPath(store.profile), 'utf8'), 'Картинка из копии');
  assert.equal(await fs.readFile(path.join(dest, 'avatar.png'), 'utf8'), 'Существующий файл');
  const target = path.join(dir, 'target'); await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'avatar.png'), 'Чужой файл');
  await assert.rejects(copyDataTo(dest, target), /import attachment already exists/);
  assert.equal(await fs.readFile(path.join(target, 'avatar.png'), 'utf8'), 'Чужой файл');
  await assert.rejects(fs.access(path.join(target, 'prompts.json')), { code: 'ENOENT' });
});

test('a damaged profile or missing avatar in a backup is reported', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-profile-broken-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'backup'), dest = path.join(dir, 'data');
  await fs.mkdir(source); await fs.mkdir(dest);
  await fs.writeFile(path.join(source, 'prompts.json'), JSON.stringify({ prompts: [] }));
  const store = await new Store(dest).init();
  await fs.writeFile(path.join(source, 'profile.json'), '{broken');
  await assert.rejects(store.mergeFrom(source, 'backup'), /invalid archive profile/);
  await fs.writeFile(path.join(source, 'profile.json'), JSON.stringify({ name: 'Ник', avatarAt: 123 }));
  await assert.rejects(store.mergeFrom(source, 'backup'), /missing archive attachment/);
  assert.equal(store.profileView().name, '');
  assert.equal(store.profileView().avatar, null);
});
