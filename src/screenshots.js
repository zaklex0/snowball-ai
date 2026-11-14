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
  const ERASER_SCALE = 3;
  const LAYER_NAMES = { pen: 'Перо', marker: 'Маркер', eraser: 'Ластик', rect: 'Рамка', focus: 'Подсветка', text: 'Текст' };
  function layerBounds(o) {
    if (!o.points) return bounds(o);
    const xs = o.points.map((p) => p.x), ys = o.points.map((p) => p.y);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }
  function hitLayer(o, p, tolerance) {
    const r = layerBounds(o);
    const stroke = o.width * (o.type === 'marker' ? 5 : o.type === 'eraser' ? ERASER_SCALE : 1);
    const t = tolerance + stroke / 2;
    if (p.x < r.x - t || p.x > r.x + r.w + t || p.y < r.y - t || p.y > r.y + r.h + t) return false;
    if (!o.points) return o.type !== 'rect' ||
      Math.min(Math.abs(p.x - r.x), Math.abs(p.x - r.x - r.w), Math.abs(p.y - r.y), Math.abs(p.y - r.y - r.h)) <= t;
    return o.points.some((b, i) => {
      const a = o.points[Math.max(0, i - 1)], dx = b.x - a.x, dy = b.y - a.y;
      const at = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
      return Math.hypot(p.x - a.x - at * dx, p.y - a.y - at * dy) <= t;
    });
  }
  function drawOp(g, o) {
    g.save();
    g.strokeStyle = o.color;
    g.fillStyle = o.color;
    g.lineWidth = o.width;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    if (o.type === 'pen' || o.type === 'marker' || o.type === 'eraser') {
      if (o.type === 'eraser') {
        // The eraser takes away marks only; the picture underneath stays (see paint).
        g.globalCompositeOperation = 'destination-out';
        g.lineWidth = o.width * ERASER_SCALE;
      }
      if (o.type === 'marker') {
        g.globalAlpha = (o.pressure ?? 35) / 100;
        g.lineWidth = o.width * 5;
      }
      g.beginPath();
      g.moveTo(o.points[0].x, o.points[0].y);
      o.points.slice(1).forEach((p) => g.lineTo(p.x, p.y));
      if (o.points.length === 1) g.lineTo(o.points[0].x + 0.1, o.points[0].y);
      g.stroke();
    } else if (o.type === 'rect' || o.type === 'focus') {
      const r = bounds(o);
      if (o.type === 'focus') g.lineWidth = 2;
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
    ops = ops.filter((o) => !o.hidden);
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
      });
    }
    if (ops.some((o) => o.type === 'eraser')) {
      // Marks go onto their own layer so the eraser can rub them out without touching the picture.
      const layer = document.createElement('canvas');
      layer.width = w;
      layer.height = h;
      const lg = layer.getContext('2d');
      ops.forEach((o) => drawOp(lg, o));
      g.drawImage(layer, 0, 0);
    } else ops.forEach((o) => drawOp(g, o));
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
    // No header: the capture buttons stand above the history, so the editor starts at the top of the window.
    root.innerHTML = /* HTML */ `
      <div class="shot-layout">
        <aside class="shot-library">
          <div class="shot-actions">
            <button class="primary shot-capture" data-action="capture" title="Снять область">
              <span class="shot-capture-icon" aria-hidden="true">＋</span>
              <span class="shot-capture-label">Снять область</span>
            </button>
            <button data-action="import">Открыть картинку</button>
            <button data-action="llm" title="Новый разговор в LLM, где этот снимок уже приложен">Отправить в LLM</button>
            <div class="shot-pop-wrap">
              <button class="shot-key-btn" data-pop="key" aria-expanded="false" title="Сочетание для снимка">
                <span>Клавиши</span>
                <kbd class="shot-key-value">Alt + Z</kbd>
              </button>
              <div class="shot-pop shot-key-pop" data-pop-body="key" hidden>
                <div class="shot-key"></div>
                <p class="shot-key-state"></p>
              </div>
            </div>
          </div>
          <strong class="shot-library-title">
            Мои снимки
            <span class="shot-count">0</span>
          </strong>
          <p class="shot-library-warning" role="status" hidden></p>
          <div class="shot-list"></div>
        </aside>
        <div class="shot-work">
          <div class="shot-bar">
          <div class="shot-tools" role="toolbar" aria-label="Инструменты редактора">
            <button data-tool="select" aria-pressed="false" title="Выбрать и переместить слой">Выбрать</button>
            <button data-tool="pen" aria-pressed="true">Перо</button>
            <button data-tool="marker" aria-pressed="false">Маркер</button>
            <button data-tool="eraser" aria-pressed="false" title="Стереть пометки (картинка остаётся)">Ластик</button>
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
          </div>
          <div class="shot-status" role="status" aria-live="polite">Снимки и пометки сохраняются автоматически.</div>
          <div class="shot-pop-wrap">
            <button class="shot-help-btn" data-pop="help" aria-expanded="false" title="Подсказки и инструкция" aria-label="Подсказки и инструкция">?</button>
            <div class="shot-pop shot-help-pop" data-pop-body="help" hidden>
              <p class="shot-tip">Потяните мышью — область · Shift — квадрат · Правая кнопка — весь экран · Esc — отмена</p>
              <button data-guide="screenshots">Как пользоваться</button>
            </div>
          </div>
          <div class="shot-image-actions">
            <button data-action="copy" class="primary">Копировать снимок</button>
            <button data-action="export" class="primary">Сохранить как</button>
          </div>
          </div>
          <div class="shot-editor-body">
          <div class="shot-stage">
            <p class="shot-empty">
              <span class="shot-empty-key">Нажмите «Снять область».</span>
              <br />
              Выделите участок экрана — здесь откроется редактор.
            </p>
            <canvas hidden aria-label="Снимок: рисуйте выбранным инструментом"></canvas>
            <div class="shot-brush-preview" hidden aria-hidden="true"></div>
          </div>
          <aside class="shot-layers" aria-label="Слои снимка">
            <div class="shot-layer-head"><strong>Слои <span class="shot-layer-count">0</span></strong><p class="shot-layer-image"></p></div>
            <div class="shot-layer-list" role="group" aria-label="Пометки снимка"></div>
            <p class="shot-layer-original">▧ Исходное изображение · 🔒</p>
            <div class="shot-layer-properties">
              <strong class="shot-layer-title">Выберите слой</strong>
              <p class="shot-layer-hint">Нажмите на пометку в списке или выберите её на снимке инструментом «Выбрать».</p>
              <div class="shot-layer-fields" hidden>
                <label class="shot-layer-text-label" hidden>Текст<textarea class="shot-layer-text" maxlength="2000" rows="3"></textarea></label>
                <label>Цвет<input class="shot-layer-color" type="color" /></label>
                <label class="shot-layer-width-label">Толщина<input class="shot-layer-width" type="range" min="1" max="50" /><output class="shot-layer-width-out"></output></label>
                <label class="shot-layer-pressure-label" hidden>Нажим<input class="shot-layer-pressure" type="range" min="10" max="100" /><output class="shot-layer-pressure-out"></output></label>
                <label class="shot-layer-blur-label" hidden title="Общий блюр фона для всех областей подсветки">Блюр фона<input class="shot-layer-blur" type="range" min="0" max="40" /><output class="shot-layer-blur-out"></output></label>
                <div class="shot-layer-order"><button data-layer-action="up">↑ Выше</button><button data-layer-action="down">↓ Ниже</button></div>
                <button class="shot-layer-remove" data-layer-action="remove">Удалить слой</button>
              </div>
            </div>
          </aside>
          </div>
          <div class="shot-recovery" hidden>
            <button class="shot-recover">Сохранить снимок с пометками как файл…</button>
            <button class="shot-conflict">Открыть сохранённую версию заново</button>
          </div>
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
        const button = undoToast.querySelector('button');
        button.disabled = true;
        try {
          const result = check(await api.captureRestore(action.undo, action.token));
          undoAction = null;
          clearTimeout(undoTimer);
          undoToast.hidden = true;
          await refresh();
          await open(result.id);
          status('Снимок восстановлен');
        } finally { button.disabled = false; }
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
      textEdit = null,
      previewPoint = { x: 0.5, y: 0.5 },
      overCanvas = false,
      sizing = null;
    let selectedNumber = null, moving = null, layerListKey = '';
    let timer = null,
      loading = 0,
      opening = false,
      refreshSeq = 0,
      allowClose = false,
      closing = false,
      recordingKey = false,
      items = [];
    const status = (s, error = false) => {
      $('.shot-status').textContent = s;
      $('.shot-status').classList.toggle('error', error);
    };
    const fail = (e) => status(e.message || String(e), true);
    const run = (fn) => Promise.resolve().then(fn).catch(fail);
    // The macOS theme comes as "macos:<accent>".
    function theme(t) {
      if (!document.documentElement.classList.contains('capture-external')) return;
      const [name, accent] = String(t || 'system').split(':');
      document.documentElement.dataset.theme = name;
      if (accent) document.documentElement.dataset.accent = accent;
      else delete document.documentElement.dataset.accent;
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
      // The folded «Клавиши» button shows the key, and a warning mark when the key does not work.
      $('.shot-key-value').textContent = keyLabel;
      $('.shot-key-btn').classList.toggle('error', !r.shortcutActive && !r.shortcutRecording);
      recordingKey = !!r.shortcutRecording;
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
      // Fits the free space, but never above the real size: a small picture enlarged would get blurry.
      const scale = Math.min(availableWidth / canvas.width, availableHeight / canvas.height, 1);
      canvas.style.width = Math.max(1, Math.floor(canvas.width * scale)) + 'px';
      canvas.style.height = Math.max(1, Math.floor(canvas.height * scale)) + 'px';
      positionText();
      updateBrushPreview();
    }
    // The stroke footprint at the canvas zoom: under the pointer while it is over the picture,
    // and in the middle for a second after the size or pressure slider moves.
    function updateBrushPreview() {
      const preview = $('.shot-brush-preview');
      const active =
        current && !canvas.hidden && (tool === 'pen' || tool === 'marker' || tool === 'eraser') && (overCanvas || !!sizing);
      preview.hidden = !active;
      if (!active) return;
      const canvasRect = canvas.getBoundingClientRect();
      const stageRect = $('.shot-stage').getBoundingClientRect();
      const stroke = width * (tool === 'marker' ? 5 : tool === 'eraser' ? ERASER_SCALE : 1);
      const diameter = stroke * canvasRect.width / canvas.width;
      preview.style.width = diameter + 'px';
      preview.style.height = diameter + 'px';
      preview.style.left = canvasRect.left - stageRect.left + previewPoint.x * canvasRect.width + 'px';
      preview.style.top = canvasRect.top - stageRect.top + previewPoint.y * canvasRect.height + 'px';
      preview.style.setProperty('--brush-preview-color', tool === 'eraser' ? '#8a8a8a' : color);
      preview.style.setProperty('--brush-preview-alpha', tool === 'marker' ? pressure + '%' : '18%');
    }
    function moveBrushPreview(e) {
      const rect = canvas.getBoundingClientRect();
      previewPoint = {
        x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
        y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
      };
      updateBrushPreview();
    }
    function showSizing() {
      if (!overCanvas) previewPoint = { x: 0.5, y: 0.5 };
      clearTimeout(sizing);
      sizing = setTimeout(() => {
        sizing = null;
        updateBrushPreview();
      }, 1000);
      updateBrushPreview();
    }
    function sizeCanvas(s) {
      const view = viewOf(s);
      canvas.width = view.width;
      canvas.height = view.height;
      previewPoint = { x: 0.5, y: 0.5 };
      // The size is in the save status of the toolbar (one line, no separate label).
      $('.shot-status').title = view.width + ' × ' + view.height;
      fitCanvas();
    }
    const selectedLayer = () => current?.ops.find((o) => o.number === selectedNumber);
    // History contains complete edit states: moving, hiding and changing a layer can all be undone.
    const snapshot = () => structuredClone({ ops: current.ops, crop: current.crop, blur: current.blur, selectedNumber });
    function remember() {
      if (!current) return;
      current.undo.push(snapshot());
      if (current.undo.length > 60) current.undo.shift();
      current.redo = [];
    }
    function addLayer(op) {
      remember();
      op.number = current.nextLayerNumber++;
      op.hidden = false;
      current.ops.push(op);
      selectedNumber = op.number;
      dirty();
    }
    function selectLayer(number) {
      finishText();
      selectedNumber = number;
      tool = 'select';
      cropSelection = null;
      root.querySelectorAll('[data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === tool)));
      render();
      $('.shot-layer-list [data-layer-pick="' + number + '"]')?.scrollIntoView({ block: 'nearest' });
    }
    function renderLayers() {
      const ops = current?.ops || [], selected = selectedLayer();
      $('.shot-layer-count').textContent = ops.length;
      $('.shot-layer-image').textContent = current?.name || 'Откройте или сделайте снимок';
      const key = JSON.stringify([current?.id, selectedNumber, ops.map((o) => [o.number, o.type, o.hidden, o.color, o.text])]);
      if (key !== layerListKey) {
        layerListKey = key;
        const list = $('.shot-layer-list'), scroll = list.scrollTop;
        list.replaceChildren();
        for (const o of [...ops].reverse()) {
          const row = document.createElement('div');
          row.className = 'shot-layer' + (o === selected ? ' selected' : '') + (o.hidden ? ' is-hidden' : '');
          const eye = document.createElement('button');
          eye.className = 'shot-layer-eye';
          eye.dataset.layerEye = o.number;
          eye.textContent = o.hidden ? '○' : '◉';
          eye.title = (o.hidden ? 'Показать' : 'Скрыть') + ' слой № ' + o.number;
          eye.setAttribute('aria-label', eye.title);
          eye.setAttribute('aria-pressed', String(!o.hidden));
          const pick = document.createElement('button');
          pick.className = 'shot-layer-pick';
          pick.dataset.layerPick = o.number;
          pick.setAttribute('aria-pressed', String(o === selected));
          const swatch = document.createElement('span');
          swatch.className = 'shot-layer-swatch';
          swatch.style.backgroundColor = o.type === 'eraser' ? 'transparent' : o.color;
          const label = document.createElement('span');
          label.textContent = '№ ' + o.number + ' · ' + (o.type === 'text' ? o.text || 'Текст' : LAYER_NAMES[o.type]);
          pick.title = label.textContent;
          pick.append(swatch, label);
          row.append(eye, pick);
          list.append(row);
        }
        if (!ops.length) {
          const empty = document.createElement('p');
          empty.className = 'shot-layer-empty';
          empty.textContent = 'Каждая новая пометка появится здесь отдельным слоем.';
          list.append(empty);
        }
        list.scrollTop = scroll;
      }
      $('.shot-layer-fields').hidden = !selected;
      $('.shot-layer-hint').hidden = !!selected;
      $('.shot-layer-title').textContent = selected ? 'Слой № ' + selected.number + (selected.hidden ? ' · скрыт' : '') : 'Выберите слой';
      if (!selected) return;
      for (const [field, value] of [['color', selected.color], ['width', selected.width], ['pressure', selected.pressure], ['text', selected.text || '']]) {
        const input = $('.shot-layer-' + field);
        if (document.activeElement !== input) input.value = value;
      }
      $('.shot-layer-text-label').hidden = selected.type !== 'text';
      $('.shot-layer-width-label').hidden = ['text', 'focus'].includes(selected.type);
      $('.shot-layer-color').disabled = selected.type === 'eraser';
      $('.shot-layer-pressure-label').hidden = selected.type !== 'marker';
      $('.shot-layer-blur-label').hidden = selected.type !== 'focus';
      if (document.activeElement !== $('.shot-layer-blur')) $('.shot-layer-blur').value = current.blur;
      $('.shot-layer-blur-out').textContent = current.blur + '%';
      $('.shot-layer-width-out').textContent = selected.width;
      $('.shot-layer-pressure-out').textContent = selected.pressure + '%';
      const index = ops.indexOf(selected);
      $('[data-layer-action="up"]').disabled = index === ops.length - 1;
      $('[data-layer-action="down"]').disabled = index === 0;
    }
    function render() {
      canvas.hidden = !current;
      $('.shot-empty').hidden = !!current;
      if (current) {
        paint(
          ctx,
          current.image,
          moving ? current.ops.map((o) => o.number === selectedNumber ? moving.op : o) :
            drawing && drawing.type !== 'crop' ? current.ops.concat(drawing) : current.ops,
          current.blur,
          current.crop,
        );
        const selection = drawing?.type === 'crop' ? drawing : cropSelection;
        if (selection) cropOverlay(ctx, selection, viewOf(current));
        const selected = moving?.op || selectedLayer();
        if (tool === 'select' && selected && !selected.hidden) {
          const r = layerBounds(selected), view = viewOf(current);
          const scale = canvas.getBoundingClientRect().width / canvas.width || 1, pad = 4 / scale;
          ctx.save();
          ctx.lineWidth = 1 / scale;
          ctx.strokeStyle = '#ffffff';
          ctx.strokeRect(r.x - view.x - pad, r.y - view.y - pad, r.w + pad * 2, r.h + pad * 2);
          ctx.strokeStyle = '#285dce';
          ctx.setLineDash([5 / scale, 4 / scale]);
          ctx.strokeRect(r.x - view.x - pad, r.y - view.y - pad, r.w + pad * 2, r.h + pad * 2);
          ctx.restore();
        }
      }
      $('[data-action="undo"]').disabled = !current || (!current.undo.length && !current.ops.length);
      $('[data-action="redo"]').disabled = !current?.redo.length;
      $('[data-action="copy"]').disabled = !current;
      $('[data-action="export"]').disabled = !current;
      $('[data-action="llm"]').disabled = !current;
      $('.shot-crop-actions').hidden = !current || !cropSelection;
      $('[data-action="reset-crop"]').hidden = !current?.crop;
      $('.shot-pressure-label').hidden = tool !== 'marker';
      $('.shot-blur-label').hidden = tool !== 'focus';
      canvas.style.cursor = tool === 'select' ? moving ? 'grabbing' : 'default' : 'crosshair';
      renderLayers();
      updateBrushPreview();
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
              nextLayerNumber: s.nextLayerNumber,
              blur: s.blur,
              crop: s.crop,
              thumb,
            }),
          );
          s.revision = r.revision;
          s.saved = generation;
          if (current === s) {
            status('Все пометки сохранены');
            $('.shot-recovery').hidden = true;
          }
        }
        return true;
      })()
        .catch((e) => {
          if (current === s) $('.shot-recovery').hidden = false;
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
        addLayer(op);
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
        finishMove();
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
        current = { ...item, image, token: t, undo: [], redo: [], generation: 0, saved: 0, pending: null };
        selectedNumber = null;
        moving = null;
        cropSelection = null;
        sizeCanvas(current);
        $('.shot-blur').value = item.blur;
        $('.shot-blur-out').textContent = item.blur + '%';
        $('.shot-recovery').hidden = true;
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
        if (current && (current.generation !== current.saved || textEdit)) {
          $('.shot-recovery').hidden = false;
          throw Error('Папка изменилась. Сначала завершите правку снимка.');
        }
        current = null;
        loading++;
      }
      token = r.token;
      items = r.items;
      keyState(r);
      $('.shot-count').textContent = items.length;
      const warning = $('.shot-library-warning');
      warning.hidden = !r.broken;
      warning.textContent = r.broken ? 'Некоторые снимки не удалось прочитать. Проверьте папку «Снимки» в папке данных.' : '';
      const ids = new Set(items.map((s) => s.id));
      if (current && !ids.has(current.id)) {
        if (current.generation !== current.saved || textEdit) {
          $('.shot-recovery').hidden = false;
          throw Error('Снимок недоступен. Несохранённые пометки оставлены на экране.');
        }
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
          button.innerHTML = '<img alt=""><span></span><small class="shot-card-layers"></small>';
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
        card.querySelector('.shot-card-layers').textContent = s.layerCount ? 'Слоёв: ' + s.layerCount : '';
        const before = $('.shot-list').children[index++];
        if (before !== card) $('.shot-list').insertBefore(card, before || null);
      }
      render();
      if (!current && items.length)
        await open(initialId && ids.has(initialId) ? initialId : items[0].id);
      initialId = null;
    }
    // The picture as it looks now: with the marks and the crop, as PNG bytes. Null if the marks could not be saved.
    async function shotPng(id) {
      if (!(await flush())) return null;
      let s = current;
      const t = token;
      if (!s || s.id !== id) {
        const { item } = check(await api.captureGet(id, t));
        s = { ...item, image: await loadImage(item.url) };
      }
      const c = rendered(s),
        blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      if (!blob) throw Error('Не удалось подготовить изображение.');
      return { t, bytes: new Uint8Array(await blob.arrayBuffer()) };
    }
    async function copyShot(id) {
      const png = await shotPng(id);
      if (!png) return;
      check(await api.captureCopy(id, png.t, png.bytes));
      status('Снимок с пометками скопирован — можно вставить через Ctrl + V');
    }
    async function exportShot(id) {
      const png = await shotPng(id);
      if (!png) return;
      const result = check(await api.captureExport(id, png.t, png.bytes));
      if (!result.canceled) status('Снимок сохранён.');
    }
    // «Отправить снимок в LLM»: the main window opens a new LLM tab with this picture attached to the message box.
    async function sendToLlm(id) {
      const png = await shotPng(id);
      if (!png) return;
      check(await api.captureToLlm(id, png.t, png.bytes));
      status('Снимок отправлен в новый разговор LLM — напишите вопрос и нажмите Enter');
    }
    const point = (e) => {
      const r = canvas.getBoundingClientRect();
      const view = viewOf(current);
      return {
        x: view.x + Math.max(0, Math.min(canvas.width, ((e.clientX - r.left) * canvas.width) / r.width)),
        y: view.y + Math.max(0, Math.min(canvas.height, ((e.clientY - r.top) * canvas.height) / r.height)),
      };
    };
    function finishMove(cancel = false) {
      if (!moving) return;
      const move = moving;
      moving = null;
      if (!cancel && move.changed && current) {
        remember();
        const index = current.ops.findIndex((o) => o.number === selectedNumber);
        if (index >= 0) current.ops[index] = move.op;
        dirty();
      }
      render();
    }
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !current || opening) return;
      moveBrushPreview(e);
      finishText();
      if (tool === 'select') {
        const p = point(e), tolerance = 6 * canvas.width / canvas.getBoundingClientRect().width;
        const op = [...current.ops].reverse().find((o) => !o.hidden && hitLayer(o, p, tolerance));
        selectedNumber = op?.number ?? null;
        moving = op ? { start: p, original: structuredClone(op), op: structuredClone(op), changed: false } : null;
        if (moving) canvas.setPointerCapture(e.pointerId);
        e.preventDefault();
        render();
        return;
      }
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
        ...(tool === 'pen' || tool === 'marker' || tool === 'eraser' ? { points: [p] } : { a: p, b: p }),
      };
      canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
      render();
    });
    canvas.addEventListener('pointerenter', (e) => {
      overCanvas = true;
      moveBrushPreview(e);
    });
    canvas.addEventListener('pointerleave', () => {
      overCanvas = false;
      updateBrushPreview();
    });
    canvas.addEventListener('pointermove', (e) => {
      overCanvas = true;
      moveBrushPreview(e);
      if (moving) {
        const p = point(e), o = moving.original, r = layerBounds(o);
        const dx = Math.max(-r.x, Math.min(current.width - r.x - r.w, p.x - moving.start.x));
        const dy = Math.max(-r.y, Math.min(current.height - r.y - r.h, p.y - moving.start.y));
        const translate = (q) => ({ x: q.x + dx, y: q.y + dy });
        moving.op = { ...o, ...(o.points ? { points: o.points.map(translate) } : { a: translate(o.a), b: translate(o.b) }) };
        moving.changed = dx !== 0 || dy !== 0;
        render();
        return;
      }
      if (!drawing) return;
      const p = point(e);
      if (drawing.points) {
        if (drawing.points.length < 20000) drawing.points.push(p);
      } else drawing.b = p;
      render();
    });
    canvas.addEventListener('pointerup', (e) => {
      if (moving && e.button === 0) {
        finishMove();
        if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
        return;
      }
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
          addLayer(op);
        }
      }
      render();
    });
    canvas.addEventListener('pointercancel', () => {
      finishMove(true);
      drawing = null;
      render();
    });
    root.querySelectorAll('[data-tool]').forEach((b) =>
      b.addEventListener('click', () => {
        finishText();
        tool = b.dataset.tool;
        if (tool !== 'select') selectedNumber = null;
        if (tool !== 'crop') cropSelection = null;
        root
          .querySelectorAll('[data-tool]')
          .forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        render();
        // Choosing the pen or the marker shows its size for a moment; other tools have no circle.
        if (tool === 'pen' || tool === 'marker' || tool === 'eraser') showSizing();
        status(
          tool === 'select'
            ? 'Выберите пометку на снимке или в списке справа. Потяните, чтобы переместить.'
          : tool === 'text'
            ? 'Выделите прямоугольник и введите текст — буквы подстроятся под его размер.'
            : tool === 'crop'
              ? 'Выделите область, которую хотите оставить на снимке.'
            : tool === 'eraser'
              ? 'Проведите по пометке, чтобы стереть её. Сама картинка не пострадает.'
            : tool === 'marker'
              ? 'Нажим меняет насыщенность маркера: от прозрачного до плотного следа.'
              : 'Рисуйте на снимке. Пометки сохраняются автоматически.',
        );
      }),
    );
    async function changeCrop(next) {
      if (!current || !(await flush())) return;
      remember();
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
      updateBrushPreview();
    });
    $('.shot-width').addEventListener('input', (e) => {
      width = +e.target.value;
      $('.shot-width-out').textContent = width;
      showSizing();
    });
    $('.shot-pressure').addEventListener('input', (e) => {
      pressure = +e.target.value;
      $('.shot-pressure-out').textContent = pressure + '%';
      showSizing();
    });
    let blurEditing = false;
    for (const input of [$('.shot-blur'), $('.shot-layer-blur')]) {
      input.addEventListener('change', () => { blurEditing = false; });
      input.addEventListener('blur', () => { blurEditing = false; });
      input.addEventListener('input', (e) => {
        if (current) {
          if (!blurEditing) { remember(); blurEditing = true; }
          current.blur = +e.target.value;
          $('.shot-blur').value = current.blur;
          $('.shot-blur-out').textContent = current.blur + '%';
          render();
          dirty();
        }
      });
    }
    $('.shot-layer-list').addEventListener('click', (e) => {
      const pick = e.target.closest('[data-layer-pick]'), eye = e.target.closest('[data-layer-eye]');
      if (pick) selectLayer(+pick.dataset.layerPick);
      if (eye) {
        selectLayer(+eye.dataset.layerEye);
        const layer = selectedLayer();
        if (!layer) return;
        remember();
        layer.hidden = !layer.hidden;
        dirty();
        render();
      }
    });
    function layerAction(action) {
      finishText();
      const layer = selectedLayer();
      if (!layer) return;
      const i = current.ops.indexOf(layer), j = i + (action === 'up' ? 1 : -1);
      if (action !== 'remove' && (j < 0 || j >= current.ops.length)) return;
      remember();
      if (action === 'remove') {
        current.ops.splice(i, 1);
        selectedNumber = current.ops[Math.min(i, current.ops.length - 1)]?.number ?? null;
      } else [current.ops[i], current.ops[j]] = [current.ops[j], current.ops[i]];
      dirty();
      render();
    }
    root.querySelectorAll('[data-layer-action]').forEach((b) =>
      b.addEventListener('click', () => layerAction(b.dataset.layerAction)),
    );
    for (const field of ['color', 'width', 'pressure', 'text']) {
      const input = $('.shot-layer-' + field);
      let editing = null;
      input.addEventListener('blur', () => { editing = null; });
      if (field !== 'text') input.addEventListener('change', () => { editing = null; });
      input.addEventListener('input', () => {
        const layer = selectedLayer();
        if (!layer) return;
        if (editing !== layer.number) { remember(); editing = layer.number; }
        layer[field] = field === 'width' || field === 'pressure' ? +input.value : input.value;
        dirty();
        render();
      });
    }
    window.SnowShortcut.mount($('.shot-key'), api);
    // Two small pop-ups: «Клавиши» (change the shortcut) and «?» (capture tips and the guide).
    // They close on a click elsewhere and on Esc, but not while a new shortcut is being pressed.
    function closePops(except) {
      root.querySelectorAll('[data-pop-body]').forEach((body) => {
        if (body === except) return;
        body.hidden = true;
        root.querySelector('[data-pop="' + body.dataset.popBody + '"]').setAttribute('aria-expanded', 'false');
      });
    }
    root.querySelectorAll('[data-pop]').forEach((b) =>
      b.addEventListener('click', () => {
        const body = root.querySelector('[data-pop-body="' + b.dataset.pop + '"]');
        closePops(body);
        body.hidden = !body.hidden;
        b.setAttribute('aria-expanded', String(!body.hidden));
      }),
    );
    document.addEventListener('pointerdown', (e) => {
      if (!recordingKey && !e.target.closest('.shot-pop-wrap')) closePops();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !recordingKey) closePops();
    });
    root.querySelectorAll('.shot-help-pop [data-guide]').forEach((b) => b.addEventListener('click', () => closePops()));
    function undo(redo) {
      finishText();
      finishMove(true);
      if (!current) return;
      const from = redo ? current.redo : current.undo,
        to = redo ? current.undo : current.redo;
      if (from.length) {
        to.push(snapshot());
        const state = from.pop();
        current.ops = state.ops;
        current.crop = state.crop;
        current.blur = state.blur;
        selectedNumber = state.selectedNumber;
        cropSelection = null;
        $('.shot-blur').value = current.blur;
        $('.shot-blur-out').textContent = current.blur + '%';
        sizeCanvas(current);
        dirty();
        render();
      } else if (!redo && current.ops.length) {
        // Old saved screenshots also allow removing their last mark one by one.
        current.redo.push(snapshot());
        current.ops.pop();
        selectedNumber = null;
        dirty();
        render();
      }
    }
    $('[data-action="undo"]').addEventListener('click', () => undo(false));
    $('[data-action="redo"]').addEventListener('click', () => undo(true));
    $('[data-action="copy"]').addEventListener('click', () =>
      run(() => current && copyShot(current.id)),
    );
    $('[data-action="export"]').addEventListener('click', () =>
      run(() => current && exportShot(current.id)),
    );
    $('[data-action="llm"]').addEventListener('click', () =>
      run(() => current && sendToLlm(current.id)),
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
    // A picture dropped on the window opens at once, like «Открыть картинку» without the file dialog.
    const IMAGE_RE = /\.(png|jpe?g|webp)$/i;
    async function importFiles(files) {
      const file = Array.from(files || []).find((f) => IMAGE_RE.test(f.name));
      if (!file) return status('Это не картинка. Подойдут png, jpg и webp.', true);
      const filePath = api.pathForFile ? api.pathForFile(file) : '';
      if (!filePath) return status('Этот файл не открылся. Попробуйте кнопку «Открыть картинку».', true);
      if (!(await flush())) return;
      const r = check(await api.captureImport(filePath));
      if (r.id) {
        await refresh();
        await open(r.id);
        status('Картинка открыта · ' + canvas.width + ' × ' + canvas.height);
      }
    }
    const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
    // The main window routes drops through its own handler (app.js); the separate editor listens here.
    if (document.documentElement.classList.contains('capture-external')) {
      document.addEventListener('dragover', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      });
      document.addEventListener('drop', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        run(() => importFiles(e.dataTransfer.files));
      });
    }
    if (document.documentElement.classList.contains('capture-external'))
      $('[data-guide]').addEventListener('click', () => run(() => api.captureGuide()));
    $('.shot-conflict').addEventListener('click', () =>
      run(async () => {
        if (current && window.confirm('Заменить несохранённые пометки версией с диска?'))
          await open(current.id, true);
      }),
    );
    $('.shot-recover').addEventListener('click', () =>
      run(async () => {
        if (!current) return;
        finishText();
        const blob = await new Promise((resolve) => rendered(current).toBlob(resolve, 'image/png'));
        if (!blob) throw Error('Не удалось подготовить изображение.');
        const result = check(await api.captureRecover(new Uint8Array(await blob.arrayBuffer())));
        if (!result.canceled) status('Снимок с пометками сохранён в файл.');
      }),
    );
    root.addEventListener('keydown', (e) => {
      if (e.target.matches('textarea,input,select')) return;
      if (e.key === 'Escape' && tool === 'select') {
        finishMove(true);
        selectedNumber = null;
        render();
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && tool === 'select' && selectedLayer()) {
        e.preventDefault();
        e.stopPropagation();
        layerAction('remove');
      }
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
    return { flush, refresh, open, importFiles: (f) => run(() => importFiles(f)) };
  }
  window.SnowCapture = { mount, textLayout, paint };
})();
