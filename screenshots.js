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
const { ScreenshotStore, pngSize, cropRect, discardUndo } = require('./screenshot-store');
const SHORTCUTS = ['Alt+Z', 'Alt+V', 'Alt+B'];

module.exports = function setupScreenshots(options) {
  let storage = new ScreenshotStore(options.dir()),
    token = crypto.randomUUID(),
    blocked = false;
  let key = SHORTCUTS.includes(options.key()) ? options.key() : 'Alt+Z',
    registered = false;
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
  function closeCapture(restore = true) {
    const old = session;
    session = null;
    if (!old) return;
    clearTimeout(old.timeout);
    for (const { win } of old.screens.values()) if (!win.isDestroyed()) win.destroy();
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
    editor = new BrowserWindow({
      width: 1180,
      height: 820,
      minWidth: 650,
      minHeight: 480,
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
    try {
      if (blocked) throw Error('Дождитесь переноса папки с данными.');
      await flushEditors();
      if (stopping) return {};
      // An explicit capture button always returns to its window, even if Windows reports it occluded.
      if (requester) {
        requester.hide();
        hidden.push(requester);
      }
      session = { screens: new Map(), hidden, token, timeout: null };
      const current = session;
      // Give the desktop compositor time to remove the requesting window.
      await new Promise((r) => setTimeout(r, 180));
      const displays = screen.getAllDisplays();
      const maxW = Math.max(...displays.map((d) => Math.ceil(d.size.width * d.scaleFactor)));
      const maxH = Math.max(...displays.map((d) => Math.ceil(d.size.height * d.scaleFactor)));
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: maxW, height: maxH },
        fetchWindowIcons: false,
      });
      if (session !== current) return {};
      for (const d of displays) {
        const source =
          sources.find((s) => s.display_id === String(d.id)) ||
          (displays.length === 1 ? sources[0] : null);
        if (!source || source.thumbnail.isEmpty())
          throw Error('Windows не предоставила изображение экрана. Попробуйте ещё раз.');
        const image = source.thumbnail;
        pngSize(image.toPNG());
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
          },
        });
        w.__snowCapture = 'overlay';
        w.setAlwaysOnTop(true, 'screen-saver');
        current.screens.set(w.webContents.id, { win: w, image, display: d });
        w.webContents.on('before-input-event', (e, input) => {
          if (input.key === 'Escape') {
            e.preventDefault();
            closeCapture();
          }
        });
        w.on('closed', () => {
          if (session === current) closeCapture();
        });
        w.webContents.on('render-process-gone', () => closeCapture());
        await w.loadFile(path.join(__dirname, 'src/capture-overlay.html'));
        if (session !== current) return {};
        w.setBounds(d.bounds);
      }
      const underMouse = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      for (const s of current.screens.values()) s.win.showInactive();
      const focus =
        [...current.screens.values()].find((s) => s.display.id === underMouse.id) ||
        [...current.screens.values()][0];
      focus.win.focus();
      current.timeout = setTimeout(() => closeCapture(), 120000);
      return {};
    } catch (e) {
      closeCapture();
      for (const w of hidden) if (!w.isDestroyed()) w.showInactive();
      throw e;
    } finally {
      busy = false;
    }
  }
  function register(next) {
    if (!SHORTCUTS.includes(next)) throw Error('Выберите Alt + Z, Alt + V или Alt + B.');
    if (next === key && registered) return;
    const success = globalShortcut.register(next, () => {
      start(null).catch((e) => dialog.showErrorBox('Снимки — Snowball.ai', e.message));
    });
    if (!success)
      throw Error(
        next.replace('+', ' + ') + ' уже занято другой программой. Выберите другое сочетание.',
      );
    if (registered) globalShortcut.unregister(key);
    key = next;
    registered = true;
    options.saveKey(key);
    changed();
  }
  // Try the preferred key first, then the remaining keys. Tell the main window about a fallback.
  const preferred = key;
  for (const candidate of [preferred, ...SHORTCUTS.filter((k) => k !== preferred)]) {
    try {
      register(candidate);
      break;
    } catch (e) {
      /* Another program owns this combination. */
    }
  }
  if (!registered)
    shortcutNotice =
      'Все сочетания для снимков заняты. Откройте «Снимки», чтобы выбрать клавиши после их освобождения.';
  else if (key !== preferred)
    shortcutNotice =
      preferred.replace('+', ' + ') +
      ' занято другой программой. Для снимков включено ' +
      key.replace('+', ' + ') +
      '.';
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
    if (size.width !== item.width || size.height !== item.height)
      throw Error('Размер изображения не совпадает со снимком.');
    const image = nativeImage.createFromBuffer(Buffer.from(bytes));
    if (image.isEmpty()) throw Error('Не удалось скопировать снимок.');
    check(t);
    clipboard.writeImage(image);
    await options.record();
    return {};
  });
  handle('capture-shortcut', async (_w, next) => {
    register(next);
    shortcutNotice = '';
    changed();
    return state();
  });
  handle('capture-start', (w) => start(w));
  handle('capture-import', async (w) => {
    if (blocked) throw Error('Дождитесь переноса папки с данными.');
    const result = await dialog.showOpenDialog(w, {
      title: 'Открыть картинку',
      properties: ['openFile'],
      filters: [{ name: 'Изображения', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    });
    if (result.canceled) return { canceled: true };
    const t = token,
      image = nativeImage.createFromPath(result.filePaths[0]);
    if (image.isEmpty()) throw Error('Не удалось прочитать картинку.');
    check(t);
    const item = await storage.add(image.toPNG(), image.resize({ width: 280 }).toDataURL());
    await options.record();
    changed();
    return { id: item.id };
  });
  handle(
    'capture-init',
    async (w) => ({ url: session.screens.get(w.webContents.id).image.toDataURL() }),
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
  screen.on('display-removed', () => closeCapture());
  screen.on('display-metrics-changed', () => closeCapture());
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    closeCapture(false);
  });
  return {
    state,
    hasAuxiliary: () => !!session || !!editor || busy || removed.size > 0,
    async closeAuxiliary() {
      stopping = true;
      try {
        await flushEditors();
        closeCapture(false);
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
