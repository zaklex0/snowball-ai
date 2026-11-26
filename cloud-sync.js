'use strict';
// No Electron dependency: synchronization and conflict handling are tested with two simulated devices.
const crypto = require('crypto');
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
const digest = value => crypto.createHash('sha256').update(stable(value == null ? null : value)).digest('hex');

// Board settings used to be one indivisible record. Merge independent groups by id,
// but keep a real simultaneous rename (or column change) for the user's choice.
function mergeTaskConfig(local, remote, base) {
  if (!local?.value || !remote?.value || local.assets?.length || remote.assets?.length) return null;
  const a = local.value, b = remote.value, previous = base?.value;
  const same = (x, y) => stable(x) === stable(y);
  const choose = (x, y, old, fallback) => same(x, y) ? x : previous && same(x, old) ? y : previous && same(y, old) ? x : !previous && same(x, fallback) ? y : !previous && same(y, fallback) ? x : undefined;
  const columns = choose(a.columns || [], b.columns || [], previous?.columns || [], []);
  const archiveMode = choose(a.archiveMode || 'day', b.archiveMode || 'day', previous?.archiveMode || 'day', 'day');
  if (columns === undefined || archiveMode === undefined) return null;
  // An older app that does not know groups cannot delete them by omitting the field.
  if ((a.groups !== undefined && !Array.isArray(a.groups)) || (b.groups !== undefined && !Array.isArray(b.groups))) return null;
  const left = a.groups ?? b.groups ?? [], right = b.groups ?? a.groups ?? [];
  const old = previous?.groups || [];
  if ([...left, ...right, ...old].some(g => !g || typeof g.id !== 'string' || typeof g.name !== 'string')) return null;
  const groups = [];
  for (const id of new Set([...left, ...right, ...old].map(g => g.id))) {
    const x = left.find(g => g.id === id), y = right.find(g => g.id === id), before = old.find(g => g.id === id);
    let group;
    if (same(x, y)) group = x;
    else if (previous && same(x, before)) group = y;
    else if (previous && same(y, before)) group = x;
    else if (!before && (!x || !y)) group = x || y;
    else return null;
    if (group) groups.push(group);
  }
  if (groups.length > 200) return null;
  return { value: { ...a, ...b, columns, archiveMode, groups }, assets: [] };
}
class CloudSync {
  constructor({ remote, local, state, save }) {
    this.remote = remote; this.local = local; this.state = state; this.save = save;
    state.base ||= {}; state.conflicts ||= {};
  }
  async checkpoint(key, row) {
    this.state.base[key] = { version: row.version, hash: digest(row.payload) };
    // Only board settings need a small base value for three-way merging, never attachments.
    if (key === 'config:tasks') this.state.base[key].payload = structuredClone(row.payload);
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
    // Install group names and custom columns before the tasks that refer to them.
    const orderedKeys = keys.delete('config:tasks') ? ['config:tasks', ...keys] : [...keys];
    for (const key of orderedKeys) {
      const value = snapshot[key] ?? null, row = all[key] || { version: 0, payload: null };
      const base = this.state.base[key], hash = digest(value);
      // Unchanged cloud records need only their version, not their full text and cover every 20 seconds.
      const remoteHash = base && row.version === base.version ? base.hash : digest(row.payload);
      if (key === 'config:tasks' && hash !== remoteHash && (this.state.conflicts[key] ||
          (base ? hash !== base.hash && row.version !== base.version : value !== null && row.version !== 0))) {
        const merged = mergeTaskConfig(value, row.payload, base?.payload);
        if (merged) {
          // Use the same locked local check and server version check as ordinary writes.
          if (!await this.local.apply(key, merged, hash)) continue;
          await this.local.upload(merged);
          const result = await this.remote.put(key, row.version, merged);
          if (result.ok) await this.checkpoint(key, result.record);
          else await this.conflict(key, merged, result.record || { version: 0, payload: null });
          continue;
        }
      }
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
