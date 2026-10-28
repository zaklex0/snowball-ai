'use strict';
const {
  BrowserWindow,
  ipcMain,
  desktopCapturer,
  globalShortcut,
  screen,
  nativeImage,
  clipboard,
  dialog,
  shell,
  app,
} = require('electron');
const path = require('path');
const crypto = require('crypto');
const { ScreenshotStore, pngSize, validSize, cropRect, discardUndo } = require('./screenshot-store');
const SHORTCUTS = ['Alt+Z', 'Alt+V', 'Alt+B'];
const shortcut = require('./src/capture-shortcut');
// SNOWBALL_CAPTURE_TIMING=1 prints how long each step of a capture takes (tools/screenshot-timing.cjs reads it).
const TIMING = !!process.env.SNOWBALL_CAPTURE_TIMING;

module.exports = function setupScreenshots(options) {
  let storage = new ScreenshotStore(options.dir()),
    token = crypto.randomUUID(),
    blocked = false;
  let key = options.key() || 'Alt+Z',
    registered = false;
  let recording = null;
  let session = null,
    editor = null,
    busy = false,
    stopping = false,
    shortcutNotice = '';
  const removed = new Map();
  const windows = () =>
    BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.__snowCapture !== 'overlay');
  const emit = (channel, value) => windows().forEach((w) => w.webContents.send(channel, value));
  const changed = () => emit('capture-changed', state());
  const state = () => ({
    token,
    shortcut: key,
    shortcutActive: registered,
    shortcutRecording: !!recording,
    shortcutNotice,
    theme: options.theme(),
  });
  function check(t) {
    if (blocked || t !== token)
      throw Error('Папка с данными изменилась. Откройте раздел «Снимки» заново.');
  }
  function handle(name, fn, overlayOnly = false) {
    ipcMain.handle(name, async (e, ...args) => {
      const w = BrowserWindow.fromWebContents(e.sender);
      const file = e.sender.getURL().split('?')[0];
      if (
        !w ||
        !file.startsWith('file:') ||
        !['index.html', 'capture-editor.html', 'capture-overlay.html'].some((n) =>
          file.endsWith('/' + n),
        ) ||
        (overlayOnly && !session?.screens.has(e.sender.id))
      )
        return { ok: false, error: 'Окно недоступно.' };
      try {
        return { ok: true, ...(await fn(w, ...args)) };
      } catch (e) {
        return { ok: false, error: e.message || 'Не удалось выполнить действие со снимком.' };
      }
    });
  }
  async function flushEditors() {
    for (const w of windows()) {
      const ok = await w.webContents.executeJavaScript(
        'window.screenshotEditor ? window.screenshotEditor.flush() : true',
      );
      if (!ok) throw Error('Сначала сохраните пометки в редакторе снимков.');
    }
    await storage.queue;
  }
  // The selection windows are made in advance, one per monitor, and are only hidden between captures:
  // loading a new window took 0.15–0.25 s per monitor at every shortcut. They are remade when monitors change.
  const pool = new Map(); // display id → { win, display, loaded }
  let warmTimer = null;
  const sameDisplay = (a, b) =>
    a.scaleFactor === b.scaleFactor && ['x', 'y', 'width', 'height'].every((k) => a.bounds[k] === b.bounds[k]);
  function dropOverlay(id) {
    const o = pool.get(id);
    pool.delete(id);
    if (o && !o.win.isDestroyed()) o.win.destroy();
  }
  function makeOverlay(d) {
    const w = new BrowserWindow({
      ...d.bounds,
      frame: false,
      transparent: false,
      resizable: false,
      movable: false,
      minimizable: false,
      show: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      enableLargerThanScreen: true,
      backgroundColor: '#111111',
      webPreferences: {
        preload: path.join(__dirname, 'capture-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        zoomFactor: 1,
        backgroundThrottling: false,
      },
    });
    w.__snowCapture = 'overlay';
    w.setAlwaysOnTop(true, 'screen-saver');
    const id = w.webContents.id;
    const entry = {
      win: w,
      display: d,
      loaded: w.loadFile(path.join(__dirname, 'src/capture-overlay.html')).catch(() => {}),
    };
    w.webContents.on('before-input-event', (e, input) => {
      if (input.key === 'Escape') {
        e.preventDefault();
        closeCapture();
      }
    });
    w.on('closed', () => {
      if (pool.get(d.id) === entry) pool.delete(d.id);
      if (session && session.screens.has(id)) closeCapture();
    });
    w.webContents.on('render-process-gone', () => {
      if (pool.get(d.id) === entry) dropOverlay(d.id);
      closeCapture();
    });
    pool.set(d.id, entry);
    return entry;
  }
  // Brings the windows in line with the monitors connected now.
  function warm() {
    if (stopping || session) return;
    const displays = screen.getAllDisplays();
    for (const [id, o] of [...pool])
      if (o.win.isDestroyed() || !displays.some((d) => d.id === id && sameDisplay(d, o.display))) dropOverlay(id);
    for (const d of displays) if (!pool.has(d.id)) makeOverlay(d);
  }
  function warmLater(ms) {
    clearTimeout(warmTimer);
    warmTimer = setTimeout(warm, ms);
  }
  function releaseOverlays() {
    clearTimeout(warmTimer);
    for (const id of [...pool.keys()]) dropOverlay(id);
  }
  function closeCapture(restore = true) {
    const old = session;
    session = null;
    if (!old) return;
    clearTimeout(old.timeout);
    for (const r of old.waiting.values()) r();
    // Hidden, not closed: the next capture reuses them. The window forgets its picture first.
    for (const { win } of old.screens.values())
      if (!win.isDestroyed()) {
        win.webContents.send('capture-reset');
        win.hide();
      }
    // show() reliably unhides a Windows window; showInactive() can leave it hidden after capture.
    if (restore)
      for (const w of old.hidden)
        if (!w.isDestroyed()) {
          w.show();
          w.focus();
        }
  }
  async function openEditor(id) {
    if (editor && !editor.isDestroyed()) {
      if (editor.isMinimized()) editor.restore();
      editor.show();
      editor.focus();
      editor.webContents.send('capture-open', id);
      return;
    }
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const width = Math.max(1, Math.round(area.width * 0.8));
    const height = Math.max(1, Math.round(area.height * 0.8));
    editor = new BrowserWindow({
      x: area.x + Math.round((area.width - width) / 2),
      y: area.y + Math.round((area.height - height) / 2),
      width,
      height,
      minWidth: Math.min(650, width),
      minHeight: Math.min(480, height),
      show: false,
      title: 'Снимки — Snowball.ai',
      autoHideMenuBar: true,
      backgroundColor: '#FCEEE4',
      icon: path.join(__dirname, 'assets/icon.png'),
      webPreferences: {
        preload: path.join(__dirname, 'capture-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    const w = editor;
    w.__snowCapture = 'editor';
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.webContents.on('will-navigate', (e) => e.preventDefault());
    w.on('closed', () => {
      if (editor === w) editor = null;
    });
    await w.loadFile(path.join(__dirname, 'src/capture-editor.html'), { query: { id } });
    w.show();
    w.focus();
  }
  async function start(requester) {
    if (busy || session || stopping) return {};
    busy = true;
    const hidden = [];
    const t0 = Date.now(), marks = [];
    let last = t0;
    const mark = (name) => { if (TIMING) { const now = Date.now(); marks.push(name + ' ' + (now - last)); last = now; } };
    try {
      if (blocked) throw Error('Дождитесь переноса папки с данными.');
      await flushEditors();
      mark('flush');
      if (stopping) return {};
      // An explicit capture button always returns to its window, even if Windows reports it occluded.
      if (requester) {
        requester.hide();
        hidden.push(requester);
      }
      session = { screens: new Map(), waiting: new Map(), hidden, token, timeout: null };
      const current = session;
      // Give the desktop compositor time to remove the requesting window. The shortcut hides nothing.
      if (requester) await new Promise((r) => setTimeout(r, 180));
      mark('wait');
      const displays = screen.getAllDisplays();
      for (const [id, o] of [...pool])
        if (o.win.isDestroyed() || !displays.some((d) => d.id === id && sameDisplay(d, o.display))) dropOverlay(id);
      const maxW = Math.max(...displays.map((d) => Math.ceil(d.size.width * d.scaleFactor)));
      const maxH = Math.max(...displays.map((d) => Math.ceil(d.size.height * d.scaleFactor)));
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: maxW, height: maxH },
        fetchWindowIcons: false,
      });
      mark('getSources');
      if (session !== current) return {};
      for (const d of displays) {
        const source =
          sources.find((s) => s.display_id === String(d.id)) ||
          (displays.length === 1 ? sources[0] : null);
        if (!source || source.thumbnail.isEmpty())
          throw Error('Windows не предоставила изображение экрана. Попробуйте ещё раз.');
        const image = source.thumbnail,
          size = image.getSize();
        if (!validSize(size.width, size.height))
          throw Error('Экран слишком большой для снимка. Уменьшите разрешение или масштаб в Windows.');
        const o = pool.get(d.id) || makeOverlay(d);
        await o.loaded;
        if (session !== current) return {};
        if (o.win.isDestroyed()) throw Error('Окно выделения закрылось. Попробуйте ещё раз.');
        current.screens.set(o.win.webContents.id, { win: o.win, image, display: d });
      }
      mark('windows');
      // Raw pixels go to the window: no PNG to pack here and unpack there. The window is shown once it has drawn them.
      const drawn = [...current.screens].map(
        ([id, s]) =>
          new Promise((resolve) => {
            current.waiting.set(id, resolve);
            setTimeout(resolve, 2000);
            const size = s.image.getSize();
            s.win.webContents.send('capture-frame', { width: size.width, height: size.height, pixels: s.image.toBitmap() });
          }),
      );
      await Promise.all(drawn);
      mark('drawn');
      if (session !== current) return {};
      const underMouse = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      for (const s of current.screens.values()) {
        s.win.setBounds(s.display.bounds);
        s.win.showInactive();
      }
      const focus =
        [...current.screens.values()].find((s) => s.display.id === underMouse.id) ||
        [...current.screens.values()][0];
      focus.win.focus();
      mark('show');
      if (TIMING) console.log('[capture timing] start ' + t0 + ' displays ' + displays.length + ' | ' + marks.join(' | '));
      current.timeout = setTimeout(() => closeCapture(), 120000);
      return {};
    } catch (e) {
      closeCapture();
      for (const w of hidden) if (!w.isDestroyed()) w.showInactive();
      throw e;
    } finally {
      busy = false;
      warmLater(500);
    }
  }
  function register(next) {
    next = shortcut.normalize(next);
    if (next === key && registered) return;
    const success = globalShortcut.register(next, () => {
      start(null).catch((e) => dialog.showErrorBox('Снимки — Snowball.ai', e.message));
    });
    if (!success) throw Error('Это сочетание занято другой программой');
    if (registered) globalShortcut.unregister(key);
    key = next;
    registered = true;
  }
  function unavailable() {
    return (
      shortcut.format(key) +
      ' занято другой программой. Выберите другое сочетание в «Снимках» или в «Настройках» → «Горячие клавиши».'
    );
  }
  function endRecording(restore = true) {
    if (!recording) return;
    clearTimeout(recording.timeout);
    recording.window.removeListener('closed', recording.cancel);
    recording.window.removeListener('blur', recording.cancel);
    recording = null;
    if (restore && !registered) {
      try {
        register(key);
      } catch (_) {
        shortcutNotice = unavailable();
      }
    }
    changed();
  }
  // Legacy saved choices are kept. Only a fresh installation tries alternatives automatically.
  const preferred = key;
  const firstLaunch = !options.key() && !options.initialized();
  for (const candidate of firstLaunch ? SHORTCUTS : [preferred]) {
    try {
      register(candidate);
      break;
    } catch (e) {
      /* Another program owns this combination. */
    }
  }
  if (!registered)
    shortcutNotice = firstLaunch
      ? 'Все сочетания для снимков заняты. Выберите другое сочетание в «Снимках» или в «Настройках» → «Горячие клавиши».'
      : unavailable();
  else if (key !== preferred)
    shortcutNotice =
      shortcut.format(preferred) +
      ' занято другой программой. Для снимков включено ' +
      shortcut.format(key) +
      '.';
  options.saveKey(key);
  handle('capture-state', async () => state());
  handle('capture-recording', async (w, begin) => {
    if (recording && recording.window !== w) throw Error('Сочетание уже меняется в другом окне.');
    if (begin && !recording) {
      if (registered) globalShortcut.unregister(key);
      registered = false;
      const cancel = () => endRecording();
      recording = { window: w, cancel, timeout: setTimeout(cancel, 60000) };
      w.once('closed', cancel);
      w.once('blur', cancel);
      changed();
    } else if (!begin) endRecording();
    return state();
  });
  handle('capture-list', async () => ({ ...state(), items: await storage.list() }));
  handle('capture-guide', async () => {
    const main = windows().find((w) => !w.__snowCapture);
    if (main) {
      if (main.isMinimized()) main.restore();
      main.show();
      main.focus();
      main.webContents.send('capture-guide');
    }
    return {};
  });
  handle('capture-get', async (_w, id, t) => {
    check(t);
    return { item: await storage.get(id) };
  });
  handle('capture-save', async (_w, id, t, value) => {
    check(t);
    const result = await storage.save(id, value);
    changed();
    return result;
  });
  handle('capture-delete', async (_w, id, t) => {
    check(t);
    await flushEditors();
    check(t);
    const owner = storage,
      record = await owner.remove(id, (p) => shell.trashItem(p)),
      undo = crypto.randomUUID();
    const entry = { owner, record, token: t, expires: Date.now() + 7000 };
    entry.timer = setTimeout(() => {
      removed.delete(undo);
      discardUndo(record.backup).catch(() => {});
    }, 7000);
    removed.set(undo, entry);
    changed();
    return { undo, expires: entry.expires };
  });
  handle('capture-restore', async (_w, undo, t) => {
    check(t);
    const entry = removed.get(undo);
    if (!entry || entry.token !== t || Date.now() > entry.expires)
      throw Error('Время отмены истекло. Снимок можно вернуть из корзины Windows.');
    clearTimeout(entry.timer);
    removed.delete(undo);
    try {
      const id = await entry.owner.restore(entry.record);
      changed();
      return { id };
    } finally {
      await discardUndo(entry.record.backup);
    }
  });
  handle('capture-copy', async (_w, id, t, bytes) => {
    check(t);
    const item = await storage.get(id),
      size = pngSize(bytes);
    const view = item.crop || item;
    if (size.width !== view.width || size.height !== view.height)
      throw Error('Размер изображения не совпадает со снимком.');
    const image = nativeImage.createFromBuffer(Buffer.from(bytes));
    if (image.isEmpty()) throw Error('Не удалось скопировать снимок.');
    check(t);
    clipboard.writeImage(image);
    await options.record();
    return {};
  });
  handle('capture-shortcut', async (w, next) => {
    if (recording && recording.window !== w) throw Error('Сочетание уже меняется в другом окне.');
    try {
      register(next);
      shortcutNotice = '';
      options.saveKey(key);
    } finally {
      endRecording();
    }
    changed();
    return state();
  });
  handle('capture-start', (w) => start(w));
  handle('capture-import', async (w, dropped) => {
    if (blocked) throw Error('Дождитесь переноса папки с данными.');
    let picked = null;
    if (typeof dropped === 'string' && dropped) {
      // Dropped on the window: no dialog, but only a picture file.
      if (!/\.(png|jpe?g|webp)$/i.test(dropped)) throw Error('Это не картинка. Подойдут png, jpg и webp.');
      picked = dropped;
    } else {
      const result = await dialog.showOpenDialog(w, {
        title: 'Открыть картинку',
        properties: ['openFile'],
        filters: [{ name: 'Изображения', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      });
      if (result.canceled) return { canceled: true };
      picked = result.filePaths[0];
    }
    const t = token,
      image = nativeImage.createFromPath(picked);
    if (image.isEmpty()) throw Error('Не удалось прочитать картинку.');
    check(t);
    const item = await storage.add(image.toPNG(), image.resize({ width: 280 }).toDataURL());
    await options.record();
    changed();
    return { id: item.id };
  });
  // The selection window has drawn the screen it was sent and may be shown.
  handle(
    'capture-ready',
    async (w) => {
      const resolve = session.waiting.get(w.webContents.id);
      if (resolve) resolve();
      return {};
    },
    true,
  );
  handle(
    'capture-cancel',
    async () => {
      closeCapture();
      return {};
    },
    true,
  );
  handle(
    'capture-choose',
    async (w, rect) => {
      const s = session,
        data = s.screens.get(w.webContents.id);
      check(s.token);
      const image = data.image.crop(
        cropRect(rect, data.image.getSize().width, data.image.getSize().height),
      );
      closeCapture();
      try {
        const item = await storage.add(image.toPNG(), image.resize({ width: 280 }).toDataURL());
        await options.record();
        changed();
        await openEditor(item.id);
        return {};
      } catch (e) {
        dialog.showErrorBox('Снимки — Snowball.ai', 'Не удалось открыть снимок: ' + e.message);
        throw e;
      }
    },
    true,
  );
  // The timing tool starts a capture the way the global shortcut does, without a requesting window.
  if (TIMING) global.snowCaptureStart = () => start(null);
  const displaysChanged = () => {
    closeCapture();
    warmLater(1000);
  };
  screen.on('display-added', displaysChanged);
  screen.on('display-removed', displaysChanged);
  screen.on('display-metrics-changed', displaysChanged);
  // Not at once: the first seconds after the start belong to the main window.
  warmLater(3000);
  app.on('will-quit', () => {
    endRecording(false);
    globalShortcut.unregisterAll();
    closeCapture(false);
    releaseOverlays();
  });
  return {
    state,
    hasAuxiliary: () => !!session || !!editor || busy || removed.size > 0,
    async closeAuxiliary() {
      stopping = true;
      try {
        await flushEditors();
        closeCapture(false);
        releaseOverlays();
        if (editor && !editor.isDestroyed()) editor.destroy();
        await Promise.all(
          [...removed.values()].map((entry) => {
            clearTimeout(entry.timer);
            return discardUndo(entry.record.backup);
          }),
        );
        removed.clear();
      } catch (e) {
        stopping = false;
        throw e;
      }
    },
    // The hidden selection windows must not keep the app alive after its last window is closed.
    releaseOverlays,
    flush: flushEditors,
    async pause() {
      await flushEditors();
      blocked = true;
      closeCapture();
      await storage.queue;
    },
    resume() {
      if (storage.root !== path.join(options.dir(), 'Снимки')) {
        storage = new ScreenshotStore(options.dir());
        token = crypto.randomUUID();
      }
      blocked = false;
      changed();
    },
    backup: () => storage.backupEntries(),
    async merge(root) {
      const n = await storage.merge(root);
      changed();
      return n;
    },
    theme() {
      emit('capture-theme', options.theme());
    },
    start,
  };
};
