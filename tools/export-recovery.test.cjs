'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const nodefs = require('node:fs');
const { Readable } = require('node:stream');
const os = require('node:os');
const path = require('node:path');
const { writeExport, exportBytes, exportFile } = require('../safe-export');
const { writeZip, extractZip } = require('../archive');

test('archive export preserves an existing .part file and produces a readable archive', { timeout: 10000 }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-export-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'backup.snowball'), attachment = path.join(dir, 'media.bin');
  await fs.writeFile(target, 'Старая копия');
  await fs.writeFile(target + '.part', 'Чужой файл');
  await fs.writeFile(attachment, Buffer.from([0, 1, 2, 3, 255]));
  await writeZip(target, [{ name: 'prompts.json', data: '{"prompts":[]}' }, { name: 'files/p1/media.bin', file: attachment }]);
  assert.equal(await fs.readFile(target + '.part', 'utf8'), 'Чужой файл');
  const unpacked = path.join(dir, 'unpacked');
  await extractZip(target, unpacked);
  assert.equal(await fs.readFile(path.join(unpacked, 'prompts.json'), 'utf8'), '{"prompts":[]}');
  assert.deepEqual(await fs.readFile(path.join(unpacked, 'files', 'p1', 'media.bin')), Buffer.from([0, 1, 2, 3, 255]));
});

test('failed exports leave an existing file intact and remove only their own temporary files', { timeout: 10000 }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-export-failure-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'output.txt'), source = path.join(dir, 'source.txt');
  await fs.writeFile(target, 'Старые данные');
  await fs.writeFile(source, 'Новые данные');
  await assert.rejects(writeExport(target, async (handle) => { await handle.writeFile('Часть'); throw new Error('disk full'); }), /disk full/);
  assert.equal(await fs.readFile(target, 'utf8'), 'Старые данные');
  const rename = fs.rename;
  fs.rename = async (from, to) => {
    if (to === target) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    return rename(from, to);
  };
  t.after(() => { fs.rename = rename; });
  for (const action of [
    () => exportBytes(target, 'Новые данные'),
    () => exportFile(source, target),
    () => writeZip(target, [{ name: 'data.txt', data: 'Новые данные' }])
  ]) {
    await assert.rejects(action(), { code: 'ENOSPC' });
    assert.equal(await fs.readFile(target, 'utf8'), 'Старые данные');
    assert.deepEqual((await fs.readdir(dir)).sort(), ['output.txt', 'source.txt']);
  }
  fs.rename = rename;
  await exportBytes(target, 'Готово');
  assert.equal(await fs.readFile(target, 'utf8'), 'Готово');
  await exportFile(source, source);
  assert.equal(await fs.readFile(source, 'utf8'), 'Новые данные');
});

test('missing archive attachments and invalid names fail without replacing the old archive', { timeout: 10000 }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-export-missing-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'backup.snowball');
  await fs.writeFile(target, 'Прежняя копия');
  await assert.rejects(writeZip(target, [{ name: 'missing.txt', file: path.join(dir, 'missing.txt') }]), { code: 'ENOENT' });
  await assert.rejects(writeZip(target, [{ name: '../invalid', data: 'нет' }]));
  await assert.rejects(exportFile(path.join(dir, 'missing.txt'), target), { code: 'ENOENT' });
  assert.equal(await fs.readFile(target, 'utf8'), 'Прежняя копия');
  assert.deepEqual(await fs.readdir(dir), ['backup.snowball']);
});

test('simultaneous exports use separate temporary files', { timeout: 10000 }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-export-parallel-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const one = path.join(dir, 'one.snowball'), two = path.join(dir, 'two.snowball');
  await Promise.all([
    writeZip(one, [{ name: 'text.txt', data: 'Первый архив' }]),
    writeZip(two, [{ name: 'text.txt', data: 'Второй архив' }])
  ]);
  await extractZip(one, path.join(dir, 'one'));
  await extractZip(two, path.join(dir, 'two'));
  assert.equal(await fs.readFile(path.join(dir, 'one', 'text.txt'), 'utf8'), 'Первый архив');
  assert.equal(await fs.readFile(path.join(dir, 'two', 'text.txt'), 'utf8'), 'Второй архив');
});

test('a read error while building an archive keeps the old destination and closes the source', { timeout: 10000 }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-export-read-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'backup.snowball'), source = path.join(dir, 'file.bin');
  await fs.writeFile(target, 'Старая копия');
  await fs.writeFile(source, 'Тестовый файл');
  const createReadStream = nodefs.createReadStream;
  let started = false;
  nodefs.createReadStream = (file, ...args) => {
    if (file !== source) return createReadStream(file, ...args);
    return new Readable({ read() {
      if (started) return;
      started = true;
      this.push(Buffer.from('часть'));
      this.destroy(Object.assign(new Error('read failed'), { code: 'EIO' }));
    } });
  };
  t.after(() => { nodefs.createReadStream = createReadStream; });
  await assert.rejects(writeZip(target, [{ name: 'file.bin', file: source }]), { code: 'EIO' });
  nodefs.createReadStream = createReadStream;
  assert.equal(started, true);
  assert.equal(await fs.readFile(target, 'utf8'), 'Старая копия');
  assert.deepEqual((await fs.readdir(dir)).sort(), ['backup.snowball', 'file.bin']);
});

test('an archive cannot overwrite one of its own input files', { timeout: 10000 }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-export-source-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'attached.snowball');
  await fs.writeFile(source, 'Не заменять');
  await assert.rejects(writeZip(source, [{ name: 'attached.snowball', file: source }]), /archive target is an input file/);
  assert.equal(await fs.readFile(source, 'utf8'), 'Не заменять');
});
