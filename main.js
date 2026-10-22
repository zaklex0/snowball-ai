'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeTheme, nativeImage, Menu, screen, safeStorage, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const Anthropic = require('@anthropic-ai/sdk').default;
const OpenAI = require('openai').default;
const { Store, copyDataTo, hasData, normalizeEvent } = require('./storage');

const APP_TITLE = 'Snowball.ai';
// Names used by earlier versions (newest first). Their data folder and settings are moved over on first start.
const LEGACY_TITLES = ['Промты Snowball.ai', 'Промты VideoSmile'];
const IS_WIN = process.platform === 'win32';
const TITLEBAR_HEIGHT = 36;
const THEMES = ['system', 'light', 'dark'];

// Prompts a fresh install starts with (only when the data folder has no prompts.json yet).
// Empty for now; example prompts for each type can go here later.
const SEED = () => [];

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
  win.on('focus', () => { if (win) win.flashFrame(false); });
  win.on('closed', () => { win = null; });
}

/* ---------- updates ---------- */
// The installed program checks GitHub Releases on start and every few hours. When a new version
// exists it asks first; only after "Скачать" it downloads, then installs on restart or when the program is closed.
let updater = null;
let updateFound = null;   // newer version on GitHub, not downloaded yet
let downloading = false;
let updateReady = null;   // version that is downloaded and waits for a restart
let manualCheck = false;  // the user asked from the menu, so report "no update" and errors too
let lastPercent = -1;

function sendUpdate(u) { if (win && !win.isDestroyed()) win.webContents.send('update', u); }

function checkUpdates() { updater.checkForUpdates().catch(() => { /* reported by the 'error' event */ }); }

function setupUpdates() {
  if (!app.isPackaged) return;
  updater = require('electron-updater').autoUpdater;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = true;
  updater.on('update-available', (i) => {
    updateFound = i.version;
    if (!downloading) sendUpdate({ kind: 'available', version: i.version, manual: manualCheck });
    manualCheck = false;
  });
  updater.on('update-not-available', () => { if (manualCheck) sendUpdate({ kind: 'latest' }); manualCheck = false; });
  updater.on('download-progress', (p) => {
    const percent = Math.floor(p.percent || 0);
    if (percent !== lastPercent) { lastPercent = percent; sendUpdate({ kind: 'progress', version: updateFound, percent }); }
  });
  updater.on('update-downloaded', (i) => {
    downloading = false;
    updateReady = i.version;
    manualCheck = false;
    sendUpdate({ kind: 'ready', version: i.version });
  });
  updater.on('error', (e) => {
    console.error('update', e);
    if (downloading) { downloading = false; sendUpdate({ kind: 'download-error', version: updateFound }); }
    else if (manualCheck) sendUpdate({ kind: 'error' });
    manualCheck = false;
  });
  setTimeout(checkUpdates, 10 * 1000);
  setInterval(checkUpdates, 4 * 60 * 60 * 1000);
}

nativeTheme.on('updated', () => {
  if (!win || win.isDestroyed()) return;
  win.setBackgroundColor(bgColor());
  if (IS_WIN) { try { win.setTitleBarOverlay(overlayColors()); } catch (e) { /* older Windows */ } }
});

/* ---------- IPC ---------- */
function ok(extra) {
  return Object.assign({ ok: true, prompts: store.view(), profile: store.profileView(), activity: store.activityView(), events: store.calendarView() }, extra || {});
}
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
  return { dataDir: store.dir, platform: process.platform, version: app.getVersion(), theme: nativeTheme.themeSource, assistant: assistantInfo() };
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

// promptId is passed when a whole prompt is copied: that counts as using it on the statistics page.
handle('copy-text', async (text, promptId) => {
  clipboard.writeText(String(text || ''));
  if (!promptId || !store.find(promptId)) return { ok: true };
  await store.recordCopy();
  return { ok: true, activity: store.activityView() };
});

/* ---------- profile ---------- */
const AVATAR_SIZE = 256;

// Crops the middle square of the picture and shrinks it, so a 20 MB photo becomes a small PNG.
handle('pick-avatar', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Выберите картинку для аватарки',
    properties: ['openFile'],
    filters: [{ name: 'Картинки', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]
  });
  if (r.canceled || !r.filePaths[0]) return { ok: true, canceled: true };
  const img = nativeImage.createFromPath(r.filePaths[0]);
  if (img.isEmpty()) return { ok: false, error: 'Эту картинку не получилось открыть. Попробуйте PNG или JPG.' };
  const { width, height } = img.getSize();
  const side = Math.min(width, height);
  const square = img.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side });
  const small = side > AVATAR_SIZE ? square.resize({ width: AVATAR_SIZE, height: AVATAR_SIZE, quality: 'best' }) : square;
  return { ok: true, avatar: small.toDataURL() };
});

// avatar: a data URL from pick-avatar, null to remove, undefined to keep the current one.
handle('save-profile', async (input) => {
  const name = input && typeof input.name === 'string' ? input.name : undefined;
  let avatar;
  if (input && input.avatar === null) avatar = null;
  else if (input && typeof input.avatar === 'string') {
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(input.avatar);
    if (!m || m[1].length > 4 * 1024 * 1024) return { ok: false, error: 'Не получилось сохранить аватарку.' };
    avatar = Buffer.from(m[1], 'base64');
  }
  await store.saveProfile({ name, avatar });
  return ok();
});

handle('set-theme', async (theme) => {
  if (!THEMES.includes(theme)) return { ok: false, error: 'Такой темы нет.' };
  settings.theme = theme;
  applyTheme();
  saveSettings();
  return { ok: true, info: info() };
});

handle('check-updates', async () => {
  if (!updater) return { ok: false, error: 'Обновления проверяются только в установленной программе.' };
  if (updateReady) { sendUpdate({ kind: 'ready', version: updateReady }); return { ok: true }; }
  if (downloading) { sendUpdate({ kind: 'progress', version: updateFound, percent: Math.max(0, lastPercent) }); return { ok: true }; }
  manualCheck = true;
  checkUpdates();
  return { ok: true };
});

// The user agreed to download the version that the last check found.
handle('download-update', async () => {
  if (!updater || !updateFound) return { ok: false, error: 'Сначала проверьте обновления.' };
  if (!downloading && !updateReady) {
    downloading = true;
    lastPercent = -1;
    updater.downloadUpdate().catch(() => { /* reported by the 'error' event */ });
  }
  return { ok: true };
});

handle('install-update', async () => {
  if (!updater || !updateReady) return { ok: false, error: 'Обновление ещё не скачано.' };
  saveSettings(true);
  setImmediate(() => updater.quitAndInstall(true, true));
  return { ok: true };
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

/* ---------- assistant ---------- */
// The window sends the whole conversation, main.js answers piece by piece through the 'assistant' event:
// { id, kind: 'delta', text } … { id, kind: 'action', action } … { id, kind: 'done' } or { id, kind: 'error', error }.
// Replies come from a source: an async generator of { type: 'text', text } and { type: 'action', action }.
// Sources: stubSource (no key), openaiSource (ChatGPT) and claudeSource (Claude); pickSource chooses.
const streams = new Map();   // stream id -> AbortController
const pending = new Map();   // action id -> proposed action, waiting for "Создать" or "Отмена"
let streamSeq = 0;
let actionSeq = 0;

function sendAssistant(e) { if (win && !win.isDestroyed()) win.webContents.send('assistant', e); }

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('aborted')); return; }
    const t = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
    const stop = () => { clearTimeout(t); reject(new Error('aborted')); };
    signal.addEventListener('abort', stop, { once: true });
  });
}

// Pulls the prompt name out of «…» or "…", otherwise takes the words after "промт".
function stubTitle(text) {
  const q = /[«"“„]([^»"”“]{1,120})[»"”]/.exec(text);
  if (q) return q[1].trim();
  const m = /промт\S*\s+([^:\n]{1,80})/i.exec(text);
  return m && m[1].trim() ? m[1].trim().replace(/^(про|для|о|об)\s+/i, '') : 'Новый промт';
}
function stubType(text) {
  if (/видео|ролик|клип/i.test(text)) return 'Видео';
  if (/системн/i.test(text)) return 'Системные';
  return 'Статика';
}
function afterColon(text) {
  const i = text.indexOf(':');
  return i === -1 ? '' : text.slice(i + 1).trim();
}

/* ---------- calendar ---------- */
const WEEKDAYS_RU = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const MONTHS_RU = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const pad2 = (n) => String(n).padStart(2, '0');
const dayKeyOf = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
const dateOfKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
// "вторник, 3 ноября" for cards and answers.
function humanDay(k) { const d = dateOfKey(k); return WEEKDAYS_RU[d.getDay()] + ', ' + d.getDate() + ' ' + MONTHS_RU[d.getMonth()]; }
function eventLine(e) { return humanDay(e.date) + ', ' + e.from + (e.to ? '–' + e.to : '') + ' — ' + e.title; }
// Tells the model what "today" and "tomorrow" are. It goes after the cached instructions so it does not break the cache.
function nowLine() {
  const d = new Date();
  return 'Сейчас: ' + WEEKDAYS_RU[d.getDay()] + ', ' + d.getDate() + ' ' + MONTHS_RU[d.getMonth()] + ' ' + d.getFullYear() +
    ' года, ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ' (время на компьютере пользователя). Сегодняшняя дата: ' + dayKeyOf(d) + '.';
}

// The day a phrase mentions: "сегодня", "завтра", "послезавтра", "3 марта", "03.11". Null when there is none.
function stubDay(t) {
  const now = new Date();
  const plus = (n) => { const d = new Date(now); d.setDate(d.getDate() + n); return dayKeyOf(d); };
  if (/послезавтра/.test(t)) return plus(2);
  if (/завтра/.test(t)) return plus(1);
  if (/сегодня/.test(t)) return plus(0);
  const m = /(\d{1,2})\s+(январ|феврал|март|апрел|ма[яй]|июн|июл|август|сентябр|октябр|ноябр|декабр)/.exec(t);
  const n = /\b(\d{1,2})\.(\d{1,2})\b/.exec(t);
  let day = null, month = null;
  if (m) { day = +m[1]; month = ['январ', 'феврал', 'март', 'апрел', 'ма', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'].findIndex((x) => m[2].startsWith(x)); }
  else if (n) { day = +n[1]; month = +n[2] - 1; }
  if (day === null || month < 0 || month > 11) return null;
  let d = new Date(now.getFullYear(), month, day);
  if (d < new Date(now.getFullYear(), now.getMonth(), now.getDate())) d = new Date(now.getFullYear() + 1, month, day);
  return d.getDate() === day ? dayKeyOf(d) : null;
}
function stubCalendar(text, t) {
  const date = stubDay(t);
  if (/удали|убери|отмени/.test(t)) {
    const words = t.split(/[^a-zа-яё0-9]+/i).filter((w) => w.length >= 4 && !/^(удали|убери|отмени|календар|завтра|сегодня|послезавтра)/.test(w)).map((w) => w.slice(0, Math.max(4, w.length - 2)));
    const hit = store.calendarView().find((e) => (!date || e.date === date) && words.some((w) => e.title.toLowerCase().includes(w)));
    if (!hit) return { text: 'Не нашёл такого дела в календаре. Напишите точнее: что и в какой день.' };
    return { text: 'Нашёл это дело. Удалить его? Без вашей кнопки ничего не удалится.', action: { kind: 'calendar-delete', title: hit.title, event: hit } };
  }
  const tm = /(?:^|\s)в\s+(\d{1,2})(?::(\d{2}))?/.exec(t);   // \b does not work next to Russian letters
  if (/(что|какие).*(дел|план|календар|стоит)|календар.*(что|покажи)|что у меня/.test(t) && !tm) {
    const day = date || dayKeyOf(new Date());
    const list = store.calendarView().filter((e) => e.date === day);
    const d = dateOfKey(day);
    const on = 'На ' + d.getDate() + ' ' + MONTHS_RU[d.getMonth()] + ' (' + WEEKDAYS_RU[d.getDay()] + ')';
    return { text: list.length ? on + ' запланировано:\n' + list.map((e) => '- ' + e.from + (e.to ? '–' + e.to : '') + ' **' + e.title + '**').join('\n') : on + ' в календаре ничего нет.' };
  }
  if (!date || !tm || +tm[1] > 23) {
    return { text: 'Напишите, что и когда поставить, например: **«поставь созвон с монтажёром на завтра в 15:00»**. Я предложу карточку, и дело попадёт в календарь только после вашего «Добавить».' };
  }
  const from = pad2(+tm[1]) + ':' + (tm[2] || '00');
  const kind = /созвон|звон|позвон/.test(t) ? 'call' : /встреч/.test(t) ? 'meet' : 'task';
  let title = text.replace(/^(пожалуйста\s+)?(поставь|добавь|запиши|запланируй|напомни|создай)(\s+мне)?\s+/i, '')
    .replace(/\s*(в\s+календарь|на\s+(сегодня|завтра|послезавтра)|(на\s+)?\d{1,2}\s+[а-яё]+|(на\s+)?\d{1,2}\.\d{1,2}|сегодня|завтра|послезавтра|в\s+\d{1,2}(:\d{2})?)\s*/gi, ' ').trim();
  title = title ? title.charAt(0).toUpperCase() + title.slice(1) : 'Новое дело';
  const event = normalizeEvent({ date, from, title, kind, remind: /напомни/.test(t) ? 15 : 0 });
  return { text: 'Вот что я поставлю. Проверьте и нажмите **«Добавить»**: без вашего подтверждения календарь не меняется.', action: { kind: 'calendar-add', title: event.title, event } };
}

function stubAnswer(last) {
  const t = last.toLowerCase();
  if (/(добав|созда|сохран|запиш)\S*\s.*промт/.test(t)) {
    const title = stubTitle(last);
    const category = stubType(last);
    const text = afterColon(last) || `${title}, cinematic composition, soft warm light, rich textures, highly detailed, 4k`;
    return {
      text: 'Конечно! Вот что я сохраню в таблицу. Проверьте и нажмите **«Создать»**, если всё верно: без вашего подтверждения я ничего не меняю.',
      action: { kind: 'create-prompt', title, category, text }
    };
  }
  if (/улучш|доработ|переделай|перепиши/.test(t)) {
    const subject = afterColon(last) || 'a cat floating in outer space';
    return {
      text: 'Вот как можно сделать промт подробнее. Я добавил стиль, свет, камеру и детали:\n\n' +
        '```\n' + subject + ', cinematic shot, soft golden hour light, 35mm lens, shallow depth of field, ' +
        'rich textures, volumetric haze, highly detailed, 4k\n```\n\n' +
        'Что поменялось:\n' +
        '- **Свет** — мягкий закатный, он даёт тёплые тени.\n' +
        '- **Камера** — объектив 35 мм и размытый фон, как в кино.\n' +
        '- **Детали** — фактуры и лёгкая дымка, чтобы картинка не была плоской.\n\n' +
        'Это заготовка. Настоящая модель (ChatGPT или Claude) будет улучшать именно ваш текст.'
    };
  }
  if (/календар|встреч|созвон|звон|задач|напомни|поставь|запланируй|что у меня|какие (у меня )?дела|удали|убери/.test(t)) return stubCalendar(last, t);
  if (/промт/.test(t)) {
    const prompts = store.data.prompts;
    if (!prompts.length) {
      return { text: 'В вашей таблице пока нет промтов. Напишите, например, **«добавь промт «Неоновый город»»**, и я предложу его сохранить.' };
    }
    const counts = {};
    prompts.forEach((p) => { const k = p.type || 'Без типа'; counts[k] = (counts[k] || 0) + 1; });
    // Compares the beginnings of words, so "одежду" finds "одежды"; question words are skipped.
    const skip = /^(промт|сколько|меня|мои|моих|есть|какие|какой|найди|покажи|нужен|нужно|всех|список|про|для)/;
    const stems = t.split(/[^a-zа-яё0-9]+/i).filter((w) => w.length >= 4 && !skip.test(w)).map((w) => w.slice(0, Math.max(4, w.length - 2)));
    const found = stems.length ? prompts.filter((p) => stems.some((s) => (p.title + ' ' + p.text + ' ' + p.comment).toLowerCase().includes(s))).slice(0, 3) : [];
    let text = `Сейчас в таблице ${prompts.length} шт.: ` + Object.keys(counts).map((k) => `${k} — ${counts[k]}`).join(', ') + '.';
    if (found.length) text += '\n\nПохоже, вам подойдут:\n' + found.map((p) => `- **${p.title || 'Без названия'}** (${p.type || 'без типа'})`).join('\n');
    text += '\n\nНастоящая модель будет искать по смыслу, а не только по словам.';
    return { text };
  }
  return {
    text: 'Привет! Я пока тестовый ассистент: отвечаю заготовками, чтобы можно было посмотреть, как всё будет выглядеть.\n\n' +
      'Когда в «Настройках» появится ключ ChatGPT или Claude, я смогу:\n' +
      '- придумать или улучшить промт для картинки или видео;\n' +
      '- посмотреть, что у вас в календаре, и предложить добавить или удалить дело;\n' +
      '- всё, что меняет данные, — только после вашей кнопки на карточке.\n\n' +
      'Попробуйте написать: **поставь созвон с монтажёром на завтра в 15:00**, **что у меня на завтра?** или **улучши промт: кот в космосе**.'
  };
}

// Pretends to think, then sends the answer a few words at a time, like a real stream.
async function* stubSource(messages, signal) {
  const lastUser = messages.slice().reverse().find((m) => m.role === 'user');
  const answer = stubAnswer(lastUser ? lastUser.content : '');
  await sleep(500 + Math.random() * 400, signal);
  const pieces = answer.text.match(/\S+\s*|\s+/g) || [];
  for (let i = 0; i < pieces.length;) {
    const n = 1 + Math.floor(Math.random() * 3);
    yield { type: 'text', text: pieces.slice(i, i + n).join('') };
    i += n;
    await sleep(25 + Math.random() * 45, signal);
  }
  if (answer.action) yield { type: 'action', action: answer.action };
}

/* Real models: ChatGPT (OpenAI) and Claude (Anthropic). Each user brings their own API key
   (the repository is public, so the program has none). Keys are encrypted with Windows (safeStorage) into
   %APPDATA%\Snowball.ai\openai-key.bin and claude-key.bin, live decrypted only here in main.js
   and never go to the window. Without a key for the chosen model's provider the stub answers. */
const PROVIDERS = {
  openai: { file: 'openai-key.bin', name: 'OpenAI', keyRe: /^sk-(?!ant-)\S+$/, keyHint: 'Это не похоже на ключ OpenAI: он начинается с sk- и пишется без пробелов.' },
  anthropic: { file: 'claude-key.bin', name: 'Anthropic', keyRe: /^sk-ant-\S+$/, keyHint: 'Это не похоже на ключ Anthropic: он начинается с sk-ant- и пишется без пробелов.' }
};
// The order matters: without a choice, the first model whose provider has a key answers.
const MODELS = [
  { id: 'gpt-6.1-sol', provider: 'openai' },
  { id: 'gpt-6-luna', provider: 'openai' },
  { id: 'gpt-6-astra', provider: 'openai' },
  { id: 'claude-opus-5-5', provider: 'anthropic' },
  { id: 'claude-haiku-5-5', provider: 'anthropic' }
];
// How long the model thinks before answering, like the levels in Claude itself: deeper is slower and costs more.
// All five models accept the same five levels.
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const DEFAULT_EFFORT = 'medium';
const SYSTEM_PROMPT = [
  'Ты — ассистент в программе Snowball.ai. В ней пользователь хранит промты для нейросетей, которые делают картинки и видео: Midjourney, Nano Banana, GPT Image, Seedream, Kling, Seedance, Runway и другие.',
  'Ты помогаешь придумывать новые промты, улучшать и разбирать готовые, переводить их и подстраивать под нужную нейросеть.',
  'Отвечай по-русски, коротко и по делу, если не просят подробнее. Пользователь не программист: объясняй простыми словами, без жаргона.',
  'Сам промт пиши на том языке, который лучше понимает нужная нейросеть (обычно английский). Каждый готовый промт помещай в отдельный блок кода ```, чтобы его можно было скопировать одной кнопкой.',
  'Если не хватает важной детали (для какой нейросети, картинка или видео, соотношение сторон), сначала предложи вариант, а потом коротко спроси.',
  'Из разметки используй только абзацы, списки, **жирный** и блоки кода. Таблицы не используй: программа их не показывает.',
  'У пользователя в программе есть календарь, и ты можешь с ним работать: calendar_list показывает дела за период, calendar_add и calendar_delete предлагают добавить или удалить дело. Добавление и удаление происходят, только когда пользователь нажмёт кнопку на карточке, поэтому пиши «предлагаю добавить, подтвердите», а не «добавил». Перед удалением найди дело через calendar_list и передай его id. Если время окончания не названо, оставь to пустым. Напоминание ставь, только если о нём просят, иначе 0. Тип: task — задача, meet — встреча, call — звонок. Даты считай от текущего момента из строки «Сейчас».',
  'Промты пользователя ты пока не видишь и сохранять не умеешь. Если об этом просят, скажи, что это появится позже, а пока промт можно скопировать кнопкой «Копировать» и добавить через «Добавить промт» в разделе «Промты».'
].join('\n\n');

// What the assistant may do with the calendar. Looking is free; adding and deleting only show a card.
const TOOLS = [
  {
    name: 'calendar_list',
    description: 'Показывает дела из календаря пользователя за период (включительно). Используй, чтобы ответить, что запланировано, или найти дело и его id перед удалением.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['from', 'to'],
      properties: {
        from: { type: 'string', description: 'Первый день периода, YYYY-MM-DD' },
        to: { type: 'string', description: 'Последний день периода, YYYY-MM-DD' }
      }
    }
  },
  {
    name: 'calendar_add',
    description: 'Предлагает добавить дело в календарь. Пользователь увидит карточку и сам нажмёт «Добавить» или «Отмена»; до этого ничего не сохраняется.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['date', 'from', 'to', 'title', 'kind', 'note', 'remind'],
      properties: {
        date: { type: 'string', description: 'День, YYYY-MM-DD' },
        from: { type: 'string', description: 'Начало, HH:MM (24 часа)' },
        to: { type: 'string', description: 'Окончание, HH:MM, или пустая строка, если не названо' },
        title: { type: 'string', description: 'Коротко, что за дело' },
        kind: { type: 'string', enum: ['task', 'meet', 'call'], description: 'task — задача, meet — встреча, call — звонок' },
        note: { type: 'string', description: 'Заметка или пустая строка' },
        remind: { type: 'integer', enum: [0, 15, 30, 60, 1440], description: 'За сколько минут напомнить, 0 — не напоминать' }
      }
    }
  },
  {
    name: 'calendar_delete',
    description: 'Предлагает удалить дело из календаря. Пользователь подтверждает удаление кнопкой на карточке.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['id'],
      properties: { id: { type: 'string', description: 'id дела из calendar_list' } }
    }
  }
];
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// Runs one tool call: { output } goes back to the model, { action } becomes a card in the chat.
function runTool(name, input) {
  const a = input && typeof input === 'object' ? input : {};
  if (name === 'calendar_list') {
    if (!DATE_ONLY.test(a.from || '') || !DATE_ONLY.test(a.to || '')) return { output: 'Ошибка: from и to должны быть датами YYYY-MM-DD.', error: true };
    const list = store.calendarView().filter((e) => e.date >= a.from && e.date <= a.to).slice(0, 200)
      .map((e) => ({ id: e.id, date: e.date, from: e.from, to: e.to, title: e.title, kind: e.kind, note: e.note, remind: e.remind }));
    return { output: list.length ? JSON.stringify(list) : 'В этот период дел нет.' };
  }
  if (name === 'calendar_add') {
    const event = DATE_ONLY.test(a.date || '') ? normalizeEvent({ date: a.date, from: a.from, to: a.to, title: a.title, kind: a.kind, note: a.note, remind: a.remind }) : null;
    if (!event) return { output: 'Ошибка: нужна дата YYYY-MM-DD и время HH:MM.', error: true };
    return {
      output: 'Пользователю показана карточка «Добавить в календарь: ' + eventLine(event) + '». Дело появится, только если он нажмёт «Добавить». Коротко попроси подтвердить.',
      action: { kind: 'calendar-add', title: event.title, event }
    };
  }
  if (name === 'calendar_delete') {
    const event = store.findEvent(String(a.id || ''));
    if (!event) return { output: 'Дела с таким id нет. Найди его через calendar_list.', error: true };
    return {
      output: 'Пользователю показана карточка «Удалить из календаря: ' + eventLine(event) + '». Дело удалится, только если он нажмёт «Удалить».',
      action: { kind: 'calendar-delete', title: event.title, event }
    };
  }
  return { output: 'Такого инструмента нет.', error: true };
}
const MAX_TOOL_ROUNDS = 6;

const keyPath = (provider) => path.join(app.getPath('userData'), PROVIDERS[provider].file);
const keys = { openai: null, anthropic: null };

function loadKeys() {
  Object.keys(PROVIDERS).forEach((pr) => {
    try { keys[pr] = safeStorage.decryptString(fs.readFileSync(keyPath(pr))) || null; } catch (e) { keys[pr] = null; }
  });
}
const modelById = (id) => MODELS.find((m) => m.id === id) || null;

/* Spending. Neither OpenAI nor Anthropic tells an ordinary API key how much money is left, so the program
   counts what its own answers cost from the token counts each answer reports, at these prices
   (dollars per million tokens). Where the price of cached input is unknown, the full input price is used,
   so the estimate errs on the high side. If the user types how much they put on the account,
   "осталось" is that amount minus what was spent since. Stored in settings.json, without any key. */
const PRICES = {
  'gpt-6.1-sol': { input: 2, cached: 0.10, output: 10 },
  'gpt-6-luna': { input: 0.10, cached: 0.10, output: 0.50 },
  'gpt-6-astra': { input: 10, cached: 10, output: 50 },
  'claude-opus-5-5': { input: 4, cacheWrite: 5, cached: 0.20, output: 20 },
  'claude-haiku-5-5': { input: 0.10, cacheWrite: 0.125, cached: 0.01, output: 0.50 }
};
const monthKey = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); };
function spendOf(provider) {
  settings.spend = settings.spend && typeof settings.spend === 'object' ? settings.spend : {};
  const sp = settings.spend[provider] && typeof settings.spend[provider] === 'object' ? settings.spend[provider] : {};
  if (sp.month !== monthKey()) { sp.month = monthKey(); sp.monthUsd = 0; }
  sp.monthUsd = Number(sp.monthUsd) || 0;
  sp.sinceUsd = Number(sp.sinceUsd) || 0;
  settings.spend[provider] = sp;
  return sp;
}
// usage: { input, cached, cacheWrite, output } in tokens; input is the part billed at the full price.
function recordSpend(model, usage) {
  const price = PRICES[model.id];
  if (!price || !usage) return;
  const usd = ((usage.input || 0) * price.input + (usage.cached || 0) * price.cached +
    (usage.cacheWrite || 0) * (price.cacheWrite || price.input) + (usage.output || 0) * price.output) / 1e6;
  if (!(usd > 0)) return;
  const sp = spendOf(model.provider);
  sp.monthUsd += usd;
  sp.sinceUsd += usd;
  saveSettings();
}
function spendInfo() {
  const out = {};
  Object.keys(PROVIDERS).forEach((pr) => {
    const sp = spendOf(pr);
    const bal = settings.balance && settings.balance[pr];
    const amount = bal && Number(bal.amount) > 0 ? Number(bal.amount) : null;
    out[pr] = { month: sp.monthUsd, amount, left: amount === null ? null : Math.max(0, amount - sp.sinceUsd) };
  });
  return out;
}
// The chosen model if its provider has a key; otherwise the first model that can answer; otherwise the choice as is.
function currentModel() {
  const chosen = modelById(settings.assistantModel);
  if (chosen && keys[chosen.provider]) return chosen;
  return MODELS.find((m) => keys[m.provider]) || chosen || MODELS[0];
}
function currentEffort() { return EFFORTS.includes(settings.assistantEffort) ? settings.assistantEffort : DEFAULT_EFFORT; }
function assistantInfo() {
  return {
    hasKey: !!(keys.openai || keys.anthropic),
    keys: { openai: !!keys.openai, anthropic: !!keys.anthropic },
    model: currentModel().id, effort: currentEffort(), models: MODELS, efforts: EFFORTS,
    spend: spendInfo(), notify: settings.notify !== false
  };
}

// OpenAI reports an empty balance as 429, like a rate limit: the code inside tells them apart.
const OPENAI_BILLING = ['insufficient_quota', 'credit_balance_exhausted', 'billing_not_active', 'billing_hard_limit_reached',
  'organization_spend_limit_exceeded', 'project_spend_limit_exceeded', 'organization_usage_limit_exceeded', 'usage_limit_exceeded'];
const isBilling = (e) =>
  (e instanceof OpenAI.APIError && (OPENAI_BILLING.includes(e.code) || OPENAI_BILLING.includes(e.type))) ||
  (e instanceof Anthropic.APIError && (e.status === 402 || e.type === 'billing_error' || (e.status === 400 && /credit balance/i.test(e.message || ''))));

// Russian text for an SDK error. Subclasses first: APIConnectionError is itself an APIError in both SDKs.
function openaiError(e) {
  if (e instanceof OpenAI.AuthenticationError) return 'Ключ OpenAI не подошёл. Проверьте его в «Настройках» или создайте новый на platform.openai.com.';
  if (isBilling(e)) return 'На счёте OpenAI закончились деньги или достигнут лимит трат. Проверьте баланс на platform.openai.com в разделе Billing.';
  if (e instanceof OpenAI.PermissionDeniedError) return 'OpenAI не дал доступ: у ключа нет прав на эту модель, или сервис не работает в вашей стране.';
  if (e instanceof OpenAI.RateLimitError) return 'Слишком много запросов подряд. Подождите минуту и попробуйте ещё раз.';
  if (e instanceof OpenAI.APIConnectionError) return 'Нет связи с ChatGPT. Проверьте интернет и попробуйте ещё раз.';
  if (e instanceof OpenAI.NotFoundError) return 'Эта модель недоступна для вашего ключа. Выберите другую кнопкой «Модель» в поле ввода.';
  if (e instanceof OpenAI.APIError) {
    if (e.status >= 500) return 'ChatGPT сейчас перегружен. Попробуйте через минуту.';
    return `ChatGPT вернул ошибку (код ${e.status}). Попробуйте ещё раз.`;
  }
  return null;
}
function claudeError(e) {
  if (e instanceof Anthropic.AuthenticationError) return 'Ключ Anthropic не подошёл. Проверьте его в «Настройках» или создайте новый на console.anthropic.com.';
  if (e instanceof Anthropic.PermissionDeniedError) return 'У этого ключа нет доступа к выбранной модели. Выберите другую кнопкой «Модель» в поле ввода.';
  if (e instanceof Anthropic.RateLimitError) return 'Слишком много запросов подряд. Подождите минуту и попробуйте ещё раз.';
  if (e instanceof Anthropic.APIConnectionError) return 'Нет связи с Claude. Проверьте интернет и попробуйте ещё раз.';
  if (isBilling(e)) return 'На счёте Anthropic закончились деньги. Пополните баланс на console.anthropic.com в разделе Billing.';
  if (e instanceof Anthropic.NotFoundError) return 'Эта модель Claude недоступна. Выберите другую кнопкой «Модель» в поле ввода.';
  if (e instanceof Anthropic.APIError) {
    if (e.type === 'overloaded_error' || e.status >= 500) return 'Claude сейчас перегружен. Попробуйте через минуту.';
    return `Claude вернул ошибку (код ${e.status}). Попробуйте ещё раз.`;
  }
  return null;
}
const modelError = (e) => openaiError(e) || claudeError(e);
function userError(text) { const e = new Error(text); e.userMessage = text; return e; }

// OpenAI counts cached tokens inside input_tokens, and thinking inside output_tokens.
function openaiUsage(response) {
  const u = response && response.usage;
  if (!u) return null;
  const cached = (u.input_tokens_details && u.input_tokens_details.cached_tokens) || 0;
  return { input: Math.max(0, (u.input_tokens || 0) - cached), cached, output: u.output_tokens || 0 };
}

// Answers and, when the model asks for a tool, runs it and asks again with the result (at most MAX_TOOL_ROUNDS times).
async function* openaiSource(model, messages, signal) {
  const client = new OpenAI({ apiKey: keys.openai });
  const tools = TOOLS.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: true }));
  let input = messages.map((m) => ({ role: m.role, content: m.content }));
  let wrote = false;
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const stream = await client.responses.create({
      model: model.id,
      instructions: SYSTEM_PROMPT + '\n\n' + nowLine(),
      input,
      tools,
      reasoning: { effort: currentEffort() },
      max_output_tokens: 32000,   // thinking counts too, so leave room at "Максимум"
      store: false,               // do not keep the conversation on OpenAI's servers
      stream: true
    }, { signal });
    let refused = false;
    let final = null;
    for await (const event of stream) {
      if (event.type === 'response.output_item.added' && event.item && event.item.type === 'message' && wrote) yield { type: 'text', text: '\n\n' };
      else if (event.type === 'response.output_text.delta' && event.delta) { wrote = true; yield { type: 'text', text: event.delta }; }
      else if (event.type === 'response.refusal.delta') refused = true;
      else if (event.type === 'response.completed') { final = event.response; recordSpend(model, openaiUsage(event.response)); }
      else if (event.type === 'response.incomplete') {
        recordSpend(model, openaiUsage(event.response));
        const reason = event.response && event.response.incomplete_details && event.response.incomplete_details.reason;
        if (reason === 'content_filter') throw userError('ChatGPT отказался отвечать на этот запрос. Попробуйте сформулировать иначе.');
        throw userError('Ответ получился слишком длинным и оборвался. Попросите продолжить или сократить.');
      } else if (event.type === 'response.failed' || event.type === 'error') {
        const err = event.type === 'error' ? event : (event.response && event.response.error) || {};
        console.error('openai stream', err.code, err.message);
        if (/rate_limit/.test(err.code || '')) throw userError('Слишком много запросов подряд. Подождите минуту и попробуйте ещё раз.');
        if (OPENAI_BILLING.includes(err.code)) throw userError('На счёте OpenAI закончились деньги или достигнут лимит трат. Проверьте баланс на platform.openai.com в разделе Billing.');
        throw userError('ChatGPT не смог ответить. Попробуйте ещё раз.');
      }
    }
    if (refused) throw userError('ChatGPT отказался отвечать на этот запрос. Попробуйте сформулировать иначе.');
    const calls = ((final && final.output) || []).filter((item) => item.type === 'function_call');
    if (!calls.length) return;
    // Nothing is stored on OpenAI's side, so the whole turn (thinking, calls) goes back together with the results.
    input = input.concat(final.output);
    for (const c of calls) {
      let args = null;
      try { args = JSON.parse(c.arguments || '{}'); } catch (e) { args = null; }
      const r = args ? runTool(c.name, args) : { output: 'Ошибка: аргументы не прочитались, повтори вызов.', error: true };
      if (r.action) yield { type: 'action', action: r.action };
      input.push({ type: 'function_call_output', call_id: c.call_id, output: r.output });
    }
  }
}

async function* claudeSource(model, messages, signal) {
  const client = new Anthropic({ apiKey: keys.anthropic });
  const tools = TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters, strict: true }));
  let msgs = messages.slice();
  let wrote = false;
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const params = {
      model: model.id,
      max_tokens: 16000,
      tools,
      // The instructions are cached; the current time goes after them so it does not break the cache.
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }, { type: 'text', text: nowLine() }],
      messages: msgs,
      output_config: { effort: currentEffort() }
    };
    // If Opus declines for safety reasons, the API retries on a suitable model inside the same request.
    // Haiku has no such fallback, so a refusal is shown as an error.
    if (model.id === 'claude-opus-5-5') Object.assign(params, { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
    const stream = client.beta.messages.stream(params, { signal });
    for await (const event of stream) {
      if (event.type === 'content_block_start' && event.content_block.type === 'text' && wrote) yield { type: 'text', text: '\n\n' };
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta' && event.delta.text) {
        wrote = true;
        yield { type: 'text', text: event.delta.text };
      }
    }
    const final = await stream.finalMessage();
    const u = final.usage || {};
    recordSpend(model, { input: u.input_tokens || 0, cached: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, output: u.output_tokens || 0 });
    if (final.stop_reason === 'refusal') throw userError('Claude отказался отвечать на этот запрос. Попробуйте сформулировать иначе.');
    if (final.stop_reason === 'max_tokens') throw userError('Ответ получился слишком длинным и оборвался. Попросите продолжить или сократить.');
    if (final.stop_reason !== 'tool_use') return;
    // The answer goes back unchanged (with its thinking blocks), then all tool results in one message.
    msgs = msgs.concat([{ role: 'assistant', content: final.content }]);
    const results = [];
    for (const b of final.content) {
      if (b.type !== 'tool_use') continue;
      const r = runTool(b.name, b.input);
      if (r.action) yield { type: 'action', action: r.action };
      results.push({ type: 'tool_result', tool_use_id: b.id, content: r.output, is_error: !!r.error });
    }
    msgs.push({ role: 'user', content: results });
  }
}

// Who answers: the chosen model if there is a key for it, otherwise the stub.
function pickSource() {
  const model = currentModel();
  if (!keys[model.provider]) return (messages, signal) => stubSource(messages, signal);
  const source = model.provider === 'openai' ? openaiSource : claudeSource;
  return (messages, signal) => source(model, messages, signal);
}

/* Notifications: when an answer is ready and the window is minimized, hidden or behind another window,
   Windows shows a notification and the taskbar button blinks. A click on it brings the chat back. */
function windowAway() { return !win || win.isDestroyed() || win.isMinimized() || !win.isVisible() || !win.isFocused(); }
// The first words of the answer without Markdown marks, for the notification text.
function plainStart(text) {
  const t = String(text || '').replace(/```[\s\S]*?(```|$)/g, ' ').replace(/[*#`>]/g, '').replace(/^\s*[-•]\s+/gm, '').replace(/\s+/g, ' ').trim();
  return t.length > 140 ? t.slice(0, 139).trimEnd() + '…' : t;
}
function notifyAnswer(text, failed) {
  if (settings.notify === false || !windowAway() || !Notification.isSupported()) return;
  const n = new Notification({
    title: failed ? 'Ассистент не смог ответить' : 'Ассистент ответил',
    body: failed ? String(text || '') : (plainStart(text) || 'Ответ готов'),
    icon: path.join(__dirname, 'assets', 'icon.png')
  });
  n.on('failed', (_e, err) => console.error('notification', err));
  if (!app.isPackaged) n.on('show', () => console.log('notification shown:', n.title));
  n.on('click', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send('assistant-open');
  });
  n.show();
  if (win && !win.isDestroyed()) win.flashFrame(true);
}

async function runAssistant(id, messages, controller) {
  const source = pickSource();
  let full = '';
  try {
    for await (const piece of source(messages, controller.signal)) {
      if (controller.signal.aborted) break;
      if (piece.type === 'text') { full += piece.text; sendAssistant({ id, kind: 'delta', text: piece.text }); }
      else if (piece.type === 'action') {
        const action = Object.assign({ id: 'a' + (++actionSeq) }, piece.action);
        pending.set(action.id, action);
        sendAssistant({ id, kind: 'action', action });
      }
    }
    if (!controller.signal.aborted) {
      sendAssistant({ id, kind: 'done', assistant: assistantInfo() });
      notifyAnswer(full, false);
    }
  } catch (e) {
    if (!controller.signal.aborted) {
      // Service errors are logged by status only: their message can quote part of the key.
      if (e instanceof OpenAI.APIError || e instanceof Anthropic.APIError) console.error('assistant', e.status, e.code || e.type);
      else if (!e.userMessage) console.error('assistant', e);
      const error = e.userMessage || modelError(e) || 'Ассистент не ответил. Попробуйте ещё раз.';
      sendAssistant({ id, kind: 'error', error, assistant: assistantInfo() });
      notifyAnswer(error, true);
    }
  } finally {
    streams.delete(id);
  }
}

// messages: [{ role: 'user' | 'assistant', content: string }], the whole conversation so far.
handle('assistant-send', async (messages) => {
  const list = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content.slice(0, 100000) }));
  if (!list.length || list[list.length - 1].role !== 'user') return { ok: false, error: 'Напишите сообщение.' };
  const id = ++streamSeq;
  const controller = new AbortController();
  streams.set(id, controller);
  runAssistant(id, list, controller);
  return { ok: true, id };
});

handle('assistant-stop', async (id) => {
  const c = streams.get(id);
  if (c) c.abort();
  return { ok: true };
});

// Calendar, stored in calendar.json beside the prompts.
handle('cal-save', async (ev) => { const saved = await store.saveEvent(ev); return ok({ id: saved.id, date: saved.date }); });
handle('cal-delete', async (id) => { await store.deleteEvent(id); return ok(); });

/* Reminders: every 20 seconds main.js looks for events whose reminder time has come (up to 5 minutes late,
   so a reminder missed while the program was closed does not pop up hours later) and shows a notification. */
const reminded = new Set();
function remindLabel(min) { return min >= 1440 ? 'завтра' : min >= 60 ? 'через час' : 'через ' + min + ' минут'; }
function checkReminders() {
  if (!store) return;
  const now = Date.now();
  store.events.forEach((e) => {
    if (!e.remind) return;
    const start = dateOfKey(e.date).getTime() + (+e.from.slice(0, 2) * 60 + +e.from.slice(3)) * 60000;
    const at = start - e.remind * 60000;
    const key = [e.id, e.date, e.from, e.remind].join('|');
    if (now < at || now > at + 5 * 60000 || reminded.has(key)) return;
    reminded.add(key);
    if (!Notification.isSupported()) return;
    const n = new Notification({
      title: 'Напоминание: ' + e.title,
      body: (e.remind >= 1440 ? 'Завтра' : 'Сегодня') + ' в ' + e.from + (e.to ? '–' + e.to : '') + ', ' + remindLabel(e.remind) + (e.note ? '. ' + e.note : ''),
      icon: path.join(__dirname, 'assets', 'icon.png')
    });
    n.on('failed', (_e, err) => console.error('notification', err));
    if (!app.isPackaged) n.on('show', () => console.log('notification shown:', n.title));
    n.on('click', () => {
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      win.webContents.send('calendar-open', e.date);
    });
    n.show();
    if (windowAway() && win && !win.isDestroyed()) win.flashFrame(true);
  });
}

// History of conversations, stored in chats.json beside the prompts.
handle('chat-list', async () => ({ ok: true, chats: store.chatList() }));
handle('chat-get', async (id) => {
  const chat = store.getChat(id);
  return chat ? { ok: true, chat } : { ok: false, error: 'Этот разговор не найден. Возможно, его удалили.' };
});
handle('chat-save', async (chat) => {
  const saved = await store.saveChat(chat);
  return { ok: true, chats: store.chatList(), id: saved && saved.id };
});
handle('chat-delete', async (id) => { await store.deleteChat(id); return { ok: true, chats: store.chatList() }; });

// "Новый разговор" or opening another one: stop whatever is still being written and forget the cards nobody answered.
handle('assistant-reset', async () => {
  streams.forEach((c) => c.abort());
  pending.clear();
  return { ok: true };
});

// The user pressed "Создать" (accept) or "Отмена" on a card the assistant suggested.
handle('assistant-decide', async (actionId, accept) => {
  const action = pending.get(actionId);
  if (!action) return { ok: false, error: 'Эта карточка устарела. Попросите ассистента ещё раз.' };
  pending.delete(actionId);
  if (!accept) return { ok: true };
  if (action.kind === 'create-prompt') {
    const r = await store.savePrompt({ item: { title: action.title, type: action.category, text: action.text } });
    return ok(r);
  }
  if (action.kind === 'calendar-add') {
    const ev = await store.saveEvent(Object.assign({}, action.event, { id: undefined }));
    return ok({ eventId: ev.id, date: ev.date });
  }
  if (action.kind === 'calendar-delete') {
    const gone = await store.deleteEvent(action.event.id);
    if (!gone) return { ok: false, error: 'Этого дела уже нет в календаре.' };
    return ok({ date: gone.date });
  }
  return { ok: false, error: 'Такое действие ассистент пока не умеет.' };
});

// key: a new key from the settings field, or empty to check the saved one. A new key is saved only if it works
// (or if it is right but the account has no money yet: then it starts working as soon as the balance is topped up).
// The check is one tiny request to the provider's cheapest model.
async function tryKey(provider, k) {
  if (provider === 'openai') {
    const client = new OpenAI({ apiKey: k, maxRetries: 1, timeout: 30 * 1000 });
    await client.responses.create({ model: 'gpt-6-luna', input: 'Ответь одним словом: готово', reasoning: { effort: 'none' }, max_output_tokens: 16, store: false });
  } else {
    const client = new Anthropic({ apiKey: k, maxRetries: 1, timeout: 30 * 1000 });
    await client.messages.create({
      model: 'claude-haiku-5-5', max_tokens: 64, output_config: { effort: 'low' },
      messages: [{ role: 'user', content: 'Ответь одним словом: готово' }]
    });
  }
}

handle('assistant-check-key', async (provider, key) => {
  const pr = PROVIDERS[provider];
  if (!pr) return { ok: false, error: 'Неизвестный сервис.' };
  const fresh = typeof key === 'string' ? key.trim() : '';
  const k = fresh || keys[provider];
  if (!k) return { ok: false, error: 'Вставьте ключ в поле.' };
  if (fresh && provider === 'openai' && PROVIDERS.anthropic.keyRe.test(fresh)) return { ok: false, error: 'Это ключ Anthropic (Claude). Вставьте его в поле Claude ниже.' };
  if (fresh && provider === 'anthropic' && PROVIDERS.openai.keyRe.test(fresh)) return { ok: false, error: 'Это ключ OpenAI (ChatGPT). Вставьте его в поле ChatGPT выше.' };
  if (fresh && !pr.keyRe.test(fresh)) return { ok: false, error: pr.keyHint };
  if (fresh && !safeStorage.isEncryptionAvailable()) return { ok: false, error: 'Windows не дал зашифровать ключ, поэтому он не сохранён.' };
  let warning = null;
  try {
    await tryKey(provider, k);
  } catch (e) {
    if (e instanceof OpenAI.AuthenticationError || e instanceof Anthropic.AuthenticationError) {
      return { ok: false, error: 'Ключ не подошёл. Проверьте, что скопировали его целиком, или создайте новый.' };
    }
    if (!isBilling(e)) { console.error('check-key', provider, e && e.status, e && e.code); return { ok: false, error: modelError(e) || 'Не получилось проверить ключ. Попробуйте ещё раз.' }; }
    warning = modelError(e);
  }
  if (fresh) {
    await fsp.mkdir(path.dirname(keyPath(provider)), { recursive: true });
    await fsp.writeFile(keyPath(provider), safeStorage.encryptString(fresh));
    keys[provider] = fresh;
  }
  return { ok: true, saved: !!fresh, warning, info: info() };
});

handle('assistant-delete-key', async (provider) => {
  if (!PROVIDERS[provider]) return { ok: false, error: 'Неизвестный сервис.' };
  await fsp.rm(keyPath(provider), { force: true });
  keys[provider] = null;
  return { ok: true, info: info() };
});

// amount: dollars the user put on the account (counting restarts from now), or null to forget it.
handle('assistant-set-balance', async (provider, amount) => {
  if (!PROVIDERS[provider]) return { ok: false, error: 'Неизвестный сервис.' };
  const n = amount === null || amount === '' ? null : Number(String(amount).replace(',', '.'));
  if (n !== null && !(n > 0 && n < 1e6)) return { ok: false, error: 'Введите сумму в долларах, например 10.' };
  settings.balance = settings.balance && typeof settings.balance === 'object' ? settings.balance : {};
  if (n === null) delete settings.balance[provider];
  else { settings.balance[provider] = { amount: Math.round(n * 100) / 100, setAt: Date.now() }; spendOf(provider).sinceUsd = 0; }
  saveSettings();
  return { ok: true, info: info() };
});

handle('set-notify', async (on) => {
  settings.notify = !!on;
  saveSettings();
  return { ok: true, info: info() };
});

// opts: { model?, effort? } from the "Модель" button in the message box.
handle('assistant-set-options', async (opts) => {
  const o = opts || {};
  if (o.model !== undefined && !modelById(o.model)) return { ok: false, error: 'Такой модели нет.' };
  if (o.effort !== undefined && !EFFORTS.includes(o.effort)) return { ok: false, error: 'Такого уровня нет.' };
  if (o.model !== undefined) settings.assistantModel = o.model;
  if (o.effort !== undefined) settings.assistantEffort = o.effort;
  saveSettings();
  return { ok: true, info: info() };
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
    loadKeys();
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
    setupUpdates();
    setInterval(checkReminders, 20 * 1000);
    setTimeout(checkReminders, 3000);
  });

  app.on('before-quit', () => saveSettings(true));
  app.on('window-all-closed', () => { saveSettings(true); app.quit(); });
}
