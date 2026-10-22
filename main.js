'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeTheme, Menu, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { Store, copyDataTo, hasData } = require('./storage');

const APP_TITLE = 'Snowball.ai';
// Names used by earlier versions (newest first). Their data folder and settings are moved over on first start.
const LEGACY_TITLES = ['Промты Snowball.ai', 'Промты VideoSmile'];
const IS_WIN = process.platform === 'win32';
const TITLEBAR_HEIGHT = 36;
const THEMES = ['system', 'light', 'dark'];

// The first prompt saved in the web version, carried over on first launch.
const SEED = () => [{
  id: 'clothing-extraction',
  title: 'ИЗВЛЕЧЕНИЕ ОДЕЖДЫ',
  type: 'Статика',
  createdAt: 1792620676096,
  updatedAt: 1792620676096,
  text: [
    'Using the attached photo as reference, identify every garment, pair of shoes, and accessory the person is wearing, and produce a new flat-lay product photo: all items laid out individually on a pure white studio background, in vertical 3:4 format.',
    'Each item must match the original precisely — same colors, same fabric and material, same silhouette and fit, same construction details (collar, sleeves, buttons, zippers, pockets, seams), same patterns, and the same visible logos or branding. Do not redesign, restyle, modernize, or reinterpret any item. Do not shift the color palette. Do not add items that are not visible in the photo.',
    'If part of a garment is obscured in the photo, reconstruct only the minimal hidden portion, based on the most plausible continuation of its existing construction — nothing beyond that.',
    'Layout: show each item in full, arranged separately with no overlap, spaced evenly to fill the vertical frame. Keep the relative proportions between items realistic.',
    'Lighting: soft, even studio lighting with minimal contact shadows beneath each item, accurate color reproduction, and realistic fabric texture.',
    'Preserve exactly as photographed: garment shapes, colors, materials, construction details, and original branding.',
    'Exclude: the person, their body or skin, a mannequin, hangers, any background scenery, decorative props, added text, watermarks, borders, or UI elements. The background must be solid pure white — no gradient, no shadows beyond soft contact shadows, no transparency.'
  ].join('\n')
}];

let win = null;
let store = null;
let settings = {};
let firstRunNotice = null;

/* ---------- settings ---------- */
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
const defaultDataDir = () => path.join(app.getPath('documents'), APP_TITLE);

function loadSettings() {
  try { settings = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) || {}; } catch (e) { settings = {}; }
}
let settingsTimer = null;
function saveSettings(now) {
  clearTimeout(settingsTimer);
  const doSave = () => {
    try {
      fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
      fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
    } catch (e) { /* settings are a convenience */ }
  };
  if (now) doSave(); else settingsTimer = setTimeout(doSave, 400);
}

/* ---------- moving over from the old name ---------- */
const sameDir = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

async function migrateLegacy() {
  const legacyUserData = LEGACY_TITLES.map((t) => path.join(app.getPath('appData'), t));
  const legacyDefaults = LEGACY_TITLES.map((t) => path.join(app.getPath('documents'), t));
  const isLegacyDefault = (d) => legacyDefaults.some((x) => sameDir(x, d));

  // First start under the new name: take window size and a custom folder from the old settings.
  if (!fs.existsSync(settingsPath()) && legacyUserData.some((d) => fs.existsSync(d))) {
    for (const ud of legacyUserData) {
      if (!fs.existsSync(ud)) continue;
      let legacy = {};
      try { legacy = JSON.parse(fs.readFileSync(path.join(ud, 'settings.json'), 'utf8')) || {}; } catch (e) { legacy = {}; }
      if (!settings.bounds) ['bounds', 'maximized', 'zoom'].forEach((k) => { if (legacy[k] !== undefined) settings[k] = legacy[k]; });
      if (!settings.dataDir && legacy.dataDir && !isLegacyDefault(legacy.dataDir) && await hasData(legacy.dataDir)) settings.dataDir = legacy.dataDir;
    }
    saveSettings(true);
    for (const ud of legacyUserData) {
      try { await fsp.rm(ud, { recursive: true, force: true }); } catch (e) { /* only caches and old settings live there */ }
    }
  }

  // Rename Документы\<old name> to Документы\<new name>. Retried on every start until it works
  // (Windows refuses while the folder is open in Explorer).
  const usingLegacy = !settings.dataDir || isLegacyDefault(settings.dataDir);
  if (!usingLegacy || fs.existsSync(defaultDataDir())) return;
  const candidates = (settings.dataDir ? [settings.dataDir] : []).concat(legacyDefaults);
  for (const src of candidates) {
    if (!(await hasData(src))) continue;
    try {
      await fsp.rename(src, defaultDataDir());
      settings.dataDir = defaultDataDir();
      firstRunNotice = { kind: 'renamed', dir: defaultDataDir() };
    } catch (e) {
      settings.dataDir = src;
      firstRunNotice = { kind: 'rename-later', dir: src };
    }
    saveSettings(true);
    return;
  }
}

/* ---------- data folder ---------- */
const trash = (p) => shell.trashItem(p);

async function openStore() {
  const wanted = settings.dataDir || defaultDataDir();
  try {
    store = await new Store(wanted, { trash }).init(SEED);
  } catch (e) {
    // The chosen folder is gone (unplugged drive, renamed folder): fall back to Documents.
    if (wanted === defaultDataDir()) throw e;
    firstRunNotice = { kind: 'missing', dir: wanted };
    store = await new Store(defaultDataDir(), { trash }).init(SEED);
    settings.dataDir = store.dir;
    saveSettings(true);
    return;
  }
  if (store.notice === 'created' && !firstRunNotice) firstRunNotice = { kind: 'created', dir: store.dir };
  if (store.notice === 'restored' || store.notice === 'reset') firstRunNotice = { kind: store.notice, dir: store.dir };
  settings.dataDir = store.dir;
  saveSettings(true);
}

/* ---------- window ---------- */
// 'system' follows Windows; the page's prefers-color-scheme and the title bar follow this too.
function applyTheme() {
  nativeTheme.themeSource = THEMES.includes(settings.theme) ? settings.theme : 'system';
}

function overlayColors() {
  return nativeTheme.shouldUseDarkColors
    ? { color: '#2C201B', symbolColor: '#F5E6DC', height: TITLEBAR_HEIGHT }
    : { color: '#F9E3D4', symbolColor: '#4B3128', height: TITLEBAR_HEIGHT };
}
function bgColor() { return nativeTheme.shouldUseDarkColors ? '#251B17' : '#FCEEE4'; }

function visibleBounds(b) {
  if (!b || !b.width || !b.height) return null;
  const onScreen = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x < a.x + a.width - 80 && b.x + b.width > a.x + 80 && b.y >= a.y - 10 && b.y < a.y + a.height - 80;
  });
  return onScreen ? b : { width: b.width, height: b.height };
}

function createWindow() {
  const b = visibleBounds(settings.bounds) || { width: 1180, height: 820 };
  win = new BrowserWindow({
    ...b,
    minWidth: 420,
    minHeight: 480,
    title: APP_TITLE,
    show: false,
    backgroundColor: bgColor(),
    icon: path.join(__dirname, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    titleBarStyle: IS_WIN ? 'hidden' : 'default',
    titleBarOverlay: IS_WIN ? overlayColors() : false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });
  if (settings.maximized) win.maximize();

  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.once('ready-to-show', () => win.show());

  win.webContents.on('did-finish-load', () => {
    if (settings.zoom) win.webContents.setZoomFactor(settings.zoom);
  });

  // Keep the app on its own page; real web links open in the browser.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Zoom with Ctrl + / Ctrl - / Ctrl 0 (there is no menu bar to provide it).
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return;
    const wc = win.webContents;
    let z = wc.getZoomFactor();
    if (input.code === 'Equal' || input.code === 'NumpadAdd') z = Math.min(2, z + 0.1);
    else if (input.code === 'Minus' || input.code === 'NumpadSubtract') z = Math.max(0.6, z - 0.1);
    else if (input.code === 'Digit0' || input.code === 'Numpad0') z = 1;
    else return;
    e.preventDefault();
    z = Math.round(z * 10) / 10;
    wc.setZoomFactor(z);
    settings.zoom = z;
    saveSettings();
  });

  const rememberBounds = () => {
    if (!win || win.isDestroyed()) return;
    settings.maximized = win.isMaximized();
    if (!win.isMaximized() && !win.isMinimized() && !win.isFullScreen()) settings.bounds = win.getBounds();
    saveSettings();
  };
  win.on('resize', rememberBounds);
  win.on('move', rememberBounds);
  win.on('maximize', rememberBounds);
  win.on('unmaximize', rememberBounds);
  win.on('close', () => { rememberBounds(); saveSettings(true); });

  win.on('focus', async () => {
    if (!store) return;
    try {
      if (await store.reloadIfChanged()) win.webContents.send('data-changed', store.view());
    } catch (e) { /* ignore */ }
  });
  win.on('closed', () => { win = null; });
}

nativeTheme.on('updated', () => {
  if (!win || win.isDestroyed()) return;
  win.setBackgroundColor(bgColor());
  if (IS_WIN) { try { win.setTitleBarOverlay(overlayColors()); } catch (e) { /* older Windows */ } }
});

/* ---------- IPC ---------- */
function ok(extra) { return Object.assign({ ok: true, prompts: store.view() }, extra || {}); }
function fail(e) {
  const code = e && e.code;
  let error = 'Не получилось. Попробуйте ещё раз.';
  if (code === 'EACCES' || code === 'EPERM') error = 'Windows не дал записать в папку с промтами. Проверьте, что папка не только для чтения.';
  else if (code === 'ENOSPC') error = 'На диске закончилось место.';
  else if (code === 'ENOENT') error = 'Папка с промтами недоступна. Проверьте, что диск подключён.';
  else if (e && e.userMessage) error = e.userMessage;
  return { ok: false, error };
}
function handle(name, fn) {
  ipcMain.handle(name, async (event, ...args) => {
    try { return await fn(...args); } catch (e) { console.error(name, e); return fail(e); }
  });
}
function info() {
  return { dataDir: store.dir, platform: process.platform, version: app.getVersion(), theme: nativeTheme.themeSource };
}

handle('load', async () => {
  const notice = firstRunNotice;
  firstRunNotice = null;
  return ok({ info: info(), notice });
});

handle('save-prompt', async (payload) => {
  const r = await store.savePrompt(payload);
  return ok(r);
});

handle('delete-prompt', async (id) => { await store.deletePrompt(id); return ok(); });

handle('add-files', async (promptId, sources) => ok(await store.addFiles(promptId, sources)));

handle('remove-file', async (promptId, fileId) => { await store.removeFile(promptId, fileId); return ok(); });

handle('pick-files', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Выберите файлы для промта',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Картинки и видео', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'mp4', 'webm', 'mov', 'm4v', 'mkv'] },
      { name: 'Все файлы', extensions: ['*'] }
    ]
  });
  if (r.canceled) return { ok: true, files: [] };
  const { pathToFileURL } = require('url');
  const files = [];
  for (const p of r.filePaths) {
    try {
      const st = await fsp.stat(p);
      files.push({ path: p, name: path.basename(p), size: st.size, url: pathToFileURL(p).href });
    } catch (e) { /* skip unreadable */ }
  }
  return { ok: true, files };
});

handle('open-file', async (promptId, fileId) => {
  const abs = store.filePath(promptId, fileId);
  if (!abs) return { ok: false, error: 'Файл не найден.' };
  const err = await shell.openPath(abs);
  return err ? { ok: false, error: 'Windows не нашёл программу для этого файла.' } : { ok: true };
});

handle('show-file', async (promptId, fileId) => {
  const abs = store.filePath(promptId, fileId);
  if (!abs) return { ok: false, error: 'Файл не найден.' };
  shell.showItemInFolder(abs);
  return { ok: true };
});

handle('copy-text', async (text) => { clipboard.writeText(String(text || '')); return { ok: true }; });

handle('set-theme', async (theme) => {
  if (!THEMES.includes(theme)) return { ok: false, error: 'Такой темы нет.' };
  settings.theme = theme;
  applyTheme();
  saveSettings();
  return { ok: true, info: info() };
});

handle('open-data-dir', async () => {
  const err = await shell.openPath(store.dir);
  return err ? { ok: false, error: 'Не получилось открыть папку.' } : { ok: true };
});

handle('change-data-dir', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Где хранить промты?',
    defaultPath: store.dir,
    buttonLabel: 'Выбрать эту папку',
    properties: ['openDirectory', 'createDirectory']
  });
  if (r.canceled || !r.filePaths[0]) return { ok: true, canceled: true };
  const dir = r.filePaths[0];
  if (path.resolve(dir).toLowerCase() === path.resolve(store.dir).toLowerCase()) return { ok: true, canceled: true };
  let mode;
  if (await hasData(dir)) {
    mode = 'opened';
  } else {
    await store.queue;
    await copyDataTo(store.dir, dir);
    mode = 'copied';
  }
  const next = await new Store(dir, { trash }).init(SEED);
  const oldDir = store.dir;
  store = next;
  settings.dataDir = dir;
  saveSettings(true);
  return ok({ info: info(), mode, oldDir });
});

handle('export', async () => {
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const r = await dialog.showSaveDialog(win, {
    title: 'Сохранить промты в файл',
    defaultPath: path.join(app.getPath('documents'), `${APP_TITLE} ${stamp}.json`),
    filters: [{ name: 'Файл промтов', extensions: ['json'] }]
  });
  if (r.canceled || !r.filePath) return { ok: true, canceled: true };
  await fsp.writeFile(r.filePath, store.exportJson(), 'utf8');
  return { ok: true, path: r.filePath, count: store.data.prompts.length };
});

handle('import', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Загрузить промты из файла',
    properties: ['openFile'],
    filters: [{ name: 'Файл промтов', extensions: ['json'] }, { name: 'Все файлы', extensions: ['*'] }]
  });
  if (r.canceled || !r.filePaths[0]) return { ok: true, canceled: true };
  let raw;
  try { raw = await fsp.readFile(r.filePaths[0], 'utf8'); } catch (e) { return { ok: false, error: 'Не получилось прочитать файл.' }; }
  try {
    return ok(await store.importJson(raw));
  } catch (e) {
    if (e instanceof SyntaxError || /списка промтов/.test(e.message)) return { ok: false, error: 'В этом файле нет промтов. Выберите файл, сохранённый через «Сохранить в файл».' };
    throw e;
  }
});

/* ---------- start ---------- */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  if (IS_WIN) app.setAppUserModelId('local.snowball.prompts');
  Menu.setApplicationMenu(null);

  app.whenReady().then(async () => {
    loadSettings();
    applyTheme();
    try { await migrateLegacy(); } catch (e) { console.error('migrate', e); }
    try {
      await openStore();
    } catch (e) {
      dialog.showErrorBox(APP_TITLE, 'Не получилось открыть папку с промтами:\n' + (settings.dataDir || defaultDataDir()) + '\n\n' + (e && e.message));
      app.quit();
      return;
    }
    createWindow();
  });

  app.on('before-quit', () => saveSettings(true));
  app.on('window-all-closed', () => { saveSettings(true); app.quit(); });
}
