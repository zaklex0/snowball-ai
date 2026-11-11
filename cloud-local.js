'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { exportBytes } = require('./safe-export');
const { ScreenshotStore, normalizeScreenshot, pngSize } = require('./screenshot-store');
const { digest } = require('./cloud-sync');
const MAX_ASSET = 20 * 1024 * 1024;
const idOK = s => /^[A-Za-z0-9_-]{1,64}$/.test(s);
function refs(key, value) {
  if (!value) return [];
  const [kind, id] = key.split(':');
  if (!idOK(id)) throw Error('Неверный номер записи.');
  let result = [];
  if (kind === 'prompt') result = (value.files || []).map(f => ['Файлы', id, f.stored]);
  if (kind === 'chat') result = (value.messages || []).flatMap(m => [...(m.images || []), ...(m.files || [])].map(f => ['Файлы чатов', id, f.stored]));
  if (kind === 'skill') result = [['Скиллы', id, value.file.stored]];
  if (kind === 'shot') result = [['Снимки', id, 'original.png']];
  if (key === 'config:profile' && value.avatarAt) result = [[value.avatarFile || 'avatar.png']];
  return [...new Set(result.map(parts => {
    if (parts.some(p => typeof p !== 'string' || !p || p === '.' || p === '..' || /[\\/:\x00-\x1f]/.test(p) || /[. ]$/.test(p))) throw Error('Неверное имя вложения.');
    if (parts.length === 1 && !/^avatar(?:-[a-f0-9]{24})?\.png$/.test(parts[0])) throw Error('Неверное имя аватарки.');
    return parts.join('/');
  }))];
}
class CloudLocal {
  constructor(store, { remote, lock = fn => fn(), changed = () => {} }) {
    this.store = store; this.remote = remote; this.lock = lock; this.changed = changed; this.cache = new Map();
  }
  async safePath(relative) {
    const root = await fsp.realpath(this.store.dir), file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep)) throw Error('Вложение вне папки данных.');
    // Reject Windows junctions/symlinks in any existing ancestor too.
    let cursor = root;
    for (const part of relative.split('/')) {
      cursor = path.join(cursor, part);
      try { const stat = await fsp.lstat(cursor); if (stat.isSymbolicLink()) throw Error('Ссылки на другие папки не синхронизируются.'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    return file;
  }
  async asset(relative, old) {
    const file = await this.safePath(relative);
    let stat;
    try { stat = await fsp.stat(file); }
    catch (e) { if (e.code === 'ENOENT' && old?.localOnly) return old; throw Error('Не найдено вложение: ' + path.basename(file)); }
    if (stat.size > MAX_ASSET) return { path: relative, localOnly: true, size: stat.size };
    const cached = this.cache.get(relative);
    if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) return cached.asset;
    const bytes = await fsp.readFile(file), hash = crypto.createHash('sha256').update(bytes).digest('hex');
    const asset = { path: relative, hash, size: bytes.length };
    this.cache.set(relative, { mtime: stat.mtimeMs, size: stat.size, asset });
    return asset;
  }
  async snapshot() { return this.lock(() => this.store.run(() => this.snapshotUnlocked())); }
  async snapshotUnlocked() {
    const records = this.store.cloudRecords();
    const shots = new ScreenshotStore(this.store.dir);
    const details = await shots.listDetails();
    if (details.broken) throw Error('В истории есть повреждённый снимок. Сначала восстановите его: синхронизация приостановлена.');
    for (const shot of details.items) { const value = await shots.read(shot.id); delete value.revision; records['shot:' + shot.id] = value; }
    const result = {};
    for (const [key, value] of Object.entries(records)) {
      const old = this.manifests?.[key] || [];
      const assets = [];
      for (const relative of refs(key, value)) {
        const asset = await this.asset(relative, old.find(a => a.path === relative));
        if (key.startsWith('shot:') && asset.localOnly) throw Object.assign(Error(), { userMessage: 'Снимок «' + value.name + '» больше 20 МБ. Сохраните уменьшенную копию для синхронизации.' });
        assets.push(asset);
      }
      result[key] = { value, assets };
    }
    return result;
  }
  async upload(payload) {
    for (const asset of payload?.assets || []) {
      if (asset.localOnly) continue;
      const bytes = await fsp.readFile(await this.safePath(asset.path));
      if (bytes.length > MAX_ASSET || crypto.createHash('sha256').update(bytes).digest('hex') !== asset.hash) throw Error('Вложение изменилось во время отправки. Повторим синхронизацию.');
      await this.remote.upload(asset.hash, bytes);
    }
  }
  async download(key, payload) {
    if (!payload) return [];
    const staged = [];
    const allowed = refs(key, payload.value);
    if (key.startsWith('shot:')) normalizeScreenshot(payload.value, key.slice(5));
    if (!Array.isArray(payload.assets) || payload.assets.length !== allowed.length) throw Error('Повреждён список облачных вложений.');
    const seen = new Set();
    for (const asset of payload.assets) {
      if (!allowed.includes(asset.path) || seen.has(asset.path)) throw Error('Неверный путь облачного вложения.');
      seen.add(asset.path);
      if (asset.localOnly) { if (!(asset.size > MAX_ASSET)) throw Error('Повреждено вложение.'); continue; }
      if (!/^[a-f0-9]{64}$/.test(asset.hash) || !Number.isInteger(asset.size) || asset.size < 0 || asset.size > MAX_ASSET) throw Error('Повреждено облачное вложение.');
      const file = await this.safePath(asset.path);
      try {
        const bytes = await fsp.readFile(file);
        if (crypto.createHash('sha256').update(bytes).digest('hex') === asset.hash) continue;
        throw Error('На этом компьютере уже есть другое вложение с таким именем. Сохраните его отдельно: ' + path.basename(file));
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const bytes = await this.remote.download(asset.hash);
      if (bytes.length !== asset.size || crypto.createHash('sha256').update(bytes).digest('hex') !== asset.hash) throw Error('Вложение загрузилось не полностью. Повторим позже.');
      if (key.startsWith('shot:')) { const size = pngSize(bytes); if (size.width !== payload.value.width || size.height !== payload.value.height) throw Error('Неверный размер облачного снимка.'); }
      const staging = path.join(this.store.dir, '.cloud-sync', 'staging');
      await fsp.mkdir(staging, { recursive: true });
      const temp = path.join(staging, asset.hash);
      await exportBytes(temp, bytes); staged.push({ temp, file });
    }
    return staged;
  }
  async recover(key, value) {
    const folder = path.join(this.store.dir, '.cloud-sync', 'recovery'); await fsp.mkdir(folder, { recursive: true });
    await exportBytes(path.join(folder, Date.now() + '-' + crypto.randomBytes(6).toString('hex') + '.json'), JSON.stringify({ key, value }, null, 2));
  }
  async apply(key, payload, expected) {
    const staged = await this.download(key, payload);
    return this.lock(() => this.store.run(async () => {
      const current = (await this.snapshotUnlocked())[key] ?? null;
      if (digest(current) !== expected) return false;
      await this.recover(key, current);
      const created = [];
      try {
      for (const { temp, file } of staged) {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.copyFile(temp, file, fs.constants.COPYFILE_EXCL);
        created.push(file);
      }
      if (key.startsWith('shot:')) {
        const id = key.slice(5), shots = new ScreenshotStore(this.store.dir);
        if (!/^s[a-f0-9]{32}$/.test(id)) throw Error('Неверный номер снимка.');
        if (payload) {
          const file = path.join(shots.folder(id), 'meta.json');
          let revision = 0;
          try { revision = (await shots.read(id)).revision + 1; } catch (e) { if (e.code !== 'ENOENT') throw e; }
          await exportBytes(file, JSON.stringify(normalizeScreenshot({ ...payload.value, revision }, id)));
          await shots.read(id); // Validate on read just as for local screenshots.
        } else await this.store.trash(shots.folder(id));
      } else await this.store.applyCloudRecord(key, payload?.value || null);
      } catch (e) {
        // Remove only new files from this attempt, so a failed screenshot import remains retryable.
        for (const file of created) await fsp.unlink(file).catch(() => {});
        if (key.startsWith('shot:') && current === null) await fsp.rmdir(path.join(this.store.dir, 'Снимки', key.slice(5))).catch(() => {});
        throw e;
      }
      for (const { temp } of staged) await fsp.unlink(temp).catch(() => {});
      this.manifests ||= {}; this.manifests[key] = payload?.assets || [];
      this.changed(); return true;
    }), key);
  }
}
module.exports = { CloudLocal, refs, MAX_ASSET };
