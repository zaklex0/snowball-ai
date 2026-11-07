'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Store, copyDataTo } = require('../storage');

test('moving data rejects different files and can retry when the destination matches', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-copy-conflict-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), dest = path.join(root, 'dest');
  await fs.mkdir(source); await fs.mkdir(dest);
  const store = await new Store(source).init();
  const p = await store.savePrompt({ item: { title: 'Промт', text: 'Текст' }, addFiles: [{ name: 'file.txt', data: Buffer.from('Исходный файл') }] });
  const original = store.find(p.id).files[0];
  const sourceFile = path.join(store.promptDir(p.id), original.stored);
  const targetFile = path.join(dest, 'Файлы', p.id, original.stored);
  await fs.mkdir(path.dirname(targetFile), { recursive: true });
  await fs.writeFile(targetFile, 'Чужой файл');
  await assert.rejects(copyDataTo(source, dest), /import attachment already exists/);
  assert.equal(await fs.readFile(targetFile, 'utf8'), 'Чужой файл');
  assert.equal(await fs.readFile(sourceFile, 'utf8'), 'Исходный файл');
  await assert.rejects(fs.access(path.join(dest, 'prompts.json')), { code: 'ENOENT' });
  await fs.writeFile(targetFile, 'Исходный файл');
  await copyDataTo(source, dest);
  const moved = await new Store(dest).init();
  assert.equal(moved.find(p.id).title, 'Промт');
  assert.equal(await fs.readFile(moved.filePath(p.id, original.id), 'utf8'), 'Исходный файл');
});

test('a target inside the attachments folder is rejected before copying', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-copy-nested-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); await fs.mkdir(source);
  const store = await new Store(source).init();
  const p = await store.savePrompt({ item: { title: 'Промт' }, addFiles: [{ name: 'file.txt', data: Buffer.from('Данные') }] });
  const target = path.join(store.promptDir(p.id), 'inside');
  await assert.rejects(copyDataTo(source, target), /destination inside data folder/);
  await assert.rejects(fs.access(path.join(target, 'prompts.json')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(store.filePath(p.id, store.find(p.id).files[0].id), 'utf8'), 'Данные');
});

test('an inaccessible source folder is reported instead of silently skipped', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-copy-denied-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), dest = path.join(root, 'dest');
  await fs.mkdir(source); await fs.mkdir(dest);
  const store = await new Store(source).init();
  const p = await store.savePrompt({ item: { title: 'Промт' }, addFiles: [{ name: 'file.txt', data: Buffer.from('Данные') }] });
  const original = store.filePath(p.id, store.find(p.id).files[0].id);
  const lstat = fs.lstat;
  fs.lstat = async (file, ...args) => {
    if (file === store.filesRoot) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return lstat(file, ...args);
  };
  t.after(() => { fs.lstat = lstat; });
  await assert.rejects(copyDataTo(source, dest), { code: 'EACCES' });
  await assert.rejects(fs.access(path.join(dest, 'prompts.json')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(original, 'utf8'), 'Данные');
  fs.lstat = lstat;
  await copyDataTo(source, dest);
  assert.ok((await new Store(dest).init()).find(p.id));
});

test('a destination link cannot redirect copied files to another folder', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-copy-link-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), dest = path.join(root, 'dest'), outside = path.join(root, 'outside');
  await fs.mkdir(source); await fs.mkdir(dest); await fs.mkdir(outside);
  const store = await new Store(source).init();
  await store.savePrompt({ item: { title: 'Промт' }, addFiles: [{ name: 'file.txt', data: Buffer.from('Данные') }] });
  try { await fs.symlink(outside, path.join(dest, 'Файлы'), 'junction'); }
  catch (e) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(e.code)) return t.skip('links are unavailable'); throw e; }
  await assert.rejects(copyDataTo(source, dest), /data folder conflict/);
  assert.deepEqual(await fs.readdir(outside), []);
  await assert.rejects(fs.access(path.join(dest, 'prompts.json')), { code: 'ENOENT' });
});

test('links in the original data are copied as links and can be retried', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-copy-source-link-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), dest = path.join(root, 'dest');
  await fs.mkdir(source); await fs.mkdir(dest);
  const store = await new Store(source).init();
  const p = await store.savePrompt({ item: { title: 'Промт' }, addFiles: [{ name: 'file.txt', data: Buffer.from('Данные') }] });
  const link = path.join(store.promptDir(p.id), 'shortcut.txt');
  try { await fs.symlink('file.txt', link, 'file'); }
  catch (e) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(e.code)) return t.skip('links are unavailable'); throw e; }
  await copyDataTo(source, dest);
  const copied = path.join(dest, 'Файлы', p.id, 'shortcut.txt');
  assert.ok((await fs.lstat(copied)).isSymbolicLink());
  assert.equal(await fs.readlink(copied), 'file.txt');
  await copyDataTo(source, dest);
});
