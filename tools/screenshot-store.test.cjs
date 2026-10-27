'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises'), os = require('os'), path = require('path');
const { ScreenshotStore, annotations, cropRect, normalizeCrop, pngSize } = require('../screenshot-store');
const { writeZip, extractZip } = require('../archive');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9hoAAAAASUVORK5CYII=', 'base64');
test('immutable originals, atomic revisions, concurrent windows, restart, ZIP restore and no overwrite', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-shot-unit-')), store = new ScreenshotStore(dir);
  const a = await store.add(png), b = await store.add(png);
  assert.equal((await store.list()).length, 2);
  await assert.rejects(store.get('../secret'));
  const ops = [{ type: 'marker', color: '#ff0000', width: 3, pressure: 70, points: [{ x: .5, y: .5 }] }];
  const results = await Promise.allSettled([store.save(a.id, { revision: 0, ops, blur: 15 }), store.save(a.id, { revision: 0, ops: [], blur: 0 })]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected');
  assert.deepEqual(await fs.readFile(path.join(store.folder(a.id), 'original.png')), png);
  const reopened = new ScreenshotStore(dir); assert.deepEqual((await reopened.get(a.id)).ops, ops);
  const pack = await reopened.backupEntries(); assert.equal(pack.count, 2);
  const zip = path.join(dir, 'copy.snowball'), unpacked = path.join(dir, 'unpacked');
  await writeZip(zip, pack.entries); await extractZip(zip, unpacked);
  const target = new ScreenshotStore(path.join(dir, 'restored')); assert.equal(await target.merge(path.join(unpacked, 'screenshots')), 2);
  await target.save(a.id, { revision: 1, ops: [], blur: 20 });
  assert.equal(await target.merge(path.join(unpacked, 'screenshots')), 0); assert.equal((await target.get(a.id)).blur, 20);
  assert.equal((await target.get(b.id)).width, 1);
});
test('untrusted dimensions, annotation limits and DPI independent crops', () => {
  assert.throws(() => pngSize(Buffer.from('hello')));
  const enormous = Buffer.from(png); enormous.writeUInt32BE(50000, 16); assert.throws(() => pngSize(enormous));
  assert.throws(() => annotations([{ type: 'text', color: 'url(evil)', a: { x: 0, y: 0 }, b: { x: 1, y: 1 } }], 10, 10));
  assert.throws(() => annotations([{ type: 'pen', color: '#123456', points: [{ x: NaN, y: 0 }] }], 10, 10));
  assert.throws(() => annotations(new Array(1501), 10, 10));
  assert.deepEqual(cropRect({ x: .25, y: .1, w: .5, h: .5 }, 3840, 2160), { x: 960, y: 216, width: 1920, height: 1080 });
  assert.deepEqual(cropRect({ x: 0, y: 0, w: 1, h: 1 }, 2560, 1440), { x: 0, y: 0, width: 2560, height: 1440 });
  assert.throws(() => cropRect({ x: 0, y: 0, w: 0, h: 1 }, 100, 100));
});

test('non-destructive crop persists, validates bounds, and can restore the original view', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-shot-crop-'));
  const original = await fs.readFile(path.join(__dirname, '..', 'assets', 'icon.png'));
  const store = new ScreenshotStore(dir);
  const added = await store.add(original);
  assert.equal((await store.get(added.id)).crop, null);
  const crop = { x: 40, y: 20, width: 100, height: 120 };
  await store.save(added.id, { revision: 0, ops: [], blur: 15, crop });
  const reopened = new ScreenshotStore(dir);
  assert.deepEqual((await reopened.get(added.id)).crop, crop);
  assert.deepEqual((await reopened.list())[0].crop, crop);
  assert.deepEqual(await fs.readFile(path.join(store.folder(added.id), 'original.png')), original);
  await assert.rejects(reopened.save(added.id, { revision: 0, ops: [], blur: 15, crop: null }));
  await reopened.save(added.id, { revision: 1, ops: [], blur: 15, crop: null });
  assert.equal((await reopened.get(added.id)).crop, null);
  assert.deepEqual(normalizeCrop({ x: 0, y: 0, width: 256, height: 256 }, 256, 256), null);
  for (const bad of [{ x: -1, y: 0, width: 20, height: 20 }, { x: 250, y: 0, width: 20, height: 20 }, { x: 0.5, y: 0, width: 20, height: 20 }, { x: 0, y: 0, width: 1, height: 20 }])
    assert.throws(() => normalizeCrop(bad, 256, 256));
});
