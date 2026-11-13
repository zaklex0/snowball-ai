'use strict';

// Read explicit task references only: dates, times and title digits are not task numbers.
function taskReferences(text) {
  const pattern = /(?:задач[ауеиой]*\s*(?:(?:под\s+)?номер(?:ом|а)?\s*|[№#]\s*)?|номер(?:ом|а)?\s*|[№#]\s*)(\d+(?:\.\d+)*)(?![\dа-яёa-z])/giu;
  return [...new Set(Array.from(String(text || '').matchAll(pattern), (m) => m[1].includes('.') ? m[1] : Number(m[1])))];
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
module.exports = { taskReferences, taskColumnReferences };
