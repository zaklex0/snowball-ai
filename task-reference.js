'use strict';

// Read explicit task references only: dates, times and title digits are not task numbers.
function taskReferences(text) {
  return taskReferenceSelection(text).numbers;
}
function taskReferenceSelection(text) {
  text = String(text || '').replace(/[‑–—]/g, '-');
  const ordinal = '(?:\\s*-?\\s*(?:й|я|ю|е|го|ой|ую|ые|х))?';
  const range = new RegExp('задач[а-яё]*\\s*(?:(?:с|от)\\s*)?(?:[№#]\\s*)?(\\d+)' + ordinal + '\\s*(?:по|до|-)\\s*(?:[№#]\\s*)?(\\d+)' + ordinal + '(?![\\dа-яё])', 'iu').exec(text);
  if (range) {
    const from = Number(range[1]), to = Number(range[2]);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from || to - from >= 500) return { numbers: [], error: 'Укажите диапазон от меньшего номера к большему, не больше 500 задач за раз.' };
    return { numbers: Array.from({ length: to - from + 1 }, (_, i) => from + i), range: true };
  }
  const list = new RegExp('задач[а-яё]*\\s*(?:[№#]\\s*)?(\\d+(?:\\.\\d+)*' + ordinal + '(?:\\s*(?:,|и)\\s*(?:[№#]\\s*)?\\d+(?:\\.\\d+)*' + ordinal + ')+)', 'iu').exec(text);
  if (list) {
    const numbers = [...new Set((list[1].match(/\d+(?:\.\d+)*/g) || []).map(n => n.includes('.') ? n : Number(n)))];
    return { numbers };
  }
  const pattern = /(?:задач[ауеиой]*\s*(?:(?:под\s+)?номер(?:ом|а)?\s*|[№#]\s*)?|номер(?:ом|а)?\s*|[№#]\s*)(\d+(?:\.\d+)*)(?![\dа-яёa-z])/giu;
  return { numbers: [...new Set(Array.from(text.matchAll(pattern), m => m[1].includes('.') ? m[1] : Number(m[1])))] };
}
function taskColumnReferences(text, columns) {
  let low = String(text || '').toLowerCase().replace(/ё/g, 'е').replace(/[«»"“”]/g, '').replace(/\s+/g, ' ');
  const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = c => c.id === 'doing' ? '(?:в процессе|процесс[а-я]*|работ[а-я]*)' : c.id === 'todo' ? '(?:предстоит|предстоящ[а-я]*)' : c.id === 'done' ? '(?:готово|готовых)' : escape(c.name.toLowerCase().replace(/ё/g, 'е'));
  let source = null, target = null;
  for (const c of columns) {
    const explicit = new RegExp('(?:^|\\s)(?:из|со|с)\\s+(?:(?:столбц[а-я]*|вкладк[а-я]*)\\s+)?' + pattern(c) + '(?=\\s|[.,!?]|$)').exec(low);
    const scoped = new RegExp('(?:^|\\s)(?:в|во|на)\\s+(?:столбце|вкладке)\\s+' + pattern(c) + '(?=\\s|[.,!?]|$)').exec(low);
    const match = explicit || scoped;
    if (match) { source = c.id; low = low.slice(0, match.index) + ' ' + low.slice(match.index + match[0].length); break; }
  }
  for (const c of columns) {
    const p = c.id === 'doing' ? '(?:в\\s+)?' + pattern(c) : pattern(c);
    if (new RegExp('(?:^|\\s)(?:в|во)\\s+(?:(?:столбец|вкладку)\\s+)?' + p + '(?=\\s|[.,!?]|$)').test(low)) target = c.id;
  }
  if (!source && !/перенес|перенос|перемест|перемещ|сдвинь|передвинь/.test(low)) {
    const mentioned = columns.filter(c => new RegExp('(?:^|\\s)' + pattern(c) + '(?=\\s|[.,!?]|$)').test(low));
    if (mentioned.length === 1) source = mentioned[0].id;
  }
  return { source, target };
}
function taskTargetGroup(text, groups) {
  const match = /(?:^|\s)в\s+(?:подгрупп[уы]|категори[юи])\s+/iu.exec(String(text));
  if (!match) return { mentioned: false, text };
  const start = match.index + match[0].length;
  const rest = String(text).slice(start), norm = s => s.toLowerCase().replace(/ё/g, 'е').replace(/[«»"“”]/g, '').replace(/\s+/g, ' ').trim();
  const tail = norm(rest).replace(/[.!?]+$/, '').trim();
  const candidates = groups.concat([{ id: '', name: 'Без подгруппы' }]).slice().sort((a, b) => b.name.length - a.name.length);
  const group = candidates.find(g => tail === norm(g.name) || tail.startsWith(norm(g.name) + ' из ') || tail.startsWith(norm(g.name) + ' в столбец ') || tail.startsWith(norm(g.name) + ' во вкладку '));
  if (!group) return { mentioned: true, error: 'Подгруппа «' + rest.trim().replace(/^[«"“]|[»"”]$/g, '') + '» не найдена. Проверьте название подгруппы.' };
  const escaped = group.name.trim().split(/\s+/).map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  const removeLength = new RegExp('^[«"“]?\\s*' + escaped + '\\s*[»"”]?', 'iu').exec(rest)?.[0].length || group.name.length;
  return { mentioned: true, groupId: group.id, text: String(text).slice(0, match.index) + ' ' + rest.slice(removeLength) };
}
function resolveTaskSelection(numbers, tasks, source) {
  const active = tasks.filter(t => !t.archivedAt && (!source || t.status === source));
  const statuses = [...new Set(active.map(t => t.status))];
  const matches = statuses.filter(status => numbers.every(n => active.some(t => t.status === status && String(t.number) === String(n))));
  if (matches.length > 1) return { error: 'Эти номера есть в нескольких столбцах. Уточните исходный столбец, например: «из Предстоит».' };
  if (!matches.length) return { error: 'Не удалось найти все указанные номера в одном столбце. Проверьте номера и укажите исходный столбец.' };
  return { ids: numbers.map(n => active.find(t => t.status === matches[0] && String(t.number) === String(n)).id) };
}
module.exports = { taskReferences, taskReferenceSelection, taskColumnReferences, taskTargetGroup, resolveTaskSelection };
