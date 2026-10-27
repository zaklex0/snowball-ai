'use strict';
(() => {
  const COPY =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M15 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3"/></svg>';
  const FONT = '"Golos Text", "Segoe UI", sans-serif';
  const measure = document.createElement('canvas').getContext('2d');
  function bounds(o) {
    return {
      x: Math.min(o.a.x, o.b.x),
      y: Math.min(o.a.y, o.b.y),
      w: Math.abs(o.a.x - o.b.x),
      h: Math.abs(o.a.y - o.b.y),
    };
  }
  function wrappedText(text, size, width) {
    measure.font = '600 ' + size + 'px ' + FONT;
    const lines = [];
    for (const paragraph of text.split('\n')) {
      let line = '';
      for (const word of paragraph.split(/(\s+)/)) {
        if (!word) continue;
        if (measure.measureText(line + word).width <= width) {
          line += word;
          continue;
        }
        if (line.trim()) {
          lines.push(line.trimEnd());
          line = '';
        }
        if (!word.trim()) continue;
        for (const letter of word) {
          if (line && measure.measureText(line + letter).width > width) {
            lines.push(line);
            line = '';
          }
          line += letter;
        }
      }
      lines.push(line.trimEnd());
    }
    return lines;
  }
  // Fit text to the selected rectangle, including wrapping and explicit newlines.
  function textLayout(o) {
    const r = bounds(o),
      pad = Math.min(4, r.h * 0.05, r.w * 0.05),
      w = Math.max(0.1, r.w - pad * 2),
      h = Math.max(0.1, r.h - pad * 2);
    let low = 0.1,
      high = h / 1.25;
    for (let i = 0; i < 19; i++) {
      const mid = (low + high) / 2,
        lines = wrappedText(o.text || '', mid, w);
      if (lines.length * mid * 1.25 <= h && lines.every((s) => measure.measureText(s).width <= w))
        low = mid;
      else high = mid;
    }
    return { r, pad, size: low, lines: wrappedText(o.text || '', low, w), lineHeight: low * 1.25 };
  }
  function drawOp(g, o) {
    g.save();
    g.strokeStyle = o.color;
    g.fillStyle = o.color;
    g.lineWidth = o.width;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    if (o.type === 'pen' || o.type === 'marker') {
      if (o.type === 'marker') {
        g.globalAlpha = (o.pressure ?? 35) / 100;
        g.lineWidth = o.width * 5;
      }
      g.beginPath();
      g.moveTo(o.points[0].x, o.points[0].y);
      o.points.slice(1).forEach((p) => g.lineTo(p.x, p.y));
      if (o.points.length === 1) g.lineTo(o.points[0].x + 0.1, o.points[0].y);
      g.stroke();
    } else if (o.type === 'rect') {
      const r = bounds(o);
      g.strokeRect(r.x, r.y, r.w, r.h);
    } else if (o.type === 'text') {
      if (o.text === undefined) {
        const r = bounds(o);
        g.setLineDash([5, 4]);
        g.lineWidth = 1.5;
        g.strokeRect(r.x, r.y, r.w, r.h);
      } else {
        const l = textLayout(o);
        g.beginPath();
        g.rect(l.r.x, l.r.y, l.r.w, l.r.h);
        g.clip();
        g.font = '600 ' + l.size + 'px ' + FONT;
        g.textBaseline = 'alphabetic';
        l.lines.forEach((s, i) =>
          g.fillText(s, l.r.x + l.pad, l.r.y + l.pad + l.size * 0.9 + i * l.lineHeight),
        );
      }
    }
    g.restore();
  }
  // One renderer is shared by the canvas, history thumbnails and clipboard export.
  function paint(g, source, ops, softness, crop = null) {
    const w = source.width,
      h = source.height,
      focus = ops.filter((o) => o.type === 'focus');
    g.clearRect(0, 0, g.canvas.width, g.canvas.height);
    g.save();
    if (crop) g.translate(-crop.x, -crop.y);
    g.save();
    if (focus.length) g.filter = 'blur(' + softness * 0.24 + 'px)';
    g.drawImage(source, 0, 0, w, h);
    g.restore();
    if (focus.length) {
      g.fillStyle = 'rgba(30,40,30,.12)';
      g.fillRect(0, 0, w, h);
      focus.forEach((o) => {
        const r = bounds(o);
        if (!r.w || !r.h) return;
        g.drawImage(source, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
        g.fillStyle = 'rgba(255,231,140,.12)';
        g.fillRect(r.x, r.y, r.w, r.h);
        g.strokeStyle = o.color;
        g.lineWidth = 2;
        g.strokeRect(r.x, r.y, r.w, r.h);
      });
    }
    ops.forEach((o) => drawOp(g, o));
    g.restore();
  }
  const viewOf = (s) => s.crop || { x: 0, y: 0, width: s.width, height: s.height };
  function cropOverlay(g, selection, view) {
    const box = bounds(selection), x = box.x - view.x, y = box.y - view.y;
    g.save();
    g.beginPath();
    g.rect(0, 0, g.canvas.width, g.canvas.height);
    g.rect(x, y, box.w, box.h);
    g.fillStyle = 'rgba(15, 15, 15, .48)';
    g.fill('evenodd');
    g.strokeStyle = '#ffffff';
    g.lineWidth = 2;
    g.setLineDash([7, 5]);
    g.strokeRect(x, y, box.w, box.h);
    g.restore();
  }
  const loadImage = (url) =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(Error('Не удалось открыть исходный снимок.'));
      img.src = url;
    });
  const check = (result) => {
    if (!result?.ok) throw Error(result?.error || 'Не удалось выполнить действие.');
    return result;
  };
  function mount(root, api, initialId) {
    root.classList.add('capture-app');
    root.innerHTML = /* HTML */ `
      <header class="shot-head">
        <div>
          <h1>Снимки</h1>
          <p class="shot-sub">Захват экрана, пометки и ваша история</p>
          <details class="shot-help">
            <summary>Подсказки по захвату</summary>
            <p class="shot-tip">Shift при выделении — квадрат · Правая кнопка — весь экран · Esc — отмена</p>
          </details>
        </div>
        <div class="shot-head-actions">
          <button class="primary shot-capture" data-action="capture" title="Снять область">
            <span class="shot-capture-icon" aria-hidden="true">＋</span>
            <span class="shot-capture-label">Снять область</span>
          </button>
          <button data-action="import">Открыть картинку</button>
          <button data-guide="screenshots">Как пользоваться</button>
          <div class="shot-key"></div>
          <span class="shot-key-state"></span>
        </div>
      </header>
      <div class="shot-layout">
        <aside class="shot-library">
          <strong>
            Мои снимки
            <span class="shot-count">0</span>
          </strong>
          <p>
            Хранятся после перезапуска.
            <br />
            У каждого — своя кнопка копирования.
          </p>
          <div class="shot-list"></div>
        </aside>
        <div class="shot-work">
          <div class="shot-tools" role="toolbar" aria-label="Инструменты редактора">
            <button data-tool="pen" aria-pressed="true">Перо</button>
            <button data-tool="marker" aria-pressed="false">Маркер</button>
            <button data-tool="rect" aria-pressed="false">Рамка</button>
            <button data-tool="focus" aria-pressed="false">Подсветить</button>
            <button data-tool="text" aria-pressed="false">Текст</button>
            <button data-tool="crop" aria-pressed="false">Обрезать</button>
            <div class="shot-undo">
              <button data-action="undo" title="Отменить · Ctrl + Z" aria-label="Отменить пометку">
                ↶
              </button>
              <button
                data-action="redo"
                title="Вернуть · Ctrl + Shift + Z"
                aria-label="Вернуть пометку"
              >
                ↷
              </button>
            </div>
            <div class="shot-status" role="status" aria-live="polite">Снимки и пометки сохраняются автоматически.</div>
          </div>
          <div class="shot-options">
            <label>
              Цвет
              <input class="shot-color" type="color" value="#cf4738" />
            </label>
            <label>
              Толщина
              <input class="shot-width" type="range" min="1" max="30" value="5" />
              <output class="shot-width-out">5</output>
            </label>
            <label class="shot-pressure-label" hidden>
              Нажим
              <input class="shot-pressure" type="range" min="10" max="100" value="35" />
              <output class="shot-pressure-out">35%</output>
            </label>
            <label class="shot-blur-label" hidden>
              Блюр фона
              <input class="shot-blur" type="range" min="0" max="40" value="15" />
              <output class="shot-blur-out">15%</output>
            </label>
            <div class="shot-crop-actions" hidden>
              <button data-action="apply-crop" class="primary">Применить обрезку</button>
              <button data-action="cancel-crop">Отмена</button>
            </div>
            <button data-action="reset-crop" hidden>Вернуть весь снимок</button>
            <span class="shot-size"></span>
            <button data-action="copy" class="primary">Копировать снимок</button>
          </div>
          <div class="shot-stage">
            <p class="shot-empty">
              <span class="shot-empty-key">Нажмите «Снять область».</span>
              <br />
              Выделите участок экрана — здесь откроется редактор.
            </p>
            <canvas hidden aria-label="Снимок: рисуйте выбранным инструментом"></canvas>
          </div>
          <button class="shot-conflict" hidden>Открыть сохранённую версию заново</button>
        </div>
      </div>
    `;
    const $ = (s) => root.querySelector(s),
      canvas = $('canvas'),
      ctx = canvas.getContext('2d'),
      cards = new Map();
    const undoToast = document.createElement('div');
    undoToast.className = 'shot-toast';
    undoToast.hidden = true;
    undoToast.setAttribute('role', 'status');
    undoToast.innerHTML = '<span>Снимок удалён</span><button type="button">Отменить</button>';
    root.append(undoToast);
    let undoTimer = null,
      undoAction = null;
    undoToast.querySelector('button').addEventListener('click', () =>
      run(async () => {
        const action = undoAction;
        if (!action) return;
        undoAction = null;
        clearTimeout(undoTimer);
        undoToast.hidden = true;
        const result = check(await api.captureRestore(action.undo, action.token));
        await refresh();
        await open(result.id);
        status('Снимок восстановлен');
      }),
    );
    let current = null,
      token = null,
      tool = 'pen',
      color = '#cf4738',
      width = 5,
      pressure = 35,
      drawing = null,
      cropSelection = null,
      textEdit = null;
    let timer = null,
      loading = 0,
      opening = false,
      refreshSeq = 0,
      allowClose = false,
      closing = false,
      items = [];
    const status = (s, error = false) => {
      $('.shot-status').textContent = s;
      $('.shot-status').classList.toggle('error', error);
    };
    const fail = (e) => status(e.message || String(e), true);
    const run = (fn) => Promise.resolve().then(fn).catch(fail);
    function theme(t) {
      if (document.documentElement.classList.contains('capture-external'))
        document.documentElement.dataset.theme = t;
    }
    function keyState(r) {
      const keyLabel = window.SnowShortcut.format(r.shortcut);
      $('.shot-empty-key').textContent = 'Нажмите «Снять область» или ' + keyLabel + '.';
      $('.shot-key-state').textContent = r.shortcutActive
        ? keyLabel + ' — работает поверх других окон, пока Snowball открыта'
        : r.shortcutRecording
          ? 'Захват приостановлен на время выбора клавиш.'
          : 'Сочетание занято. Нажмите «Изменить», чтобы выбрать другое.';
      $('.shot-key-state').classList.toggle('error', !r.shortcutActive && !r.shortcutRecording);
      document.querySelectorAll('.capture-nav').forEach((n) => {
        n.querySelector('kbd').textContent = keyLabel;
        n.title = 'Снимки экрана · ' + keyLabel;
      });
      theme(r.theme);
    }
    function fitCanvas() {
      if (canvas.hidden || !canvas.width || !canvas.height) return;
      const stage = $('.shot-stage'), css = getComputedStyle(stage);
      const availableWidth = stage.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
      const availableHeight = stage.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom);
      if (availableWidth < 1 || availableHeight < 1) return;
      const scale = Math.min(availableWidth / canvas.width, availableHeight / canvas.height);
      canvas.style.width = Math.max(1, Math.floor(canvas.width * scale)) + 'px';
      canvas.style.height = Math.max(1, Math.floor(canvas.height * scale)) + 'px';
      positionText();
    }
    function sizeCanvas(s) {
      const view = viewOf(s);
      canvas.width = view.width;
      canvas.height = view.height;
      $('.shot-size').textContent = view.width + ' × ' + view.height;
      fitCanvas();
    }
    function render() {
      canvas.hidden = !current;
      $('.shot-empty').hidden = !!current;
      if (current) {
        paint(
          ctx,
          current.image,
          drawing && drawing.type !== 'crop' ? current.ops.concat(drawing) : current.ops,
          current.blur,
          current.crop,
        );
        const selection = drawing?.type === 'crop' ? drawing : cropSelection;
        if (selection) cropOverlay(ctx, selection, viewOf(current));
      }
      $('[data-action="undo"]').disabled = !current?.ops.length;
      $('[data-action="redo"]').disabled = !current?.redo.length;
      $('[data-action="copy"]').disabled = !current;
      $('.shot-crop-actions').hidden = !current || !cropSelection;
      $('[data-action="reset-crop"]').hidden = !current?.crop;
      $('.shot-pressure-label').hidden = tool !== 'marker';
      $('.shot-blur-label').hidden = tool !== 'focus';
      for (const [id, card] of cards) card.classList.toggle('active', id === current?.id);
    }
    function rendered(s) {
      const c = document.createElement('canvas');
      const view = viewOf(s);
      c.width = view.width;
      c.height = view.height;
      paint(c.getContext('2d'), s.image, s.ops, s.blur, s.crop);
      return c;
    }
    function thumbnail(s) {
      const c = rendered(s),
        thumb = document.createElement('canvas');
      thumb.width = Math.min(280, c.width);
      thumb.height = Math.max(1, Math.round((c.height * thumb.width) / c.width));
      thumb.getContext('2d').drawImage(c, 0, 0, thumb.width, thumb.height);
      return thumb.toDataURL('image/jpeg', 0.75);
    }
    function dirty() {
      if (!current) return;
      current.generation++;
      status('Сохраняю пометки…');
      clearTimeout(timer);
      timer = setTimeout(() => run(() => save(current)), 350);
    }
    // Serialize edits per image. A revision mismatch preserves the unsaved local marks.
    async function save(s) {
      if (!s) return true;
      if (s.pending) return s.pending;
      if (s.saved === s.generation) return true;
      s.pending = (async () => {
        while (s.saved !== s.generation) {
          const generation = s.generation,
            thumb = thumbnail(s);
          const r = check(
            await api.captureSave(s.id, s.token, {
              revision: s.revision,
              ops: s.ops,
              blur: s.blur,
              crop: s.crop,
              thumb,
            }),
          );
          s.revision = r.revision;
          s.saved = generation;
          if (current === s) {
            status('Все пометки сохранены');
            $('.shot-conflict').hidden = true;
          }
        }
        return true;
      })()
        .catch((e) => {
          if (current === s) $('.shot-conflict').hidden = false;
          throw e;
        })
        .finally(() => {
          s.pending = null;
        });
      return s.pending;
    }
    function positionText() {
      if (!textEdit) return;
      const { area, op } = textEdit,
        l = textLayout({ ...op, text: area.value }),
        c = canvas.getBoundingClientRect(),
        s = $('.shot-stage').getBoundingClientRect(),
        scale = c.width / canvas.width;
      const view = viewOf(current);
      Object.assign(area.style, {
        left: c.left - s.left + (l.r.x - view.x) * scale + 'px',
        top: c.top - s.top + (l.r.y - view.y) * scale + 'px',
        width: l.r.w * scale + 'px',
        height: l.r.h * scale + 'px',
        padding: l.pad * scale + 'px',
        fontSize: l.size * scale + 'px',
        lineHeight: l.lineHeight * scale + 'px',
        color: op.color,
      });
    }
    function finishText(cancel = false) {
      if (!textEdit) return;
      const { area, op } = textEdit;
      textEdit = null;
      if (!cancel && area.value.trim()) {
        op.text = area.value;
        current.ops.push(op);
        current.redo = [];
        dirty();
      }
      area.remove();
      render();
    }
    function beginText(op) {
      const r = bounds(op);
      if (r.w < 16 || r.h < 16) {
        status('Для текста выделите прямоугольник чуть больше.');
        return;
      }
      const area = document.createElement('textarea');
      area.className = 'shot-text';
      area.maxLength = 2000;
      area.spellcheck = false;
      area.setAttribute('aria-label', 'Текст в выделенной области');
      textEdit = { area, op };
      $('.shot-stage').append(area);
      positionText();
      area.addEventListener('input', positionText);
      area.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          finishText(true);
        }
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          finishText();
        }
      });
      area.addEventListener('blur', () => finishText());
      area.focus({ preventScroll: true });
      status('Введите текст · Enter — новая строка · Ctrl + Enter — готово · Esc — отмена');
    }
    async function flush() {
      try {
        finishText();
        clearTimeout(timer);
        if (drawing) {
          drawing = null;
          render();
        }
        await save(current);
        return true;
      } catch (e) {
        fail(e);
        return false;
      }
    }
    async function open(id, discard = false) {
      if (!discard && !(await flush())) return;
      const seq = ++loading,
        t = token;
      opening = true;
      try {
        const { item } = check(await api.captureGet(id, t));
        const image = await loadImage(item.url);
        await document.fonts.ready;
        if (seq !== loading || t !== token) return;
        current = { ...item, image, token: t, redo: [], generation: 0, saved: 0, pending: null };
        cropSelection = null;
        sizeCanvas(current);
        $('.shot-blur').value = item.blur;
        $('.shot-blur-out').textContent = item.blur + '%';
        $('.shot-conflict').hidden = true;
        render();
        fitCanvas();
        status(canvas.width + ' × ' + canvas.height + ' · Пометки сохраняются автоматически');
      } finally {
        if (seq === loading) opening = false;
      }
    }
    // Reuse card nodes so background saves cannot interrupt a click or text input.
    async function refresh() {
      const seq = ++refreshSeq,
        r = check(await api.captureList());
      if (seq !== refreshSeq) return;
      if (token && token !== r.token) {
        if (current && current.generation !== current.saved)
          throw Error('Папка изменилась. Сначала завершите правку снимка.');
        current = null;
        loading++;
      }
      token = r.token;
      items = r.items;
      keyState(r);
      $('.shot-count').textContent = items.length;
      const ids = new Set(items.map((s) => s.id));
      if (current && !ids.has(current.id)) {
        current = null;
        drawing = null;
        cropSelection = null;
        loading++;
        opening = false;
      }
      for (const [id, card] of cards)
        if (!ids.has(id)) {
          card.remove();
          cards.delete(id);
        }
      let index = 0;
      for (const s of items) {
        let card = cards.get(s.id);
        if (!card) {
          card = document.createElement('article');
          card.className = 'shot-card';
          card.dataset.id = s.id;
          const button = document.createElement('button');
          button.className = 'shot-open';
          button.innerHTML = '<img alt=""><span></span>';
          button.addEventListener('click', () => run(() => open(s.id)));
          card.append(button);
          const copy = document.createElement('button');
          copy.className = 'shot-copy';
          copy.innerHTML = COPY;
          copy.title = 'Копировать этот снимок';
          copy.setAttribute('aria-label', 'Копировать этот снимок');
          copy.addEventListener('click', () =>
            run(async () => {
              copy.disabled = true;
              try {
                await copyShot(s.id);
              } finally {
                copy.disabled = false;
              }
            }),
          );
          card.append(copy);
          const remove = document.createElement('button');
          remove.className = 'shot-delete';
          remove.textContent = 'Удалить';
          remove.title = 'Удалить в корзину Windows';
          remove.addEventListener('click', () =>
            run(async () => {
              remove.disabled = true;
              try {
                if (!(await flush())) return;
                const t = token,
                  result = check(await api.captureDelete(s.id, t));
                undoAction = { undo: result.undo, token: t };
                clearTimeout(undoTimer);
                undoToast.hidden = false;
                undoTimer = setTimeout(
                  () => {
                    undoToast.hidden = true;
                    undoAction = null;
                  },
                  Math.max(0, result.expires - Date.now()),
                );
                await refresh();
              } finally {
                remove.disabled = false;
              }
            }),
          );
          card.append(remove);
          cards.set(s.id, card);
        }
        const img = card.querySelector('img');
        if (img.getAttribute('src') !== s.thumb) img.src = s.thumb;
        card.querySelector('span').textContent = s.name;
        const before = $('.shot-list').children[index++];
        if (before !== card) $('.shot-list').insertBefore(card, before || null);
      }
      render();
      if (!current && items.length)
        await open(initialId && ids.has(initialId) ? initialId : items[0].id);
      initialId = null;
    }
    async function copyShot(id) {
      if (!(await flush())) return;
      let s = current;
      const t = token;
      if (!s || s.id !== id) {
        const { item } = check(await api.captureGet(id, t));
        s = { ...item, image: await loadImage(item.url) };
      }
      const c = rendered(s),
        blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      if (!blob) throw Error('Не удалось подготовить изображение.');
      check(await api.captureCopy(id, t, new Uint8Array(await blob.arrayBuffer())));
      status('Снимок с пометками скопирован — можно вставить через Ctrl + V');
    }
    const point = (e) => {
      const r = canvas.getBoundingClientRect();
      const view = viewOf(current);
      return {
        x: view.x + Math.max(0, Math.min(canvas.width, ((e.clientX - r.left) * canvas.width) / r.width)),
        y: view.y + Math.max(0, Math.min(canvas.height, ((e.clientY - r.top) * canvas.height) / r.height)),
      };
    };
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !current || opening) return;
      finishText();
      if (tool !== 'crop' && current.ops.length >= 1500) {
        status('На снимке уже много пометок. Скопируйте результат и начните новый снимок.', true);
        return;
      }
      if (tool === 'crop') cropSelection = null;
      const p = point(e);
      drawing = {
        type: tool,
        color,
        width,
        pressure,
        ...(tool === 'pen' || tool === 'marker' ? { points: [p] } : { a: p, b: p }),
      };
      canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
      render();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drawing) return;
      const p = point(e);
      if (drawing.points) {
        if (drawing.points.length < 20000) drawing.points.push(p);
      } else drawing.b = p;
      render();
    });
    canvas.addEventListener('pointerup', (e) => {
      if (!drawing || e.button !== 0) return;
      const op = drawing;
      drawing = null;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      if (op.type === 'crop') {
        if (bounds(op).w >= 12 && bounds(op).h >= 12) {
          cropSelection = op;
          status('Проверьте выделенную область и нажмите «Применить обрезку».');
        } else status('Для обрезки выделите область побольше.', true);
      } else if (op.type === 'text') beginText(op);
      else {
        if (op.points || (bounds(op).w > 1 && bounds(op).h > 1)) {
          current.ops.push(op);
          current.redo = [];
          dirty();
        }
      }
      render();
    });
    canvas.addEventListener('pointercancel', () => {
      drawing = null;
      render();
    });
    root.querySelectorAll('[data-tool]').forEach((b) =>
      b.addEventListener('click', () => {
        finishText();
        tool = b.dataset.tool;
        if (tool !== 'crop') cropSelection = null;
        root
          .querySelectorAll('[data-tool]')
          .forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        render();
        status(
          tool === 'text'
            ? 'Выделите прямоугольник и введите текст — буквы подстроятся под его размер.'
            : tool === 'crop'
              ? 'Выделите область, которую хотите оставить на снимке.'
            : tool === 'marker'
              ? 'Нажим меняет насыщенность маркера: от прозрачного до плотного следа.'
              : 'Рисуйте на снимке. Пометки сохраняются автоматически.',
        );
      }),
    );
    async function changeCrop(next) {
      if (!current || !(await flush())) return;
      current.crop = next;
      cropSelection = null;
      sizeCanvas(current);
      render();
      fitCanvas();
      dirty();
      clearTimeout(timer);
      await save(current);
      status(next ? 'Снимок обрезан до ' + next.width + ' × ' + next.height + '. Исходник сохранён.' : 'Показан весь исходный снимок.');
    }
    $('[data-action="apply-crop"]').addEventListener('click', () =>
      run(async () => {
        if (!cropSelection || !current) return;
        const selected = bounds(cropSelection), view = viewOf(current);
        const x = Math.max(view.x, Math.floor(selected.x));
        const y = Math.max(view.y, Math.floor(selected.y));
        const right = Math.min(view.x + view.width, Math.ceil(selected.x + selected.w));
        const bottom = Math.min(view.y + view.height, Math.ceil(selected.y + selected.h));
        if (right - x < 2 || bottom - y < 2) throw Error('Для обрезки выделите область побольше.');
        await changeCrop({ x, y, width: right - x, height: bottom - y });
      }),
    );
    $('[data-action="cancel-crop"]').addEventListener('click', () => {
      cropSelection = null;
      render();
      status('Обрезка отменена.');
    });
    $('[data-action="reset-crop"]').addEventListener('click', () => run(() => changeCrop(null)));
    $('.shot-color').addEventListener('input', (e) => {
      color = e.target.value;
    });
    $('.shot-width').addEventListener('input', (e) => {
      width = +e.target.value;
      $('.shot-width-out').textContent = width;
    });
    $('.shot-pressure').addEventListener('input', (e) => {
      pressure = +e.target.value;
      $('.shot-pressure-out').textContent = pressure + '%';
    });
    $('.shot-blur').addEventListener('input', (e) => {
      $('.shot-blur-out').textContent = e.target.value + '%';
      if (current) {
        current.blur = +e.target.value;
        render();
        dirty();
      }
    });
    window.SnowShortcut.mount($('.shot-key'), api);
    function undo(redo) {
      finishText();
      if (!current) return;
      const from = redo ? current.redo : current.ops,
        to = redo ? current.ops : current.redo;
      if (from.length) {
        to.push(from.pop());
        dirty();
        render();
      }
    }
    $('[data-action="undo"]').addEventListener('click', () => undo(false));
    $('[data-action="redo"]').addEventListener('click', () => undo(true));
    $('[data-action="copy"]').addEventListener('click', () =>
      run(() => current && copyShot(current.id)),
    );
    $('[data-action="capture"]').addEventListener('click', () =>
      run(async () => {
        if (await flush()) check(await api.captureStart());
      }),
    );
    $('[data-action="import"]').addEventListener('click', () =>
      run(async () => {
        if (!(await flush())) return;
        const r = check(await api.captureImport());
        if (r.id) {
          await refresh();
          await open(r.id);
        }
      }),
    );
    if (document.documentElement.classList.contains('capture-external'))
      $('[data-guide]').addEventListener('click', () => run(() => api.captureGuide()));
    $('.shot-conflict').addEventListener('click', () =>
      run(async () => {
        if (current && window.confirm('Заменить несохранённые пометки версией с диска?'))
          await open(current.id, true);
      }),
    );
    root.addEventListener('keydown', (e) => {
      if (e.target.matches('textarea,input,select')) return;
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
        e.preventDefault();
        e.stopPropagation();
        undo(e.shiftKey);
      }
    });
    window.addEventListener('resize', fitCanvas);
    new ResizeObserver(fitCanvas).observe($('.shot-stage'));
    window.addEventListener('beforeunload', (e) => {
      if (allowClose || (!textEdit && (!current || current.generation === current.saved))) return;
      e.preventDefault();
      e.returnValue = false;
      if (!closing) {
        closing = true;
        flush().then((ok) => {
          closing = false;
          if (ok) {
            allowClose = true;
            window.close();
          }
        });
      }
    });
    api.onCaptureChanged(() => run(refresh));
    api.onCaptureTheme(theme);
    api.onCaptureOpen((id) =>
      run(async () => {
        await refresh();
        await open(id);
      }),
    );
    render();
    run(refresh);
    return { flush, refresh, open };
  }
  window.SnowCapture = { mount, textLayout, paint };
})();
