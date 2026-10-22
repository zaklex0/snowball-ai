'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeTheme, nativeImage, Menu, screen, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const Anthropic = require('@anthropic-ai/sdk').default;
const { Store, copyDataTo, hasData } = require('./storage');

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
  return Object.assign({ ok: true, prompts: store.view(), profile: store.profileView(), activity: store.activityView() }, extra || {});
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
// Replies come from a source: an async generator of { type: 'text', text } and { type: 'action', … }.
// For now the only source is the stub below; Claude will be a second source with the same shape.
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
        'Это заготовка. Настоящий Claude будет улучшать именно ваш текст.'
    };
  }
  if (/календар|встреч|созвон|звон|задач|напомни/.test(t)) {
    return {
      text: 'Календарь появится на следующих этапах. Тогда можно будет написать, например, ' +
        '**«поставь созвон с монтажёром на завтра в 15:00»**, и я предложу карточку с делом. ' +
        'В календарь оно попадёт только после вашего подтверждения.'
    };
  }
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
    text += '\n\nКогда подключим Claude, я буду искать по смыслу, а не только по словам.';
    return { text };
  }
  return {
    text: 'Привет! Я пока тестовый ассистент: отвечаю заготовками, чтобы можно было посмотреть, как всё будет выглядеть.\n\n' +
      'Когда подключим Claude, я смогу:\n' +
      '- придумать или улучшить промт для картинки или видео;\n' +
      '- найти нужный промт среди ваших;\n' +
      '- сохранить новый промт в таблицу, но только после вашего «Создать».\n\n' +
      'Попробуйте написать: **добавь промт «Неоновый город»** или **улучши промт: кот в космосе**.'
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
  if (answer.action) yield Object.assign({ type: 'action' }, answer.action);
}

/* Claude. Each user brings their own API key (the repository is public, so the program has none).
   The key is encrypted with Windows (safeStorage) into %APPDATA%\Snowball.ai\claude-key.bin,
   lives decrypted only here in main.js and never goes to the window. Without a key the stub answers. */
const MODELS = ['claude-opus-5-5', 'claude-haiku-5-5'];
const DEFAULT_MODEL = 'claude-opus-5-5';
// How long Claude thinks before answering, like the levels in Claude itself: deeper is slower and costs more.
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const DEFAULT_EFFORT = 'medium';
const CHECK_MODEL = 'claude-haiku-5-5';   // "Проверить ключ" sends one tiny request to the cheapest model
const SYSTEM_PROMPT = [
  'Ты — ассистент в программе Snowball.ai. В ней пользователь хранит промты для нейросетей, которые делают картинки и видео: Midjourney, Nano Banana, GPT Image, Seedream, Kling, Seedance, Runway и другие.',
  'Ты помогаешь придумывать новые промты, улучшать и разбирать готовые, переводить их и подстраивать под нужную нейросеть.',
  'Отвечай по-русски, коротко и по делу, если не просят подробнее. Пользователь не программист: объясняй простыми словами, без жаргона.',
  'Сам промт пиши на том языке, который лучше понимает нужная нейросеть (обычно английский). Каждый готовый промт помещай в отдельный блок кода ```, чтобы его можно было скопировать одной кнопкой.',
  'Если не хватает важной детали (для какой нейросети, картинка или видео, соотношение сторон), сначала предложи вариант, а потом коротко спроси.',
  'Из разметки используй только абзацы, списки, **жирный** и блоки кода. Таблицы не используй: программа их не показывает.',
  'Ты пока не умеешь сам сохранять промты, смотреть промты пользователя и вести календарь. Если об этом просят, скажи, что это появится позже, а пока промт можно скопировать кнопкой «Копировать» и добавить через «Добавить промт» в разделе «Промты».'
].join('\n\n');

const keyPath = () => path.join(app.getPath('userData'), 'claude-key.bin');
let apiKey = null;

function loadKey() {
  try { apiKey = safeStorage.decryptString(fs.readFileSync(keyPath())) || null; } catch (e) { apiKey = null; }
}
function currentModel() { return MODELS.includes(settings.assistantModel) ? settings.assistantModel : DEFAULT_MODEL; }
function currentEffort() { return EFFORTS.includes(settings.assistantEffort) ? settings.assistantEffort : DEFAULT_EFFORT; }
function assistantInfo() { return { hasKey: !!apiKey, model: currentModel(), effort: currentEffort(), models: MODELS, efforts: EFFORTS }; }

const isBilling = (e) => e instanceof Anthropic.APIError &&
  (e.status === 402 || e.type === 'billing_error' || (e.status === 400 && /credit balance/i.test(e.message || '')));

// Russian text for an SDK error. Subclasses first: APIConnectionError is itself an APIError.
function claudeError(e) {
  if (e instanceof Anthropic.AuthenticationError) return 'Ключ не подошёл. Проверьте его в «Настройках» или создайте новый на console.anthropic.com.';
  if (e instanceof Anthropic.PermissionDeniedError) return 'У этого ключа нет доступа к выбранной модели. Выберите другую модель в «Настройках».';
  if (e instanceof Anthropic.RateLimitError) return 'Слишком много запросов подряд. Подождите минуту и попробуйте ещё раз.';
  if (e instanceof Anthropic.APIConnectionError) return 'Нет связи с Claude. Проверьте интернет и попробуйте ещё раз.';
  if (isBilling(e)) return 'На счёте Anthropic закончились деньги. Пополните баланс на console.anthropic.com в разделе Billing.';
  if (e instanceof Anthropic.NotFoundError) return 'Эта модель Claude недоступна. Выберите другую в «Настройках».';
  if (e instanceof Anthropic.APIError) {
    if (e.type === 'overloaded_error' || e.status >= 500) return 'Claude сейчас перегружен. Попробуйте через минуту.';
    return `Claude вернул ошибку (код ${e.status}). Попробуйте ещё раз.`;
  }
  return null;
}
function userError(text) { const e = new Error(text); e.userMessage = text; return e; }

async function* claudeSource(messages, signal) {
  const client = new Anthropic({ apiKey });
  const model = currentModel();
  const params = {
    model,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    messages,
    cache_control: { type: 'ephemeral' },
    output_config: { effort: currentEffort() }
  };
  // If Opus declines for safety reasons, the API retries on a suitable model inside the same request.
  // Haiku has no such fallback, so a refusal is shown as an error.
  if (model === 'claude-opus-5-5') Object.assign(params, { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  const stream = client.beta.messages.stream(params, { signal });
  let wrote = false;
  for await (const event of stream) {
    if (event.type === 'content_block_start' && event.content_block.type === 'text' && wrote) yield { type: 'text', text: '\n\n' };
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta' && event.delta.text) {
      wrote = true;
      yield { type: 'text', text: event.delta.text };
    }
  }
  const final = await stream.finalMessage();
  if (final.stop_reason === 'refusal') throw userError('Claude отказался отвечать на этот запрос. Попробуйте сформулировать иначе.');
  if (final.stop_reason === 'max_tokens') throw userError('Ответ получился слишком длинным и оборвался. Попросите продолжить или сократить.');
}

async function runAssistant(id, messages, controller) {
  const source = apiKey ? claudeSource : stubSource;
  try {
    for await (const piece of source(messages, controller.signal)) {
      if (controller.signal.aborted) break;
      if (piece.type === 'text') sendAssistant({ id, kind: 'delta', text: piece.text });
      else if (piece.type === 'action') {
        const action = { id: 'a' + (++actionSeq), kind: piece.kind, title: piece.title, category: piece.category, text: piece.text };
        pending.set(action.id, action);
        sendAssistant({ id, kind: 'action', action });
      }
    }
    if (!controller.signal.aborted) sendAssistant({ id, kind: 'done' });
  } catch (e) {
    if (!controller.signal.aborted) {
      if (!e.userMessage) console.error('assistant', e);
      sendAssistant({ id, kind: 'error', error: e.userMessage || claudeError(e) || 'Ассистент не ответил. Попробуйте ещё раз.' });
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
  return { ok: false, error: 'Такое действие ассистент пока не умеет.' };
});

// key: a new key from the settings field, or empty to check the saved one. A new key is saved only if it works
// (or if it is right but the account has no money yet: then it starts working as soon as the balance is topped up).
handle('assistant-check-key', async (key) => {
  const fresh = typeof key === 'string' ? key.trim() : '';
  const k = fresh || apiKey;
  if (!k) return { ok: false, error: 'Вставьте ключ в поле.' };
  if (fresh && !/^sk-ant-\S+$/.test(fresh)) return { ok: false, error: 'Это не похоже на ключ Anthropic: он начинается с sk-ant- и пишется без пробелов.' };
  if (fresh && !safeStorage.isEncryptionAvailable()) return { ok: false, error: 'Windows не дал зашифровать ключ, поэтому он не сохранён.' };
  let warning = null;
  try {
    const client = new Anthropic({ apiKey: k, maxRetries: 1, timeout: 30 * 1000 });
    await client.messages.create({
      model: CHECK_MODEL, max_tokens: 64, output_config: { effort: 'low' },
      messages: [{ role: 'user', content: 'Ответь одним словом: готово' }]
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return { ok: false, error: 'Ключ не подошёл. Проверьте, что скопировали его целиком, или создайте новый на console.anthropic.com.' };
    if (!isBilling(e)) { console.error('check-key', e && e.status); return { ok: false, error: claudeError(e) || 'Не получилось проверить ключ. Попробуйте ещё раз.' }; }
    warning = claudeError(e);
  }
  if (fresh) {
    await fsp.mkdir(path.dirname(keyPath()), { recursive: true });
    await fsp.writeFile(keyPath(), safeStorage.encryptString(fresh));
    apiKey = fresh;
  }
  return { ok: true, saved: !!fresh, warning, info: info() };
});

handle('assistant-delete-key', async () => {
  await fsp.rm(keyPath(), { force: true });
  apiKey = null;
  return { ok: true, info: info() };
});

// opts: { model?, effort? } from the "Модель" button in the message box.
handle('assistant-set-options', async (opts) => {
  const o = opts || {};
  if (o.model !== undefined && !MODELS.includes(o.model)) return { ok: false, error: 'Такой модели нет.' };
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
    loadKey();
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
  });

  app.on('before-quit', () => saveSettings(true));
  app.on('window-all-closed', () => { saveSettings(true); app.quit(); });
}
