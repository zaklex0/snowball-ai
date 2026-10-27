'use strict';
// Originals are immutable; each atomic JSON file contains the current editable annotations.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { pathToFileURL } = require('url');
const SHOTS_DIR = 'Снимки';
const ID = /^s[0-9a-f]{32}$/;
const MAX_PIXELS = 40000000;
function validSize(w, h) {
  return (
    Number.isInteger(w) &&
    Number.isInteger(h) &&
    w > 0 &&
    h > 0 &&
    w <= 20000 &&
    h <= 20000 &&
    w * h <= MAX_PIXELS
  );
}
function pngSize(bytes) {
  const b = Buffer.from(bytes || []);
  if (
    b.length < 24 ||
    b.length > 80 * 1024 * 1024 ||
    b.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
    b.toString('ascii', 12, 16) !== 'IHDR'
  )
    throw new Error('Не удалось прочитать изображение PNG.');
  const width = b.readUInt32BE(16),
    height = b.readUInt32BE(20);
  if (!validSize(width, height))
    throw new Error('Снимок слишком большой. Выделите меньшую область.');
  return { width, height };
}
function annotations(input, w, h) {
  if (!Array.isArray(input) || input.length > 1500)
    throw new Error('Слишком много пометок на одном снимке.');
  let points = 0;
  const point = (p) => {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y))
      throw new Error('Некорректная область пометки.');
    return { x: Math.max(0, Math.min(w, p.x)), y: Math.max(0, Math.min(h, p.y)) };
  };
  return input.map((o) => {
    if (
      !o ||
      !['pen', 'marker', 'rect', 'focus', 'text'].includes(o.type) ||
      !/^#[0-9a-f]{6}$/i.test(o.color)
    )
      throw new Error('Некорректная пометка.');
    const r = {
      type: o.type,
      color: o.color,
      width: Math.max(1, Math.min(50, Number(o.width) || 5)),
      pressure: Math.max(10, Math.min(100, Number(o.pressure) || 35)),
    };
    if (o.type === 'pen' || o.type === 'marker') {
      if (!Array.isArray(o.points) || !o.points.length || (points += o.points.length) > 120000)
        throw new Error('Слишком длинный рисунок.');
      r.points = o.points.map(point);
    } else {
      r.a = point(o.a);
      r.b = point(o.b);
    }
    if (o.type === 'text') r.text = String(o.text || '').slice(0, 2000);
    return r;
  });
}
// A crop is a view of the immutable original, so resetting it restores every annotation.
function normalizeCrop(crop, width, height) {
  if (crop == null) return null;
  if (
    !crop ||
    !['x', 'y', 'width', 'height'].every((key) => Number.isInteger(crop[key])) ||
    crop.x < 0 || crop.y < 0 || crop.width < 2 || crop.height < 2 ||
    crop.x + crop.width > width || crop.y + crop.height > height
  ) throw Error('Некорректная область обрезки.');
  if (crop.x === 0 && crop.y === 0 && crop.width === width && crop.height === height)
    return null;
  return { x: crop.x, y: crop.y, width: crop.width, height: crop.height };
}
function normalize(m, id) {
  if (!m || !ID.test(id) || m.id !== id || !validSize(m.width, m.height))
    throw new Error('Повреждена запись снимка.');
  return {
    format: 'snowball-screenshot',
    version: 1,
    id,
    name: String(m.name || 'Снимок').slice(0, 150),
    width: m.width,
    height: m.height,
    createdAt: Number(m.createdAt) || Date.now(),
    updatedAt: Number(m.updatedAt) || Date.now(),
    revision: Math.max(0, Math.floor(Number(m.revision) || 0)),
    blur: Math.max(0, Math.min(40, Number(m.blur) || 0)),
    crop: normalizeCrop(m.crop, m.width, m.height),
    ops: annotations(m.ops || [], m.width, m.height),
    thumb:
      typeof m.thumb === 'string' &&
      m.thumb.length < 250000 &&
      /^data:image\/(png|jpeg);base64,[a-z0-9+/=]+$/i.test(m.thumb)
        ? m.thumb
        : '',
  };
}
async function atomic(file, data) {
  const tmp = file + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  try {
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, file);
  } finally {
    await fsp.unlink(tmp).catch(() => {});
  }
}
class ScreenshotStore {
  constructor(dir) {
    this.root = path.join(dir, SHOTS_DIR);
    this.queue = Promise.resolve();
  }
  run(fn) {
    const p = this.queue.then(fn);
    this.queue = p.catch(() => {});
    return p;
  }
  folder(id) {
    if (!ID.test(id || '')) throw new Error('Снимок не найден.');
    return path.join(this.root, id);
  }
  async read(id) {
    return normalize(
      JSON.parse(await fsp.readFile(path.join(this.folder(id), 'meta.json'), 'utf8')),
      id,
    );
  }
  async list() {
    await this.queue;
    let dirs;
    try {
      dirs = await fsp.readdir(this.root);
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
    const out = [];
    for (const id of dirs.filter((x) => ID.test(x))) {
      try {
        const m = await this.read(id);
        if (!fs.existsSync(path.join(this.folder(id), 'original.png'))) continue;
        const { ops, ...summary } = m;
        out.push(summary);
      } catch (e) {
        /* One broken record must not hide the rest of the history. */
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  }
  get(id) {
    return this.run(async () => ({
      ...(await this.read(id)),
      url: pathToFileURL(path.join(this.folder(id), 'original.png')).href,
    }));
  }
  add(bytes, thumb = '') {
    return this.run(async () => {
      const size = pngSize(bytes),
        id = 's' + crypto.randomBytes(16).toString('hex'),
        now = Date.now(),
        folder = this.folder(id);
      const m = normalize(
        {
          id,
          ...size,
          name: 'Снимок ' + new Date(now).toLocaleString('ru-RU'),
          createdAt: now,
          updatedAt: now,
          revision: 0,
          blur: 15,
          ops: [],
          thumb,
        },
        id,
      );
      await fsp.mkdir(folder, { recursive: true });
      await atomic(path.join(folder, 'original.png'), Buffer.from(bytes));
      await atomic(path.join(folder, 'meta.json'), JSON.stringify(m));
      return m;
    });
  }
  save(id, input) {
    return this.run(async () => {
      const old = await this.read(id);
      if (!input || input.revision !== old.revision)
        throw new Error('Снимок уже изменён в другом окне. Откройте его заново перед правкой.');
      const m = normalize(
        {
          ...old,
          ops: input.ops,
          blur: input.blur,
          crop: input.crop,
          thumb: input.thumb,
          revision: old.revision + 1,
          updatedAt: Date.now(),
        },
        id,
      );
      await atomic(path.join(this.folder(id), 'meta.json'), JSON.stringify(m));
      return { revision: m.revision, updatedAt: m.updatedAt };
    });
  }
  // Keep a short-lived undo copy before sending the original folder to Windows Recycle Bin.
  remove(id, trash) {
    return this.run(async () => {
      const meta = await this.read(id);
      const backup = await fsp.mkdtemp(path.join(os.tmpdir(), 'snowball-shot-undo-'));
      try {
        for (const name of ['meta.json', 'original.png'])
          await fsp.copyFile(path.join(this.folder(id), name), path.join(backup, name));
        await trash(this.folder(id));
        return { id, backup, meta };
      } catch (error) {
        await discardUndo(backup);
        throw error;
      }
    });
  }
  restore(removed) {
    return this.run(async () => {
      const target = this.folder(removed.id);
      const bytes = await fsp.readFile(path.join(removed.backup, 'original.png'));
      pngSize(bytes);
      // mkdir without recursive refuses to overwrite an independently restored screenshot.
      await fsp.mkdir(this.root, { recursive: true });
      await fsp.mkdir(target);
      await atomic(path.join(target, 'original.png'), bytes);
      await atomic(
        path.join(target, 'meta.json'),
        JSON.stringify(normalize(removed.meta, removed.id)),
      );
      return removed.id;
    });
  }
  async backupEntries() {
    const list = await this.list(),
      entries = [];
    for (const m of list)
      for (const name of ['meta.json', 'original.png'])
        entries.push({
          name: 'screenshots/' + m.id + '/' + name,
          file: path.join(this.folder(m.id), name),
        });
    return { entries, count: list.length };
  }
  merge(root) {
    return this.run(async () => {
      let ids;
      try {
        ids = await fsp.readdir(root);
      } catch (e) {
        if (e.code === 'ENOENT') return 0;
        throw e;
      }
      let count = 0;
      for (const id of ids.filter((x) => ID.test(x))) {
        const target = this.folder(id);
        if (fs.existsSync(target)) continue;
        const source = path.join(root, id),
          m = normalize(JSON.parse(await fsp.readFile(path.join(source, 'meta.json'), 'utf8')), id);
        const bytes = await fsp.readFile(path.join(source, 'original.png')),
          size = pngSize(bytes);
        if (size.width !== m.width || size.height !== m.height)
          throw new Error('Размер снимка в копии не совпадает с записью.');
        await fsp.mkdir(target, { recursive: true });
        await atomic(path.join(target, 'original.png'), bytes);
        await atomic(path.join(target, 'meta.json'), JSON.stringify(m));
        count++;
      }
      return count;
    });
  }
}
// Coordinates are ratios of the selected display, independent of Windows DPI and negative monitor origins.
function cropRect(r, width, height) {
  if (!r || !['x', 'y', 'w', 'h'].every((k) => Number.isFinite(r[k])) || r.w <= 0 || r.h <= 0)
    throw new Error('Выделите область снимка.');
  const x = Math.max(0, Math.min(width - 1, Math.floor(r.x * width))),
    y = Math.max(0, Math.min(height - 1, Math.floor(r.y * height)));
  return {
    x,
    y,
    width: Math.max(1, Math.min(width - x, Math.round(r.w * width))),
    height: Math.max(1, Math.min(height - y, Math.round(r.h * height))),
  };
}
async function discardUndo(folder) {
  const resolved = path.resolve(folder);
  if (
    path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
    !path.basename(resolved).startsWith('snowball-shot-undo-')
  )
    throw Error('Неверная папка отмены удаления.');
  await fsp.rm(resolved, { recursive: true, force: true });
}
module.exports = { ScreenshotStore, SHOTS_DIR, annotations, pngSize, validSize, cropRect, normalizeCrop, discardUndo };
