'use strict';
const { isDeepStrictEqual } = require('node:util');
// One entry per assistant request, including all dependent task changes.
class TaskUndoHistory {
  constructor() { this.entries = []; this.sequence = 0; this.pending = Promise.resolve(); }
  run(fn) { const next = this.pending.then(fn); this.pending = next.catch(() => {}); return next; }
  state() { const last = this.entries.at(-1); return { count: this.entries.length, id: last?.id || null, text: last?.text || '' }; }
  record(log, text, owner) {
    const changes = new Map();
    let conflicted = false;
    for (const item of log) {
      const prior = changes.get(item.id);
      if (prior && !isDeepStrictEqual(prior.after, item.before)) conflicted = true;
      changes.set(item.id, { id: item.id, before: prior ? prior.before : item.before, after: item.after });
    }
    const items = [...changes.values()].filter(x => !isDeepStrictEqual(x.before, x.after));
    if (!items.length) return null;
    const id = 'u' + (++this.sequence);
    this.entries.push({ id, text, owner, conflicted, changes: structuredClone(items) });
    if (this.entries.length > 20) this.entries.shift();
    return id;
  }
  async undo(store, { id = null, count = 1 } = {}) {
    const last = this.entries.at(-1);
    if (!last) throw Object.assign(new Error('empty undo'), { userMessage: 'Пока нечего отменять. История действий доступна до закрытия программы.' });
    if (id && id !== last.id) throw Object.assign(new Error('undo order'), { userMessage: 'Сначала отмените более позднее действие кнопкой «Отменить действие» над задачами.' });
    if (!Number.isInteger(count) || count < 1 || count > this.entries.length) throw Object.assign(new Error('undo count'), { userMessage: 'Доступно действий для отмены: ' + this.entries.length + '.' });
    const entries = this.entries.slice(-count).reverse();
    if (entries.some(entry => entry.conflicted || (entry.owner && entry.owner !== store))) {
      throw Object.assign(new Error('undo conflict'), { userMessage: 'Данные изменились во время работы ассистента или открыта другая папка. Отмена остановлена, чтобы сохранить изменения.' });
    }
    await store.restoreTaskChanges(entries.map(e => e.changes));
    this.entries.splice(-count);
    return count;
  }
}
function taskUndoRequest(text) {
  const low = String(text).toLowerCase().replace(/ё/g, 'е').trim().replace(/[.!?]+$/, '');
  if (/^(?:верни|вернуть)\s+(?:все\s+)?как было$/.test(low) || /^(?:отмени|отменить|откати|откатить)(?:\s+(?:пожалуйста|это))?$/.test(low)) return 1;
  const match = /^(?:отмени|отменить|откати|откатить|верни|вернуть)\s+(?:(?:свои|твои|его)\s+)?(?:последн(?:ее|ие|их|ей|ий)\s+)?(?:(\d+)\s+)?(?:последн(?:ее|ие|их|ей|ий)\s+)?действи[еяй](?:\s+ассистента)?$/.exec(low);
  return match ? Number(match[1] || 1) : null;
}
module.exports = { TaskUndoHistory, taskUndoRequest };
