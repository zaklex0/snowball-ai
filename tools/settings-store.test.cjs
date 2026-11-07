'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { loadSettingsFile, writeSettings, backupPath } = require('../settings-store');

test('failed settings replacement preserves both previous files', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'snowball-settings-write-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json'), backup = backupPath(file);
  const old = { dataDir: 'F:/test-data', theme: 'dark', spend: { openai: { sinceUsd: 1.5 } } };
  writeSettings(file, old);
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === file) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); return rename(from, to); };
  t.after(() => { fs.renameSync = rename; });
  assert.throws(() => writeSettings(file, { dataDir: 'F:/new-data' }), { code: 'ENOSPC' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), old);
  assert.deepEqual(JSON.parse(fs.readFileSync(backup, 'utf8')), old);
  assert.deepEqual((await fsp.readdir(dir)).sort(), ['settings.backup.json', 'settings.json']);
  fs.renameSync = rename;
  writeSettings(file, { ...old, theme: 'light' });
  assert.equal(loadSettingsFile(file).settings.theme, 'light');
});

test('settings recover from backup while preserving the damaged original', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'snowball-settings-recover-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json'), expected = { dataDir: 'F:/test-data', theme: 'dark' };
  writeSettings(file, expected);
  await fsp.writeFile(file, '{broken');
  const result = loadSettingsFile(file);
  assert.deepEqual(result.settings, expected);
  assert.match(result.warning, /восстановлены из запасной копии/);
  const broken = (await fsp.readdir(dir)).find((name) => /^settings\.broken-/.test(name));
  assert.equal(await fsp.readFile(path.join(dir, broken), 'utf8'), '{broken');
  writeSettings(file, result.settings);
  assert.equal(loadSettingsFile(file).settings.dataDir, expected.dataDir);
  await fsp.unlink(file);
  assert.deepEqual(loadSettingsFile(file).settings, expected);
});

test('damaged settings without a backup are kept and reported', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'snowball-settings-broken-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');
  await fsp.writeFile(file, '{broken');
  const result = loadSettingsFile(file);
  assert.deepEqual(result.settings, {});
  assert.match(result.warning, /исправной копии нет/);
  const broken = (await fsp.readdir(dir)).find((name) => /^settings\.broken-/.test(name));
  assert.equal(await fsp.readFile(path.join(dir, broken), 'utf8'), '{broken');
  assert.equal(await fsp.readFile(file, 'utf8'), '{broken');
});

test('a failed backup update keeps its last good version and is reported', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'snowball-settings-backup-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json'), backup = backupPath(file);
  writeSettings(file, { theme: 'dark' });
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === backup) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); return rename(from, to); };
  t.after(() => { fs.renameSync = rename; });
  const result = writeSettings(file, { theme: 'light' });
  assert.equal(result.backupError.code, 'ENOSPC');
  assert.equal(JSON.parse(await fsp.readFile(file, 'utf8')).theme, 'light');
  assert.equal(JSON.parse(await fsp.readFile(backup, 'utf8')).theme, 'dark');
});

test('a read error does not get treated as missing settings', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'snowball-settings-read-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');
  await fsp.writeFile(file, '{"dataDir":"F:/test-data"}');
  const read = fs.readFileSync;
  fs.readFileSync = (p, ...args) => { if (p === file) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return read(p, ...args); };
  t.after(() => { fs.readFileSync = read; });
  assert.throws(() => loadSettingsFile(file), { code: 'EACCES' });
  fs.readFileSync = read;
  assert.equal((await fsp.readFile(file, 'utf8')), '{"dataDir":"F:/test-data"}');
});
