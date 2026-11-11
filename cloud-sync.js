'use strict';
// No Electron dependency: synchronization and conflict handling are tested with two simulated devices.
const crypto = require('crypto');
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
const digest = value => crypto.createHash('sha256').update(stable(value == null ? null : value)).digest('hex');
class CloudSync {
  constructor({ remote, local, state, save }) {
    this.remote = remote; this.local = local; this.state = state; this.save = save;
    state.base ||= {}; state.conflicts ||= {};
  }
  async checkpoint(key, row) {
    this.state.base[key] = { version: row.version, hash: digest(row.payload) };
    this.state.manifests ||= {}; this.state.manifests[key] = row.payload?.assets || [];
    delete this.state.conflicts[key];
    await this.save(this.state);
  }
  async conflict(key, value, row) {
    this.state.conflicts[key] = { local: value, remote: row.payload, version: row.version };
    await this.save(this.state);
  }
  async sync() {
    const all = await this.remote.list(this.state.base);
    const snapshot = await this.local.snapshot();
    const keys = new Set([...Object.keys(snapshot), ...Object.keys(this.state.base), ...Object.keys(all)]);
    for (const key of keys) {
      const value = snapshot[key] ?? null, row = all[key] || { version: 0, payload: null };
      const base = this.state.base[key], hash = digest(value);
      // Unchanged cloud records need only their version, not their full text and cover every 20 seconds.
      const remoteHash = base && row.version === base.version ? base.hash : digest(row.payload);
      if (this.state.conflicts[key]) continue;
      if (hash === remoteHash) { if (!base || base.version !== row.version || base.hash !== hash) await this.checkpoint(key, row); continue; }
      const changedHere = base ? hash !== base.hash : value !== null;
      const changedThere = base ? row.version !== base.version : row.version !== 0;
      if (changedHere && changedThere) { await this.conflict(key, value, row); continue; }
      if (changedHere) {
        await this.local.upload(value);
        const result = await this.remote.put(key, base?.version || 0, value);
        if (!result.ok) { await this.conflict(key, value, result.record || { version: 0, payload: null }); continue; }
        await this.checkpoint(key, result.record);
      } else if (changedThere) {
        // Recheck under the local write lock after network I/O: never overwrite a newer edit.
        if (await this.local.apply(key, row.payload, hash)) await this.checkpoint(key, row);
      }
    }
  }
  async resolve(key, choice) {
    const conflict = this.state.conflicts[key];
    if (!conflict || !['local', 'remote'].includes(choice)) throw Error('Конфликт уже изменился. Обновите список.');
    const current = (await this.local.snapshot())[key] ?? null;
    if (digest(current) !== digest(conflict.local)) throw Error('Запись снова изменилась. Сначала сохраните текущую правку.');
    // Keep an independent recovery copy even after the conflict has been resolved.
    await this.local.recover(key, conflict);
    if (choice === 'local') {
      await this.local.upload(current);
      const result = await this.remote.put(key, conflict.version, current);
      if (!result.ok) { await this.conflict(key, current, result.record); throw Error('На другом устройстве появилась новая правка. Выберите версию ещё раз.'); }
      await this.checkpoint(key, result.record);
    } else {
      const all = await this.remote.list(), row = all[key];
      if (!row || row.version !== conflict.version) { if (row) await this.conflict(key, current, row); throw Error('Облачная версия изменилась. Выберите её ещё раз.'); }
      if (!await this.local.apply(key, row.payload, digest(current))) throw Error('Запись изменилась во время выбора. Повторите.');
      await this.checkpoint(key, row);
    }
  }
}
module.exports = { CloudSync, digest, stable };
