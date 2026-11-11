'use strict';
(() => {
  const api = window.vsApi, $ = id => document.getElementById(id);
  let state = {}, working = false;
  const button = (text, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn-ghost btn-sm'; b.textContent = text; b.onclick = fn; return b; };
  function describe(payload) {
    if (!payload) return 'Запись удалена';
    const v = payload.value, lines = [];
    for (const [key, label] of [['title', 'Название'], ['name', 'Название'], ['date', 'Дата'], ['from', 'Начало'], ['to', 'Конец'], ['due', 'Срок'], ['note', 'Заметка'], ['comment', 'Комментарий'], ['desc', 'Описание'], ['text', 'Текст']]) if (v[key]) lines.push(label + ': ' + v[key]);
    if (v.updatedAt) lines.push('Изменено: ' + new Date(v.updatedAt).toLocaleString('ru-RU'));
    if (v.messages) lines.push(...v.messages.map(m => (m.role === 'user' ? 'Вы: ' : 'Ассистент: ') + (m.text || m.content || '')));
    if (v.summary) lines.push('Кратко: ' + v.summary.brief, ...(v.summary.points || []));
    if (v.cues) lines.push(...v.cues.map(c => c.start + '–' + c.end + ' с: ' + c.text));
    if (v.columns) lines.push('Столбцы: ' + v.columns.map(c => c.name).join(', '));
    if (v.ops) lines.push('Пометок на снимке: ' + v.ops.length);
    if (v.subtasks) lines.push(...v.subtasks.map(s => (s.done ? '✓ ' : '□ ') + s.title));
    if (v.files) lines.push(...v.files.map(f => 'Вложение: ' + f.name));
    return lines.join('\n\n') || 'Сохранённые параметры записи';
  }
  function paint(next) {
    state = next || state;
    $('cloud-form').hidden = !!state.email; $('cloud-signed').hidden = !state.email;
    $('cloud-who').textContent = state.email ? 'Аккаунт: ' + state.email : '';
    $('cloud-status').textContent = state.error || (state.busy ? 'Синхронизирую… При первом подключении это может занять несколько минут.' : state.email ? (state.lastSync ? 'Последняя проверка: ' + new Date(state.lastSync).toLocaleString('ru-RU') : 'Ожидаю первую синхронизацию…') : 'Вы пока не вошли в аккаунт. Данные хранятся на этом компьютере.');
    document.querySelectorAll('.cloud-card button').forEach(b => { b.disabled = working || !!state.busy; });
    const box = $('cloud-conflicts'); box.replaceChildren();
    for (const conflict of state.conflicts || []) {
      const card = document.createElement('div'); card.className = 'cloud-conflict';
      const title = document.createElement('h3'); title.textContent = 'Две версии: ' + conflict.name;
      const text = document.createElement('p'); text.className = 'set-text'; text.textContent = 'Запись независимо изменили на двух устройствах. Просмотрите обе версии и выберите нужную. Обе сохранятся в отдельном файле восстановления.';
      card.append(title, text);
      for (const [key, label] of [['local', 'На этом компьютере'], ['remote', 'В облаке']]) {
        const details = document.createElement('details'), summary = document.createElement('summary'), pre = document.createElement('pre');
        summary.textContent = label; pre.textContent = describe(conflict[key]); details.append(summary, pre); card.append(details);
      }
      const actions = document.createElement('div'); actions.className = 'cloud-actions';
      actions.append(button('Оставить с этого компьютера', () => action(() => api.cloudResolve(conflict.key, 'local'))), button('Взять из облака', () => action(() => api.cloudResolve(conflict.key, 'remote'))));
      card.append(actions); box.append(card);
    }
  }
  async function action(fn) {
    if (working || state.busy) return;
    working = true; $('cloud-message').textContent = ''; paint();
    try { const r = await fn(); $('cloud-message').textContent = r?.error || r?.message || ''; }
    catch (e) { $('cloud-message').textContent = 'Не получилось. Попробуйте ещё раз.'; }
    finally { working = false; const r = await api.cloudState(); paint(r.state); }
  }
  function auth(command) {
    const form = $('cloud-form'); if (!form.reportValidity()) return;
    const email = $('cloud-email').value.trim(), password = $('cloud-password').value;
    $('cloud-password').value = ''; action(() => api.cloudAuth(command, email, password));
  }
  $('cloud-form').onsubmit = e => { e.preventDefault(); auth('signin'); };
  $('cloud-signup').onclick = () => auth('signup');
  $('cloud-now').onclick = () => action(() => api.cloudSync());
  $('cloud-out').onclick = () => action(() => api.cloudAuth('signout'));
  api.onCloudState(paint); api.cloudState().then(r => paint(r.state));
})();
