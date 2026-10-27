// Shared validation: the renderer and the main process accept exactly the same accelerators.
(function (root) {
  'use strict';
  const special = {
    Space: 'Space',
    Tab: 'Tab',
    Enter: 'Enter',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Insert: 'Insert',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    PrintScreen: 'PrintScreen',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Backquote: '`',
  };
  const ordinary = new Set(Object.values(special));
  const reserved = new Set('T W Tab K N C V X Z A S Y F P'.split(' ').map((k) => 'Control+' + k));
  reserved.add('Control+Shift+Tab');
  function normalize(value) {
    if (typeof value !== 'string') throw Error('Нажмите сочетание клавиш.');
    const parts = value.split('+');
    if (parts.some((p) => /^(Meta|Super|Win|Command|Cmd)$/i.test(p)))
      throw Error('Клавишу Win использовать нельзя.');
    const modifiers = parts.filter((p) => ['Control', 'Alt', 'Shift'].includes(p));
    const keys = parts.filter((p) => !modifiers.includes(p));
    if (new Set(parts).size !== parts.length || keys.length !== 1)
      throw Error('Нужна ровно одна обычная клавиша вместе с Ctrl или Alt.');
    const key = keys[0];
    if (!/^[A-Z0-9]$/.test(key) && !/^F([1-9]|1[0-9]|2[0-4])$/.test(key) && !ordinary.has(key))
      throw Error('Эта клавиша не поддерживается. Выберите другую.');
    const shiftSpecial =
      modifiers.includes('Shift') &&
      (/^F\d+$/.test(key) ||
        [
          'Up',
          'Down',
          'Left',
          'Right',
          'Home',
          'End',
          'PageUp',
          'PageDown',
          'PrintScreen',
        ].includes(key));
    if (
      !(key === 'PrintScreen' && !modifiers.length) &&
      !shiftSpecial &&
      !modifiers.some((m) => m === 'Control' || m === 'Alt')
    )
      throw Error('Добавьте Ctrl или Alt. Одного Shift недостаточно.');
    const result = ['Control', 'Alt', 'Shift']
      .filter((m) => modifiers.includes(m))
      .concat(key)
      .join('+');
    if (reserved.has(result))
      throw Error('Это сочетание используется в программе или для работы с текстом.');
    return result;
  }
  function fromEvent(e) {
    if (e.metaKey || /^Meta/.test(e.code)) throw Error('Клавишу Win использовать нельзя.');
    if (/^(Control|Alt|Shift)(Left|Right)$/.test(e.code)) return null;
    const key = /^Key[A-Z]$/.test(e.code)
      ? e.code.slice(3)
      : /^Digit[0-9]$/.test(e.code)
        ? e.code.slice(5)
        : /^F\d+$/.test(e.code)
          ? e.code
          : special[e.code];
    if (!key) throw Error('Эта клавиша не поддерживается. Выберите другую.');
    return normalize(
      [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', key]
        .filter(Boolean)
        .join('+'),
    );
  }
  const format = (value) =>
    (value || 'Alt+Z')
      .split('+')
      .map((p) => (p === 'Control' ? 'Ctrl' : p === 'PrintScreen' ? 'Print Screen' : p))
      .join(' + ');
  const warning = (value) =>
    value.includes('PrintScreen')
      ? 'В Windows 11 клавиша Print Screen может открывать «Ножницы».'
      : '';
  const shared = { normalize, fromEvent, format, warning };
  if (typeof module !== 'undefined') {
    module.exports = shared;
    return;
  }
  root.SnowShortcut = shared;
  let active = null;
  shared.mount = function (host, api) {
    host.classList.add('capture-shortcut-control');
    host.innerHTML = `<span class="capture-shortcut-label">Сочетание для снимка</span>
      <div class="capture-shortcut-row"><output aria-live="polite" class="capture-shortcut-value">Alt + Z</output>
      <button type="button" class="capture-shortcut-change">Изменить</button>
      <button type="button" class="capture-shortcut-reset">Сбросить на Alt + Z</button></div>
      <p class="capture-shortcut-message" role="status"></p>`;
    const field = host.querySelector('output'),
      change = host.querySelector('.capture-shortcut-change'),
      reset = host.querySelector('.capture-shortcut-reset'),
      message = host.querySelector('p');
    if (!host.closest('.capture-app')) {
      change.classList.add('btn', 'btn-ghost');
      reset.classList.add('btn', 'btn-ghost');
    }
    let key = 'Alt+Z',
      recording = false,
      pending = false,
      candidate = null,
      held = new Set(),
      invalid = false;
    const show = (text, error = false) => {
      message.textContent = text;
      message.classList.toggle('error', error);
    };
    const update = (value) => {
      key = value.shortcut;
      if (!recording) field.textContent = format(key);
      if (recording && !value.shortcutRecording) finish();
    };
    function finish() {
      recording = false;
      candidate = null;
      held.clear();
      invalid = false;
      if (active === cancel) active = null;
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
      window.removeEventListener('blur', cancel);
      field.textContent = format(key);
      change.textContent = 'Изменить';
      reset.disabled = false;
    }
    async function cancel() {
      if (!recording) return;
      finish();
      const r = await api.captureRecording(false);
      if (r.ok) update(r);
      show(r.ok ? 'Изменение отменено.' : r.error, !r.ok);
    }
    async function save(value) {
      if (pending) return;
      pending = true;
      change.disabled = reset.disabled = true;
      try {
        const r = await api.captureShortcut(value);
        finish();
        if (r.ok) {
          update(r);
          show(warning(key) || 'Сочетание сохранено.');
        } else show(r.error, true);
      } finally {
        pending = false;
        change.disabled = reset.disabled = false;
      }
    }
    // Capture before the app's shortcuts. Commit on release so two held ordinary keys are rejected.
    function down(e) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.code === 'Escape') {
        cancel();
        return;
      }
      if (e.repeat) return;
      if (!/^(Control|Alt|Shift)(Left|Right)$/.test(e.code)) held.add(e.code);
      try {
        if (held.size > 1) throw Error('Нажмите только одну обычную клавишу.');
        const value = fromEvent(e);
        if (value && !invalid) {
          candidate = { value, code: e.code };
          field.textContent = format(value);
        }
      } catch (err) {
        invalid = true;
        candidate = null;
        show(err.message, true);
      }
    }
    function up(e) {
      e.preventDefault();
      e.stopImmediatePropagation();
      held.delete(e.code);
      // Windows can deliver Print Screen only on release.
      if (e.code === 'PrintScreen' && !candidate && !invalid && !held.size) {
        try {
          save(fromEvent(e));
        } catch (err) {
          show(err.message, true);
        }
        return;
      }
      if (candidate && candidate.code === e.code && !invalid) {
        const value = candidate.value;
        candidate = null;
        save(value);
      } else if (!held.size && invalid) {
        invalid = false;
        field.textContent = 'Нажмите сочетание… (Esc — отмена)';
      }
    }
    change.addEventListener('click', async () => {
      if (recording) {
        await cancel();
        return;
      }
      if (active) await active();
      change.disabled = true;
      const r = await api.captureRecording(true);
      change.disabled = false;
      if (!r.ok) {
        show(r.error, true);
        return;
      }
      update(r);
      recording = true;
      active = cancel;
      reset.disabled = true;
      field.textContent = 'Нажмите сочетание… (Esc — отмена)';
      change.textContent = 'Отмена';
      show('Нажмите Ctrl или Alt и одну клавишу, затем отпустите.');
      window.addEventListener('keydown', down, true);
      window.addEventListener('keyup', up, true);
      window.addEventListener('blur', cancel);
    });
    reset.addEventListener('click', () => save('Alt+Z'));
    api.onCaptureChanged(update);
    api.captureState().then((r) => {
      if (r.ok) {
        update(r);
        show(warning(key));
      }
    });
    // Closing Settings or switching tabs must not leave the global shortcut suspended.
    new MutationObserver(() => {
      if (recording && !host.getClientRects().length) cancel();
    }).observe(document.body, {
      attributes: true,
      subtree: true,
      attributeFilter: ['hidden', 'open'],
    });
    return { update, cancel };
  };
})(typeof window !== 'undefined' ? window : globalThis);
