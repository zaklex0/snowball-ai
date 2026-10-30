'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeTheme, nativeImage, Menu, screen, safeStorage, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const Anthropic = require('@anthropic-ai/sdk').default;
const OpenAI = require('openai').default;
const { toFile } = require('openai');
const os = require('os');
const { Store, copyDataTo, hasData, normalizeEvent, normalizeTask, sanitizeName, SKILL_TYPES, skillKind, readSkillFile, skillTitle } = require('./storage');
const { writeZip, extractZip, readZipIndex } = require('./archive');
const setupScreenshots = require('./screenshots');

const APP_TITLE = 'Snowball.ai';
// Names used by earlier versions (newest first). Their data folder and settings are moved over on first start.
const LEGACY_TITLES = ['Промты Snowball.ai', 'Промты VideoSmile'];
const IS_WIN = process.platform === 'win32';
const TITLEBAR_HEIGHT = 40;
const SIDEBAR_WIDTH = 236;   // .side in styles.css; a window with one moved tab has no sidebar
let sideWidth = SIDEBAR_WIDTH;   // where the main window's sidebar ends now (folded, it is a strip of icons): 'side-width'
// "white" and "black" are a light and a dark theme with neutral colours instead of the warm ones.
// "macos" (beta) is the macOS look with glass (src/theme-macos.css): its accent colour and light/dark come from
// settings.macAccent and settings.macLook. "zaklex" was here until 1.17.1 (now in archive/theme-zaklex).
const THEMES = ['system', 'light', 'dark', 'white', 'black', 'macos'];
const MAC_ACCENTS = ['peach', 'blue', 'purple', 'pink', 'red', 'yellow', 'green', 'graphite'];
const MAC_LOOKS = ['system', 'light', 'dark'];
// Windows 11 22H2 and newer draw a blurred desktop behind the window (acrylic); older Windows get a painted background.
const GLASS_OK = IS_WIN && Number(os.release().split('.')[2]) >= 22621;
// What a tab on top of the window can show. LLM ("assistant") tabs may be open many times, one conversation each.
const TAB_KINDS = ['home', 'prompts', 'calendar', 'tasks', 'assistant', 'transcribe', 'screenshots', 'generator', 'stats'];

// Prompts a fresh install starts with (only when the data folder has no prompts.json yet).
// Empty for now; example prompts for each type can go here later.
const SEED = () => [];

let win = null;   // the main window: its size, place and tabs are remembered; other windows come from moved tabs
let store = null;
let settings = {};
let captures = null;
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
function currentTheme() { return THEMES.includes(settings.theme) ? settings.theme : 'system'; }
function macAccent() { return MAC_ACCENTS.includes(settings.macAccent) ? settings.macAccent : 'peach'; }
function macLook() { return MAC_LOOKS.includes(settings.macLook) ? settings.macLook : 'system'; }
// The removed "Zaklex" was a dark theme: its users get the dark macOS look instead.
function migrateTheme(s) {
  if (s.theme !== 'zaklex') return;
  s.theme = 'macos';
  if (!s.macLook) s.macLook = 'dark';
}
function applyTheme() {
  const t = currentTheme();
  nativeTheme.themeSource = t === 'black' ? 'dark' : t === 'white' ? 'light' : t === 'macos' ? macLook() : t;
}
// The window shows the blurred desktop through the page (the macOS theme on Windows 11).
function glassOn() { return GLASS_OK && currentTheme() === 'macos'; }

// Title bar and window background for each theme (the page draws the rest).
// macOS: the Windows buttons have no plate of their own, they sit on the glass like the rest of the bar.
const WINDOW_COLORS = {
  light: { bar: '#F9E3D4', symbol: '#4B3128', bg: '#FCEEE4' },
  dark: { bar: '#2C201B', symbol: '#F5E6DC', bg: '#251B17' },
  white: { bar: '#F7F7F8', symbol: '#1F1F23', bg: '#FFFFFF' },
  black: { bar: '#000000', symbol: '#F2F2F2', bg: '#000000' },
  'macos-light': { bar: '#00000000', symbol: '#1D1D1F', bg: '#EDEDF0' },
  'macos-dark': { bar: '#00000000', symbol: '#F5F5F7', bg: '#1E1E21' }
};
function windowColors() {
  const t = currentTheme(), dark = nativeTheme.shouldUseDarkColors;
  if (t === 'macos') return WINDOW_COLORS[dark ? 'macos-dark' : 'macos-light'];
  return WINDOW_COLORS[t === 'system' ? (dark ? 'dark' : 'light') : t];
}
// dim: a dialog is open over the window, so the page is darkened by its backdrop (see ::backdrop in styles.css); the Windows
// buttons are drawn by the system above the page and are not darkened by it, so they get the same shade here.
function shade(hex, dark, a) {
  const n = parseInt(hex.slice(1), 16), out = [n >> 16 & 255, n >> 8 & 255, n & 255].map((v, i) => Math.round(v * (1 - a) + dark[i] * a));
  return '#' + out.map((v) => v.toString(16).padStart(2, '0')).join('');
}
function overlayColors(dim) {
  const c = windowColors();
  if (!dim) return { color: c.bar, symbolColor: c.symbol, height: TITLEBAR_HEIGHT };
  // macOS: the bar is see-through, so it gets the same light veil as the page under a dialog (::backdrop in theme-macos.css)
  if (currentTheme() === 'macos') return { color: '#0000002E', symbolColor: shade(c.symbol, [0, 0, 0], 0.18), height: TITLEBAR_HEIGHT };
  return { color: shade(c.bar, [30, 18, 12], 0.55), symbolColor: shade(c.symbol, [30, 18, 12], 0.55), height: TITLEBAR_HEIGHT };
}
const dimmedWins = new WeakSet();
function bgColor() { return glassOn() ? '#00000000' : windowColors().bg; }
function setGlass(w) {
  if (!GLASS_OK) return;
  try { w.setBackgroundMaterial(glassOn() ? 'acrylic' : 'none'); } catch (e) { /* older Windows */ }
}

function visibleBounds(b) {
  if (!b || !b.width || !b.height) return null;
  const onScreen = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x < a.x + a.width - 80 && b.x + b.width > a.x + 80 && b.y >= a.y - 10 && b.y < a.y + a.height - 80;
  });
  return onScreen ? b : { width: b.width, height: b.height };
}

/* ---------- windows ---------- */
const liveWins = () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && !w.__snowCapture);
// The window the user works in now: dialogs open over it, a click on a notification brings it back.
function activeWin() { const f = BrowserWindow.getFocusedWindow(); return f && !f.isDestroyed() ? f : win; }
function showWin(w) { if (!w || w.isDestroyed()) return; if (w.isMinimized()) w.restore(); w.show(); w.focus(); }
function broadcast(channel, data, except) {
  liveWins().forEach((w) => { if (w.webContents !== except) w.webContents.send(channel, data); });
}
// Background and the colour of the Windows buttons, in every window.
function paintWindows() {
  if (captures) captures.theme();
  liveWins().forEach((w) => {
    setGlass(w);
    w.setBackgroundColor(bgColor());
    if (IS_WIN) { try { w.setTitleBarOverlay(overlayColors(dimmedWins.has(w))); } catch (e) { /* older Windows */ } }
  });
}

// opts.tabs: the tabs a new window opens with (a tab moved out of another window); opts.bounds: where it goes.
// Without opts it is the main window, at the size and place remembered last time.
function createWindow(opts) {
  opts = opts || {};
  const main = !opts.tabs;
  const b = opts.bounds || visibleBounds(settings.bounds) || { width: 1180, height: 820 };
  const w = new BrowserWindow({
    ...b,
    minWidth: 420,
    minHeight: 480,
    title: APP_TITLE,
    show: false,
    backgroundColor: bgColor(),
    ...(glassOn() ? { backgroundMaterial: 'acrylic' } : {}),
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
  if (main) win = w;
  if (main && settings.maximized) w.maximize();

  w.loadFile(path.join(__dirname, 'src', 'index.html'), main ? undefined : { query: { tabs: JSON.stringify(opts.tabs) } });
  w.once('ready-to-show', () => w.show());

  w.webContents.on('did-finish-load', () => {
    // The program was started by a double click on a file: open it once the page is ready.
    if (main && pendingArchive) { const f = pendingArchive; pendingArchive = null; setTimeout(() => openArchiveFromOS(f), 600); }
    if (settings.zoom) w.webContents.setZoomFactor(settings.zoom);
  });

  // Keep the app on its own page; real web links open in the browser.
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Zoom with Ctrl + / Ctrl - / Ctrl 0 (there is no menu bar to provide it).
  w.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return;
    const wc = w.webContents;
    let z = wc.getZoomFactor();
    if (input.code === 'Equal' || input.code === 'NumpadAdd') z = Math.min(2, z + 0.1);
    else if (input.code === 'Minus' || input.code === 'NumpadSubtract') z = Math.max(0.6, z - 0.1);
    else if (input.code === 'Digit0' || input.code === 'Numpad0') z = 1;
    else return;
    e.preventDefault();
    z = Math.round(z * 10) / 10;
    liveWins().forEach((x) => x.webContents.setZoomFactor(z));
    settings.zoom = z;
    saveSettings();
  });

  // Only the main window's size and place are remembered.
  const rememberBounds = () => {
    if (w !== win || w.isDestroyed()) return;
    settings.maximized = w.isMaximized();
    if (!w.isMaximized() && !w.isMinimized() && !w.isFullScreen()) settings.bounds = w.getBounds();
    saveSettings();
  };
  w.on('resize', rememberBounds);
  w.on('move', rememberBounds);
  w.on('maximize', rememberBounds);
  w.on('unmaximize', rememberBounds);
  w.on('close', () => { rememberBounds(); saveSettings(true); });
  // Screenshot windows belong to the app, and must not outlive its last regular window.
  w.on('close', event => {
    if (liveWins().length === 1 && captures) captures.releaseOverlays();
    if (w.__captureCloseReady || liveWins().length !== 1 || !captures || !captures.hasAuxiliary()) return;
    event.preventDefault();
    if (w.__captureClosing) return;
    w.__captureClosing = true;
    captures.closeAuxiliary().then(() => {
      w.__captureCloseReady = true;
      w.close();
    }).catch(error => {
      w.__captureClosing = false;
      showWin(w);
      dialog.showErrorBox(APP_TITLE, error.message);
    });
  });

  w.on('focus', async () => {
    w.flashFrame(false);
    if (!store) return;
    try {
      if (await store.reloadIfChanged()) broadcast('data-changed', store.view());
    } catch (e) { /* ignore */ }
  });
  // A separate window dragged by its title bar over the main window's tab strip turns see-through, and the main window
  // shows where its tab will go («Отпустите — вкладка вернётся сюда»). Letting go there brings the tab back (return-tab).
  let catching = false;
  const catchAt = (at) => {
    if (!at && !catching) return;
    catching = !!at;
    if (!w.isDestroyed()) w.setOpacity(at ? 0.6 : 1);
    if (win && !win.isDestroyed()) win.webContents.send('tab-hover', at);
  };
  w.on('move', () => { if (w !== win) catchAt(overTabStrip(screen.getCursorScreenPoint())); });
  w.on('moved', () => {
    if (w === win || !catching) return;
    const at = overTabStrip(screen.getCursorScreenPoint());
    catchAt(null);
    if (at && !w.isDestroyed()) w.webContents.send('return-tab', at);
  });

  // When the main window closes and others stay, the next one becomes the main window (and remembers its tabs).
  w.on('closed', () => {
    if (w !== win) return;
    win = liveWins()[0] || null;
    if (win) win.webContents.send('window-main');
  });
  return w;
}

// Where a point of the screen falls on the main window's tab strip: { x } in its page's pixels, or null when it is not there.
// The strip is the title bar right of the sidebar, without the place where Windows draws its own buttons.
function overTabStrip(p) {
  if (!win || win.isDestroyed() || win.isMinimized() || !win.isVisible()) return null;
  const b = win.getContentBounds(), zoom = win.webContents.getZoomFactor();
  const left = b.x + sideWidth * zoom, right = b.x + b.width - (IS_WIN ? 150 : 0), bottom = b.y + TITLEBAR_HEIGHT * zoom;
  if (p.x < left || p.x > right || p.y < b.y - 4 || p.y > bottom + 6) return null;
  return { x: Math.round((p.x - b.x) / zoom) };
}

// The main window tells where its sidebar ends: it can be folded into a strip of icons.
handle('side-width', async function (width) {
  if (BrowserWindow.fromWebContents(this.sender) === win && Number.isFinite(width)) sideWidth = Math.max(0, Math.min(400, Math.round(width)));
  return { ok: true };
});

// The tab of a separate window goes back into the main window (dropped on its tab strip or «Вернуть»);
// x: where on the strip, or nothing for the end. The separate window closes.
handle('window-return', async function (tab, x) {
  const from = BrowserWindow.fromWebContents(this.sender);
  if (!win || win.isDestroyed() || !from || from === win) return { ok: false, error: 'Основного окна нет: эта вкладка и так в нём.' };
  if (!tab || !TAB_KINDS.includes(tab.kind)) return { ok: false, error: 'Нечего вернуть.' };
  const desc = tab.kind === 'assistant' && typeof tab.chatId === 'string' ? { kind: tab.kind, chatId: tab.chatId.slice(0, 64) } : { kind: tab.kind };
  win.webContents.send('tab-insert', { tab: desc, x: Number.isFinite(x) ? x : null });
  showWin(win);
  setTimeout(() => { if (!from.isDestroyed()) from.close(); }, 50);
  return { ok: true };
});

// A tab moved into a window of its own (it shows only that tab, without the sidebar, so it is narrower).
// mode 'point': the new window opens where the tab was dropped; otherwise a little lower and to the right.
// Halves of the screen, full screen and other monitors are Windows' own business (Win + arrows, dragging the window).
handle('window-open', async function (tabs, mode, point) {
  const list = (Array.isArray(tabs) ? tabs : []).filter((x) => x && TAB_KINDS.includes(x.kind)).slice(0, 10)
    .map((x) => (x.kind === 'assistant' && typeof x.chatId === 'string' ? { kind: x.kind, chatId: x.chatId.slice(0, 64) } : { kind: x.kind }));
  if (!list.length) return { ok: false, error: 'Нечего открыть.' };
  const from = BrowserWindow.fromWebContents(this.sender) || win;
  const fb = from.getNormalBounds ? from.getNormalBounds() : from.getBounds();
  const atPoint = mode === 'point' && point && Number.isFinite(point.x) && Number.isFinite(point.y);
  // As wide as the window it came from without the sidebar, but never more than 3/4 of the screen it lands on
  // (otherwise a tab pulled out of a full-screen window would cover everything).
  const wa = (atPoint ? screen.getDisplayNearestPoint({ x: Math.round(point.x), y: Math.round(point.y) }) : screen.getDisplayMatching(fb)).workArea;
  const size = {
    width: Math.round(Math.min(Math.max(640, fb.width - sideWidth), wa.width * 0.75)),
    height: Math.round(Math.min(fb.height, wa.height * 0.75))
  };
  let bounds;
  if (atPoint) {
    const width = Math.min(size.width, wa.width), height = Math.min(size.height, wa.height);
    bounds = {
      x: Math.max(wa.x, Math.min(Math.round(point.x) - 300, wa.x + wa.width - width)),
      y: Math.max(wa.y, Math.min(Math.round(point.y) - 20, wa.y + wa.height - height)),
      width, height
    };
  } else {
    bounds = visibleBounds({ x: fb.x + sideWidth + 36, y: fb.y + 36, width: size.width, height: size.height }) || size;
  }
  createWindow({ tabs: list, bounds });
  return { ok: true };
});

/* ---------- updates ---------- */
// The installed program checks GitHub Releases on start and every few hours. When a new version
// exists it asks first; only after "Скачать" it downloads, then installs on restart or when the program is closed.
let updater = null;
let updateFound = null;   // newer version on GitHub, not downloaded yet
let downloading = false;
let updateReady = null;   // version that is downloaded and waits for a restart
let manualCheck = false;  // the user asked from the menu, so report "no update" and errors too
let lastPercent = -1;
let updateNotes = '';     // what is new in the found version, as simple Markdown
let updateSize = 0;       // size of the installer, bytes (from latest.yml)
let lastProgress = { transferred: 0, total: 0 };
let whatsNew = null;      // this version was just installed over an older one: tell about it once
let whatsNewFrom = '';    // …over this one (empty for versions before 1.8.3): guides changed in between are offered

// CHANGELOG.md goes inside the program: "## 1.8.3" starts the part about that version.
function changelogFor(version) {
  let text = '';
  try { text = fs.readFileSync(path.join(__dirname, 'CHANGELOG.md'), 'utf8'); } catch (e) { return ''; }
  const parts = text.split(/^## +/m);
  const part = parts.find((p) => p.split('\n')[0].trim() === version);
  return part ? part.slice(part.indexOf('\n') + 1).trim() : '';
}
// GitHub gives the release description as HTML; the window shows Markdown with its own safe renderer.
function htmlToMarkdown(html) {
  if (Array.isArray(html)) html = html.map((n) => n && n.note).filter(Boolean).join('\n');
  if (typeof html !== 'string') return '';
  return html
    .replace(/<h[1-6][^>]*>/gi, '\n### ').replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ').replace(/<\/li>/gi, '')
    .replace(/<\/?(strong|b)>/gi, '**').replace(/<\/?code>/gi, '`')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>|<\/ul>|<\/ol>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n))
    .replace(/[ \t]+\n/g, '\n').replace(/\n\s*\n(?=- )/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function sendUpdate(u) { broadcast('update', u); }

function checkUpdates() { updater.checkForUpdates().catch(() => { /* reported by the 'error' event */ }); }

function setupUpdates() {
  const prev = settings.lastVersion;
  if (prev !== app.getVersion()) {
    // Versions before 1.8.3 did not remember themselves; a settings file with a window size means an update.
    if (prev || settings.bounds) { whatsNew = app.getVersion(); whatsNewFrom = prev || ''; }
    settings.lastVersion = app.getVersion();
    saveSettings();
  }
  if (!app.isPackaged) return;
  updater = require('electron-updater').autoUpdater;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = true;
  updater.on('update-available', (i) => {
    updateFound = i.version;
    updateNotes = htmlToMarkdown(i.releaseNotes);
    updateSize = ((i.files || [])[0] || {}).size || 0;
    if (!downloading) sendUpdate({ kind: 'available', version: i.version, notes: updateNotes, size: updateSize, manual: manualCheck });
    manualCheck = false;
  });
  updater.on('update-not-available', () => { sendUpdate({ kind: 'latest', manual: manualCheck }); manualCheck = false; });
  updater.on('download-progress', (p) => {
    const percent = Math.floor(p.percent || 0);
    lastProgress = { transferred: p.transferred || 0, total: p.total || updateSize };
    if (percent !== lastPercent) { lastPercent = percent; sendUpdate({ kind: 'progress', version: updateFound, percent, size: updateSize, transferred: lastProgress.transferred, total: lastProgress.total }); }
  });
  updater.on('update-downloaded', (i) => {
    downloading = false;
    updateReady = i.version;
    manualCheck = false;
    sendUpdate({ kind: 'ready', version: i.version, notes: updateNotes, size: updateSize, total: lastProgress.total });
  });
  updater.on('error', (e) => {
    console.error('update', e);
    if (downloading) { downloading = false; sendUpdate({ kind: 'download-error', version: updateFound }); }
    else if (manualCheck) sendUpdate({ kind: 'error', manual: true });
    manualCheck = false;
  });
  setTimeout(checkUpdates, 10 * 1000);
  setInterval(checkUpdates, 4 * 60 * 60 * 1000);
}

nativeTheme.on('updated', paintWindows);

/* ---------- IPC ---------- */
function ok(extra) {
  return Object.assign({ ok: true, prompts: store.view(), profile: store.profileView(), activity: store.activityView(), events: store.calendarView(), tasks: store.tasksView(), taskColumns: store.columnsView(), taskArchiveMode: store.archiveMode, skills: store.skillsView() }, extra || {});
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
// fn runs with this = the IPC event, so a handler can see which window asked (this.sender).
// When something changed, the other windows get the fresh data ('sync'), so all of them show the same.
const NO_SYNC = new Set(['chat-image-save', 'chat-image-remove', 'chat-image-open', 'timer', 'load', 'update-state', 'set-tabs', 'side-width','chat-get', 'chat-list', 'assistant-send', 'assistant-stop', 'window-open', 'window-return', 'pick-files', 'pick-avatar', 'open-file', 'show-file', 'open-data-dir',
  'media-pick', 'media-info', 'media-read', 'skill-pick', 'skill-inspect', 'skill-download', 'skill-reveal', 'chat-file-save', 'transcribe-piece', 'transcribe-diarize', 'transcript-list', 'transcript-get', 'recap-text', 'recap-pick-file']);
function handle(name, fn) {
  ipcMain.handle(name, async (event, ...args) => {
    try {
      const r = await fn.apply(event, args);
      if (r && r.ok && !NO_SYNC.has(name) && liveWins().length > 1) syncOthers(r, event.sender);
      return r;
    } catch (e) { console.error(name, e); return fail(e); }
  });
}
function syncOthers(r, except) {
  const data = { info: info() };
  if (r.prompts) Object.assign(data, { prompts: r.prompts, events: r.events, tasks: r.tasks, taskColumns: r.taskColumns, taskArchiveMode: r.taskArchiveMode, skills: r.skills, profile: r.profile, activity: r.activity });
  if (r.chats) data.chats = r.chats;
  if (r.transcripts) data.transcripts = r.transcripts;
  broadcast('sync', data, except);
}
function info() {
  return { dataDir: store.dir, platform: process.platform, version: app.getVersion(), theme: currentTheme(), macAccent: macAccent(), macLook: macLook(), glass: glassOn(), captureShortcut: settings.captureShortcut || 'Alt+Z', captureNotice: captures ? captures.state().shortcutNotice : '', tabs: tabsSetting(), assistant: assistantInfo() };
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
  const r = await dialog.showOpenDialog(activeWin(), {
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
  const r = await dialog.showOpenDialog(activeWin(), {
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
  // nativeTheme fires 'updated' only when light/dark flips; "Тёмная" -> "Чёрная" needs the bar repainted too.
  paintWindows();
  saveSettings();
  return { ok: true, info: info() };
});
// «Тема › macOS ›»: the accent colour and light/dark of the macOS theme; choosing either also turns the theme on.
handle('set-mac-style', async (style) => {
  const s = style && typeof style === 'object' ? style : {};
  if (s.accent !== undefined && !MAC_ACCENTS.includes(s.accent)) return { ok: false, error: 'Такого цвета нет.' };
  if (s.look !== undefined && !MAC_LOOKS.includes(s.look)) return { ok: false, error: 'Такого оформления нет.' };
  if (s.accent) settings.macAccent = s.accent;
  if (s.look) settings.macLook = s.look;
  settings.theme = 'macos';
  applyTheme();
  paintWindows();
  saveSettings();
  return { ok: true, info: info() };
});

// The tabs on top of the window, so they come back after a restart: [{ kind, chatId? }] and which one is open.
function tabsSetting() {
  const t = settings.tabs;
  if (!t || !Array.isArray(t.list)) return null;
  const list = t.list.filter((x) => x && TAB_KINDS.includes(x.kind)).slice(0, 30)
    .map((x) => (x.kind === 'assistant' && typeof x.chatId === 'string' ? { kind: x.kind, chatId: x.chatId.slice(0, 64) } : { kind: x.kind }));
  return { list, active: Math.max(0, Math.min(list.length - 1, Number(t.active) || 0)) };
}
handle('set-tabs', async (tabs) => {
  settings.tabs = tabs && typeof tabs === 'object' ? tabs : null;
  settings.tabs = tabsSetting();
  saveSettings();
  return { ok: true };
});

handle('update-state', async () => {
  const current = app.getVersion();
  const state = { ok: true, packaged: !!updater, current, currentNotes: changelogFor(current), whatsNew, whatsNewFrom };
  whatsNew = null;
  if (updateReady) Object.assign(state, { status: 'ready', version: updateReady, notes: updateNotes, size: updateSize, total: lastProgress.total });
  else if (downloading) Object.assign(state, { status: 'progress', version: updateFound, notes: updateNotes, size: updateSize, percent: Math.max(0, lastPercent), transferred: lastProgress.transferred, total: lastProgress.total });
  else if (updateFound) Object.assign(state, { status: 'available', version: updateFound, notes: updateNotes, size: updateSize });
  return state;
});

handle('check-updates', async () => {
  if (!updater) return { ok: false, error: 'Обновления проверяются только в установленной программе.' };
  if (updateReady) { sendUpdate({ kind: 'ready', version: updateReady, notes: updateNotes, size: updateSize, total: lastProgress.total }); return { ok: true }; }
  if (downloading) { sendUpdate({ kind: 'progress', version: updateFound, percent: Math.max(0, lastPercent), size: updateSize, transferred: lastProgress.transferred, total: lastProgress.total }); return { ok: true }; }
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
    lastProgress = { transferred: 0, total: updateSize };
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
  const r = await dialog.showOpenDialog(activeWin(), {
    title: 'Где хранить промты?',
    defaultPath: store.dir,
    buttonLabel: 'Выбрать эту папку',
    properties: ['openDirectory', 'createDirectory']
  });
  if (r.canceled || !r.filePaths[0]) return { ok: true, canceled: true };
  const dir = r.filePaths[0];
  if (path.resolve(dir).toLowerCase() === path.resolve(store.dir).toLowerCase()) return { ok: true, canceled: true };
  await captures.pause();
  try {
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
  } finally { captures.resume(); }
});

/* ---------- backup and sharing ---------- */
// ".snowball" — everything: prompts with their files, chats, calendar, statistics, profile and look settings.
// ".snowprompt" — one or more prompts with comments and attached files, to give to someone else.
// Both are zip archives (archive.js) with manifest.json on top; API keys never go into them.
const BACKUP_EXT = 'snowball';
const SHARE_EXT = 'snowprompt';
const SETTINGS_IN_BACKUP = ['theme', 'macAccent', 'macLook', 'assistantModel', 'assistantEffort', 'confirm', 'notify'];
const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
function manifest(kind, counts) {
  return { name: 'manifest.json', data: JSON.stringify({ format: kind === 'backup' ? 'snowball-backup' : 'snowball-prompts', version: 1, app: app.getVersion(), createdAt: new Date().toISOString(), counts }, null, 2) };
}
const plural = (n, a, b, c) => { const m = n % 10, mm = n % 100; return m === 1 && mm !== 11 ? a : m >= 2 && m <= 4 && (mm < 12 || mm > 14) ? b : c; };

handle('backup-export', async () => {
  const r = await dialog.showSaveDialog(activeWin(), {
    title: 'Сохранить все данные в файл',
    defaultPath: path.join(app.getPath('documents'), `${APP_TITLE} — копия ${today()}.${BACKUP_EXT}`),
    filters: [{ name: 'Резервная копия Snowball.ai', extensions: [BACKUP_EXT] }]
  });
  if (r.canceled || !r.filePath) return { ok: true, canceled: true };
  await store.queue;
  const pack = store.packEntries('backup', null);
  await captures.flush();
  const shots = await captures.backup();
  pack.entries.push(...shots.entries);
  pack.counts.screenshots = shots.count;
  const look = {};
  SETTINGS_IN_BACKUP.forEach((k) => { if (settings[k] !== undefined) look[k] = settings[k]; });
  await writeZip(r.filePath, [manifest('backup', pack.counts)].concat(pack.entries, [{ name: 'settings.json', data: JSON.stringify(look, null, 2) }]));
  return { ok: true, path: r.filePath, counts: pack.counts };
});

// ids: the prompts to share; empty or missing — all of them.
handle('prompts-export', async (ids) => {
  const list = Array.isArray(ids) && ids.length ? ids.filter((id) => store.find(id)) : null;
  const one = list && list.length === 1 ? store.find(list[0]) : null;
  const base = one ? sanitizeName(one.title || 'Промт').replace(/\.[^.]*$/, '') : (list ? 'Промты (' + list.length + ')' : APP_TITLE + ' — промты ' + today());
  const r = await dialog.showSaveDialog(activeWin(), {
    title: one ? 'Поделиться промтом' : 'Сохранить промты в файл',
    defaultPath: path.join(app.getPath('documents'), base + '.' + SHARE_EXT),
    filters: [{ name: 'Промты Snowball.ai', extensions: [SHARE_EXT] }]
  });
  if (r.canceled || !r.filePath) return { ok: true, canceled: true };
  await store.queue;
  const pack = store.packEntries('share', list);
  await writeZip(r.filePath, [manifest('share', pack.counts)].concat(pack.entries));
  return { ok: true, path: r.filePath, counts: pack.counts };
});

// Opens a .snowball or .snowprompt file: unpacks it to a temporary folder, asks before adding anything,
// and adds only what is missing (storage.js mergeFrom). Also used for double-click and drag-and-drop.
async function openArchive(file) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'snowball-'));
  try {
    await extractZip(file, tmp);
    let m = null;
    try { m = JSON.parse(await fsp.readFile(path.join(tmp, 'manifest.json'), 'utf8')); } catch (e) { m = null; }
    if (!m || (m.format !== 'snowball-backup' && m.format !== 'snowball-prompts')) {
      return { ok: false, error: 'Это не файл Snowball.ai: в нём нет ни промтов, ни резервной копии.' };
    }
    const kind = m.format === 'snowball-backup' ? 'backup' : 'share';
    let titles = [];
    try { titles = JSON.parse(await fsp.readFile(path.join(tmp, 'prompts.json'), 'utf8')).prompts.map((x) => x.title || 'Без названия'); } catch (e) { titles = []; }
    const c = m.counts || {};
    let message, detail;
    if (kind === 'backup') {
      const when = m.createdAt ? new Date(m.createdAt).toLocaleString('ru-RU') : 'неизвестно когда';
      message = 'Восстановить данные из резервной копии?';
      detail = 'Копия от ' + when + ': промтов ' + (c.prompts || 0) + ', файлов ' + (c.files || 0) + ', разговоров ' + (c.chats || 0) + ', дел в календаре ' + (c.events || 0) + (c.transcripts ? ', расшифровок ' + c.transcripts : '') + (c.skills ? ', скиллов ' + c.skills : '') + '.\n\n' +
        'Из того, что уже есть в программе, ничего не удалится и не изменится: добавится только недостающее. Тема и выбор модели станут как в копии.\n\n' +
        'Ключей ChatGPT и Claude в копии нет: если нужно, введите их заново в «Настройках».';
    } else {
      message = titles.length === 1 ? 'Добавить промт «' + titles[0] + '» в вашу таблицу?' : 'Добавить ' + titles.length + ' ' + plural(titles.length, 'промт', 'промта', 'промтов') + ' в вашу таблицу?';
      detail = (titles.length > 1 ? titles.slice(0, 6).map((t) => '• ' + t).join('\n') + (titles.length > 6 ? '\n• и ещё ' + (titles.length - 6) : '') + '\n\n' : '') +
        'Вместе с комментариями и приложенными файлами (' + (c.files || 0) + '). Промты, которые у вас уже есть, пропустятся.';
    }
    const answer = await dialog.showMessageBox(activeWin(), { type: 'question', buttons: [kind === 'backup' ? 'Восстановить' : 'Добавить', 'Отмена'], defaultId: 0, cancelId: 1, title: APP_TITLE, message, detail, noLink: true });
    if (answer.response !== 0) return { ok: true, canceled: true };
    const res = await store.mergeFrom(tmp, kind);
    if (kind === 'backup') {
      res.screenshots = await captures.merge(path.join(tmp, 'screenshots'));
      let look = null;
      try { look = JSON.parse(await fsp.readFile(path.join(tmp, 'settings.json'), 'utf8')); } catch (e) { look = null; }
      if (look && typeof look === 'object') {
        SETTINGS_IN_BACKUP.forEach((k) => { if (look[k] !== undefined) settings[k] = look[k]; });
        migrateTheme(settings);
        if (!THEMES.includes(settings.theme)) settings.theme = 'system';
        applyTheme();
        paintWindows();
        saveSettings(true);
      }
    }
    return ok({ kind, result: res, info: info() });
  } finally {
    fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

handle('archive-open', async (file) => {
  let target = typeof file === 'string' ? file : '';
  if (!target) {
    const r = await dialog.showOpenDialog(activeWin(), {
      title: 'Загрузить промты или резервную копию',
      properties: ['openFile'],
      filters: [{ name: 'Файлы Snowball.ai', extensions: [SHARE_EXT, BACKUP_EXT, 'json'] }, { name: 'Все файлы', extensions: ['*'] }]
    });
    if (r.canceled || !r.filePaths[0]) return { ok: true, canceled: true };
    target = r.filePaths[0];
  }
  // A list of prompts saved by versions before 1.9 (prompts only, without files).
  if (/\.json$/i.test(target)) {
    let raw;
    try { raw = await fsp.readFile(target, 'utf8'); } catch (e) { return { ok: false, error: 'Не получилось прочитать файл.' }; }
    try {
      const r = await store.importJson(raw);
      return ok({ kind: 'share', result: { prompts: r.added, skipped: r.skipped, files: 0 } });
    } catch (e) {
      if (e instanceof SyntaxError || /списка промтов/.test(e.message)) return { ok: false, error: 'В этом файле нет промтов.' };
      throw e;
    }
  }
  return openArchive(target);
});

// A file Windows gave us: a double click on .snowprompt / .snowball, or "Открыть с помощью".
function archiveFromArgs(argv) {
  return (argv || []).slice(1).find((a) => /\.(snowprompt|snowball)$/i.test(a) && fs.existsSync(a)) || null;
}
let pendingArchive = null;
async function openArchiveFromOS(file) {
  const w = activeWin();
  if (!file || !w || w.isDestroyed()) return;
  try {
    const r = await openArchive(file);
    w.webContents.send('archive-opened', r);
    if (r && r.ok && !r.canceled) syncOthers(r, w.webContents);
  } catch (e) {
    console.error('archive', e);
    w.webContents.send('archive-opened', fail(e));
  }
}

/* ---------- assistant ---------- */
// The window sends the whole conversation, main.js answers piece by piece through the 'assistant' event:
// { id, kind: 'delta', text } … { id, kind: 'action', action } … { id, kind: 'done' } or { id, kind: 'error', error }.
// Replies come from a source: an async generator of { type: 'text', text } and { type: 'action', action }.
// Sources: stubSource (no key), openaiSource (ChatGPT) and claudeSource (Claude); pickSource chooses.
const streams = new Map();   // stream id -> AbortController
const pending = new Map();   // action id -> proposed action, waiting for "Создать" or "Отмена"
let streamSeq = 0;
let actionSeq = 0;

const streamOwner = new Map();   // stream id -> the page (webContents) that asked; its answer goes only there
function sendAssistant(e) {
  const wc = streamOwner.get(e.id);
  if (wc && !wc.isDestroyed()) wc.send('assistant', e);
}

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
function eventName(e) { return e.who ? e.who + ': ' + e.title : e.title; }
function eventLine(e) { return humanDay(e.date) + ', ' + e.from + (e.to ? '–' + e.to : '') + ' — ' + eventName(e); }
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
    return { text: settings.confirm === false ? 'Удалил это дело.' : 'Нашёл это дело. Удалить его? Без вашей кнопки ничего не удалится.', action: { kind: 'calendar-delete', title: hit.title, event: hit } };
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
  const kind2 = /съёмк|съемк|снять|снимаем/.test(t) ? 'shoot' : /монтаж/.test(t) ? 'edit' : kind;
  const event = normalizeEvent({ date, from, title, kind: kind2, remind: /без напомин/.test(t) ? 0 : 60 });
  return { text: (settings.confirm === false ? 'Поставил.' : 'Вот что я поставлю. Проверьте и нажмите **«Добавить»**.') + ' Напомню за час, время напоминания можно поменять.', action: { kind: 'calendar-add', title: event.title, event } };
}

// "открой календарь и генератор" → the tabs to open.
const TAB_WORDS = [['home', /главн|домашн/], ['prompts', /промт/], ['calendar', /календар/], ['tasks', /задач|туду|to-?do|доск/], ['assistant', /\bllm\b|ллм|чат|разговор/], ['transcribe', /транскриб|расшифров/], ['generator', /генератор|генерац|изображ|картинк|видео/], ['stats', /статистик/]];
const TAB_NAMES = { home: 'Главная', prompts: 'Промты', calendar: 'Календарь', tasks: 'Задачи', assistant: 'LLM', transcribe: 'Транскрибация', generator: 'Генератор', stats: 'Статистика' };
// The name of a column: «Предстоит», «В процессе», «Готово» or one of the user's own.
const columnName = (id) => (store.columnsView().find((c) => c.id === id) || { name: 'Предстоит' }).name;
const PRIORITY_NAMES = ['обычная', 'важная', 'срочная'];
// "сегодня", "завтра в 15:00", "вторник, 3 ноября" for answers about tasks.
function taskDue(t) {
  if (!t.due) return '';
  const n = Math.round((dateOfKey(t.due) - dateOfKey(dayKeyOf(new Date()))) / 864e5);
  return (n === 0 ? 'сегодня' : n === 1 ? 'завтра' : n === -1 ? 'вчера' : humanDay(t.due)) + (t.time ? ' в ' + t.time : '');
}
function taskLine(t) {
  const more = [columnName(t.status)];
  if (t.due) more.push('срок ' + taskDue(t));
  if (t.priority) more.push(PRIORITY_NAMES[t.priority]);
  if (t.tags && t.tags.length) more.push(t.tags.join(', '));
  return '«' + t.title + '» (' + more.join(', ') + ')';
}
// All columns and the tasks on the board for a model: what tasks_list returns. The archive is searched separately.
function tasksForModel() {
  const archived = store.tasks.filter((t) => t.archivedAt).length;
  const day = (ms) => (ms ? dayKeyOf(new Date(ms)) : '');
  const list = store.tasksView().filter((t) => !t.archivedAt).map((t) => ({ id: t.id, title: t.title, status: t.status, due: t.due, time: t.time, priority: t.priority, tags: t.tags, note: t.note,
    created: day(t.createdAt), started: day(t.startedAt), done: day(t.doneAt),
    subtasks: t.subtasks.map((s) => ({ id: s.id, title: s.title, done: s.done })) }));
  const columns = store.columnsView().map((c) => ({ id: c.id, name: c.name }));
  return JSON.stringify({ columns, tasks: list }) + (list.length ? '' : ' На доске задач пока ничего нет.') +
    (archived ? ' В архиве ещё ' + archived + ' выполненных задач: искать в нём — tasks_archive_search.' : '');
}
// Done tasks in the archive whose title, note, tags or subtasks contain the words (all of them if the query is empty).
function archiveSearch(query) {
  const words = String(query || '').toLowerCase().replace(/ё/g, 'е').split(/\s+/).filter(Boolean);
  const hay = (t) => [t.title, t.note].concat(t.tags, t.subtasks.map((x) => x.title)).join(' ').toLowerCase().replace(/ё/g, 'е');
  return store.tasks.filter((t) => t.archivedAt && words.every((w) => hay(t).includes(w)))
    .sort((a, b) => b.doneAt - a.doneAt).slice(0, 30);
}
function archiveForModel(query) {
  const found = archiveSearch(query).map((t) => ({ id: t.id, title: t.title, created: dayKeyOf(new Date(t.createdAt)),
    started: t.startedAt ? dayKeyOf(new Date(t.startedAt)) : '', done: dayKeyOf(new Date(t.doneAt)), tags: t.tags, note: t.note,
    subtasks: t.subtasks.map((x) => x.title) }));
  return found.length ? JSON.stringify(found) : 'В архиве ничего такого нет.';
}
function stubTasks(text, t) {
  if (/(добав|созда|запиш|постав|закин)\S*\s.*задач/.test(t)) {
    const title = (afterColon(text) || text.replace(/^.*?задач\S*\s*/i, '')).trim();
    if (!title) return { text: 'Напишите, какую задачу добавить, например: **«добавь задачу смонтировать рилс»**.' };
    const status = /в процесс|в работ/.test(t) ? 'doing' : 'todo';
    const task = normalizeTask({ title: title.charAt(0).toUpperCase() + title.slice(1), status });
    return { text: settings.confirm === false ? 'Добавил.' : 'Вот что я добавлю в «Задачи». Нажмите **«Добавить»**, если всё верно.', action: { kind: 'task-add', title: task.title, task } };
  }
  const list = store.tasksView();
  if (!list.length) return { text: 'На доске «Задачи» пока пусто. Напишите, например, **«добавь задачу смонтировать рилс»**.' };
  return { text: 'Сейчас на доске:\n' + store.columnsView().map((c) => {
    const col = list.filter((x) => x.status === c.id);
    return '**' + c.name + '** — ' + (col.length ? col.map((x) => x.title).join(', ') : 'пусто');
  }).join('\n') };
}

function stubAnswer(last) {
  const t = last.toLowerCase();
  if (/таймер|фокус/.test(t)) {
    if (/останов|выключ|стоп|отмени|сбрось|убери/.test(t)) {
      const was = timer.state;
      timer = { state: 'idle', duration: 0, endsAt: 0, left: 0 };
      timerChanged();
      return { text: was === 'idle' ? 'Таймер и так не запущен.' : 'Остановил таймер.' };
    }
    // "на 2 часа" or "на 2 ч" — hours (\b does not work next to Russian letters); "на 40 минут" — minutes; "на час" — 60; nothing — 25.
    const hours = /(\d{1,3})\s*(?:час|ч(?![а-яё]))/.exec(t), num = /(\d{1,3})/.exec(t);
    const n = hours ? +hours[1] * 60 : num ? +num[1] : /час/.test(t) ? 60 : 25;
    const m = startTimer(n);
    const end = new Date(timer.endsAt);
    return { text: 'Запустил таймер на ' + m + ' мин. Закончится в ' + pad2(end.getHours()) + ':' + pad2(end.getMinutes()) + ' — сыграю мелодию.' };
  }
  if (/(открой|покажи|перейди|запусти)/.test(t) && !/что у меня|какие/.test(t)) {
    const kinds = TAB_WORDS.filter((w) => w[1].test(t)).map((w) => w[0]);
    if (kinds.length) return { text: 'Открыл: ' + kinds.map((k) => '«' + TAB_NAMES[k] + '»').join(', ') + '.', open: kinds };
  }
  if (/задач/.test(t) && !/календар/.test(t)) return stubTasks(last, t);
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
  let answer = stubAnswer(lastUser ? lastUser.content : '');
  // A skill file with the message: the stub offers to keep it, without a description (ChatGPT or Claude write one).
  const doc = lastUser && /Вложение: «([^»]+)», ссылка для skill_add: (\S+)/.exec(lastUser.content);
  if (doc) {
    let title = doc[1].replace(/\.(md|markdown|zip|skill)$/i, '');
    try { const f = await readSkillFile(chatFileOf(doc[2]), doc[1]); title = skillTitle(f.text, doc[1], f.inside); } catch (e) { /* the file name will do */ }
    const r = runTool('skill_add', { attachment: doc[2], title, type: '', desc: '' });
    answer = r.action
      ? { text: 'Я заглушка и прочитать скилл не могу, но могу сохранить его во вкладку «Промты» → «Скиллы». Описание и тип там можно сделать кнопкой, когда в «Настройках» будет ключ ChatGPT или Claude.', action: r.action }
      : { text: r.output };
  }
  const pics = lastUser && lastUser.imgs ? lastUser.imgs.length : 0;
  if (pics) answer.text = 'Вижу ' + pics + ' ' + plural(pics, 'картинку', 'картинки', 'картинок') + '. Я заглушка и разглядеть их не могу — это сделают ChatGPT или Claude, когда в «Настройках» будет ключ.\n\n' + answer.text;
  await sleep(500 + Math.random() * 400, signal);
  const pieces = answer.text.match(/\S+\s*|\s+/g) || [];
  for (let i = 0; i < pieces.length;) {
    const n = 1 + Math.floor(Math.random() * 3);
    yield { type: 'text', text: pieces.slice(i, i + n).join('') };
    i += n;
    await sleep(25 + Math.random() * 45, signal);
  }
  if (answer.action) yield { type: 'action', action: answer.action };
  if (answer.open) yield { type: 'open', tabs: answer.open };
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
  'У пользователя в программе есть календарь, и ты можешь с ним работать: calendar_list показывает дела за период, calendar_add добавляет дело, calendar_update меняет или переносит существующее, calendar_delete удаляет. Результат вызова говорит, сделано ли изменение сразу или пользователь должен подтвердить его кнопкой на карточке: пиши в ответе именно так, как там сказано. Чтобы перенести или изменить дело, найди его через calendar_list и вызови calendar_update с его id (не удаляй и не создавай заново). Перед удалением тоже найди id через calendar_list.',
  'Если в деле есть люди (звонок, встреча), их имена — в who (через запятую), а title — только тема, 2–5 слов, без имён. Тема — только суть, без слова, обозначающего тип (созвон, звонок, встреча, съёмка, монтаж — тип и так виден по цвету), и без служебных слов. Например, «на завтра забей созвон на 14:00 с Димой по поводу правок по монтажу видео на ютуб» → who «Дима», title «правки монтажа YouTube», тип call. Важные подробности можно положить в note. Тип: task — задача, meet — встреча, call — звонок, shoot — съёмка, edit — монтаж. Если время окончания не названо, оставь to пустым.',
  'Напоминание: если пользователь о нём не сказал, ставь remind 60 (за час) и одной короткой фразой сообщи, что напомнишь за час, а время напоминания можно поменять. Если просит другое — ставь как просит, «без напоминания» — 0. Даты считай от текущего момента из строки «Сейчас».',
  'Ещё у пользователя есть доска «Задачи». Столбцы: todo — «Предстоит», doing — «В процессе», done — «Готово» и, может быть, свои столбцы пользователя (их id и названия — в tasks_list). tasks_list показывает столбцы и все задачи, task_add добавляет, task_update меняет задачу или переносит в другой столбец, task_delete удаляет. Как и с календарём, изменения показываются карточкой, если результат так говорит. Название задачи — коротко, суть в нескольких словах, без слов про срок и срочность. Срок (due, YYYY-MM-DD) и время (time, HH:MM) ставь, только если их назвали. Важность priority: 2 — срочно, 1 — важно, 0 — обычно, если об этом не сказано. Теги — 1–2 коротких слова по смыслу, лучше из тех, что уже есть у задач. Чтобы изменить или удалить задачу, сначала найди её id через tasks_list.',
  'Есть таймер для фокуса: timer_start сразу запускает его на нужное число минут (от 1 до 240), timer_stop останавливает. Он не привязан к задачам и делам. Запустив, коротко скажи, во сколько он закончится.',
  'Программа устроена как браузер: вверху вкладки. open_tabs сразу открывает нужные вкладки: home — «Главная», prompts — «Промты», calendar — «Календарь», tasks — «Задачи», llm — новый разговор в отдельной вкладке, transcribe — «Транскрибация» (текст, тайминги и субтитры из аудио и видео), generator — «Генератор» (картинки и видео, пока в разработке), stats — «Статистика». Если просят открыть, вызови open_tabs и коротко скажи, что открыл.',
  'На странице «Промты» есть вкладка «Скиллы»: там пользователь хранит скиллы — инструкции для ИИ-ассистентов (файл .md или архив .zip либо .skill). skills_list показывает их id, название и текущий тип; skill_read даёт сохранённый текст главного файла, состав архива и revision. Если пользователь просит перепроверить или изменить категорию уже сохранённого скилла, найди его через skills_list, прочитай через skill_read и только после этого вызови skill_set_type с тем же revision, подходящим типом и короткой причиной. Типы: static — картинки, video — видео, audio — звук, музыка и речь, text — тексты и сценарии, code — программирование и технические задачи. Если пользователь приложил новый файл скилла (в сообщении есть строка «ссылка для skill_add: …») и просит сохранить его («закинь в хранилище», «сохрани скилл»), прочитай файл и вызови skill_add: название — из name в файле или коротко по смыслу, тип — один из пяти перечисленных, описание — 5–6 простых предложений по-русски: что это за скилл, для чего, как работает и что внутри.',
  'Промты пользователя ты пока не видишь и сохранять не умеешь. Если об этом просят, скажи, что это появится позже, а пока промт можно скопировать кнопкой «Копировать» и добавить через «Добавить промт» в разделе «Промты».'
].join('\n\n');

// Task fields both assistants fill in the same way.
const TASK_FIELDS = {
  note: { type: 'string', description: 'Подробности или пустая строка' },
  due: { type: 'string', description: 'Срок, YYYY-MM-DD, или пустая строка, если срок не назван' },
  time: { type: 'string', description: 'Время, HH:MM, или пустая строка' },
  priority: { type: 'integer', enum: [0, 1, 2], description: '2 — срочно, 1 — важно, 0 — обычно (если не сказано)' },
  tags: { type: 'array', items: { type: 'string' }, description: '1–2 коротких тега по смыслу (Монтаж, Съёмка, Сайт…) или пустой список' }
};
const taskFields = (a) => ({ note: a.note, due: a.due, time: a.time, priority: a.priority, tags: a.tags });

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
    description: 'Добавляет дело в календарь (или показывает пользователю карточку для подтверждения — это скажет результат).',
    parameters: {
      type: 'object', additionalProperties: false, required: ['date', 'from', 'to', 'who', 'title', 'kind', 'note', 'remind'],
      properties: {
        date: { type: 'string', description: 'День, YYYY-MM-DD' },
        from: { type: 'string', description: 'Начало, HH:MM (24 часа)' },
        to: { type: 'string', description: 'Окончание, HH:MM, или пустая строка, если не названо' },
        who: { type: 'string', description: 'С кем дело: имена через запятую, или пустая строка, если никого не названо' },
        title: { type: 'string', description: 'Тема дела: коротко, о чём речь' },
        kind: { type: 'string', enum: ['task', 'meet', 'call', 'shoot', 'edit'], description: 'task — задача, meet — встреча, call — звонок, shoot — съёмка, edit — монтаж' },
        note: { type: 'string', description: 'Подробности или пустая строка' },
        remind: { type: 'integer', enum: [0, 15, 30, 60, 1440], description: 'За сколько минут напомнить. Если не сказано — 60, «без напоминания» — 0' }
      }
    }
  },
  {
    name: 'calendar_update',
    description: 'Меняет существующее дело: перенос на другой день или время, новое название, тип, заметка, напоминание. Передай все поля; то, что не меняется, — как было в calendar_list.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['id', 'date', 'from', 'to', 'who', 'title', 'kind', 'note', 'remind'],
      properties: {
        id: { type: 'string', description: 'id дела из calendar_list' },
        date: { type: 'string', description: 'День, YYYY-MM-DD' },
        from: { type: 'string', description: 'Начало, HH:MM' },
        to: { type: 'string', description: 'Окончание, HH:MM, или пустая строка' },
        who: { type: 'string', description: "С кем дело: имена через запятую, или пустая строка" },
        title: { type: 'string', description: 'Тема дела: коротко, о чём речь' },
        kind: { type: 'string', enum: ['task', 'meet', 'call', 'shoot', 'edit'] },
        note: { type: 'string', description: 'Подробности или пустая строка' },
        remind: { type: 'integer', enum: [0, 15, 30, 60, 1440] }
      }
    }
  },
  {
    name: 'tasks_list',
    description: 'Показывает все задачи с доски «Задачи»: id, название, столбец (todo, doing, done), срок, важность, теги, подзадачи, заметку и даты — поставлена (created), начата (started), сделана (done). Архива выполненных задач здесь нет.',
    parameters: { type: 'object', additionalProperties: false, required: [], properties: {} }
  },
  {
    name: 'tasks_archive_search',
    description: 'Ищет в архиве выполненных задач по словам (название, заметка, теги, подзадачи); пустая строка — последние 30. Используй, только когда спрашивают про старые или выполненные задачи.',
    parameters: { type: 'object', additionalProperties: false, required: ['query'], properties: { query: { type: 'string', description: 'Слова для поиска или пустая строка' } } }
  },
  {
    name: 'task_add',
    description: 'Добавляет задачу на доску «Задачи» (или показывает карточку для подтверждения — это скажет результат).',
    parameters: {
      type: 'object', additionalProperties: false, required: ['title', 'status', 'note', 'due', 'time', 'priority', 'tags', 'subtasks'],
      properties: Object.assign({
        title: { type: 'string', description: 'Коротко, что нужно сделать' },
        status: { type: 'string', description: 'id столбца: todo — «Предстоит» (обычно), doing — «В процессе», done — «Готово» или id своего столбца пользователя из tasks_list' }
      }, TASK_FIELDS, { subtasks: { type: 'array', items: { type: 'string' }, description: 'Шаги внутри задачи, если о них просили; иначе пустой список' } })
    }
  },
  {
    name: 'task_update',
    description: 'Меняет задачу: название, столбец (например, перенести в «Готово»), срок, важность, теги, заметку. Передай все поля; то, что не меняется, — как было в tasks_list.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['id', 'title', 'status', 'note', 'due', 'time', 'priority', 'tags'],
      properties: Object.assign({
        id: { type: 'string', description: 'id задачи из tasks_list' },
        title: { type: 'string' },
        status: { type: 'string', description: 'id столбца из tasks_list' }
      }, TASK_FIELDS)
    }
  },
  {
    name: 'task_delete',
    description: 'Удаляет задачу с доски (или показывает карточку для подтверждения — это скажет результат).',
    parameters: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', description: 'id задачи из tasks_list' } } }
  },
  {
    name: 'open_tabs',
    description: 'Сразу открывает вкладки программы вверху окна. Если такая вкладка уже открыта, переключается на неё; llm каждый раз открывает новый разговор.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['tabs'],
      properties: { tabs: { type: 'array', items: { type: 'string', enum: ['home', 'prompts', 'calendar', 'tasks', 'llm', 'transcribe', 'generator', 'stats'] }, description: 'Какие вкладки открыть, по порядку' } }
    }
  },
  {
    name: 'timer_start',
    description: 'Сразу запускает таймер для фокуса на столько минут (заменяет запущенный). Он ни к чему не привязан: просто отсчёт, в конце мелодия.',
    parameters: { type: 'object', additionalProperties: false, required: ['minutes'], properties: { minutes: { type: 'integer', minimum: 1, maximum: 240, description: 'Сколько минут, от 1 до 240' } } }
  },
  {
    name: 'timer_stop',
    description: 'Останавливает таймер для фокуса (и мелодию, если она играет).',
    parameters: { type: 'object', additionalProperties: false, required: [], properties: {} }
  },
  {
    name: 'skills_list',
    description: 'Показывает скиллы пользователя со страницы «Промты» → «Скиллы»: id, название, тип и начало описания. Используй id для skill_read.',
    parameters: { type: 'object', additionalProperties: false, required: [], properties: {} }
  },
  {
    name: 'skill_read',
    description: 'Читает уже сохранённый скилл: текст главного файла и список файлов архива. Вызови перед изменением его категории.',
    parameters: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', description: 'id скилла из skills_list' } } }
  },
  {
    name: 'skill_set_type',
    description: 'Предлагает изменить категорию уже сохранённого скилла после skill_read (или показывает карточку для подтверждения — это скажет результат).',
    parameters: {
      type: 'object', additionalProperties: false, required: ['id', 'revision', 'type', 'reason'],
      properties: {
        id: { type: 'string', description: 'id скилла из skills_list и skill_read' },
        revision: { type: 'integer', description: 'revision из ответа skill_read; подтверждает, что скилл был прочитан и с тех пор не менялся' },
        type: { type: 'string', enum: SKILL_TYPES, description: 'Новая категория: static, video, audio, text или code' },
        reason: { type: 'string', description: 'Коротко по-русски: почему содержимое скилла относится к этой категории' }
      }
    }
  },
  {
    name: 'skill_add',
    description: 'Сохраняет приложенный к сообщению файл скилла (.md, .zip или .skill) на страницу «Промты» → «Скиллы» вместе с названием, типом и описанием (или показывает карточку для подтверждения — это скажет результат).',
    parameters: {
      type: 'object', additionalProperties: false, required: ['attachment', 'title', 'type', 'desc'],
      properties: {
        attachment: { type: 'string', description: 'Ссылка на вложение из строки «ссылка для skill_add: …» в сообщении пользователя' },
        title: { type: 'string', description: 'Название скилла: name из его файла или коротко по смыслу' },
        type: { type: 'string', enum: SKILL_TYPES, description: 'static — картинки, video — видео, audio — звук и речь, text — тексты и сценарии, code — технические задачи' },
        desc: { type: 'string', description: 'Описание по-русски: 5–6 простых предложений одним абзацем — что это за скилл, для чего, как работает и что внутри' }
      }
    }
  },
  {
    name: 'calendar_delete',
    description: 'Удаляет дело из календаря (или показывает карточку для подтверждения — это скажет результат).',
    parameters: {
      type: 'object', additionalProperties: false, required: ['id'],
      properties: { id: { type: 'string', description: 'id дела из calendar_list' } }
    }
  }
];
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const SKILL_TYPE_NAMES = { static: 'Статика', video: 'Видео', audio: 'Аудио', text: 'Текст', code: 'Code' };
function skillTypeName(type) { return SKILL_TYPE_NAMES[type] || 'Без категории'; }

// Runs one tool call: { output } goes back to the model, { action } becomes a card in the chat.
// With confirmations off the card is applied by runAssistant before the model continues, so the output says "сделано".
function runTool(name, input) {
  const a = input && typeof input === 'object' ? input : {};
  const auto = settings.confirm === false;
  const after = (what) => auto ? what + ' Сделано. Пользователь может отменить это кнопкой на карточке.' : 'Пользователю показана карточка «' + what + '». Изменение произойдёт, только если он нажмёт кнопку. Коротко попроси подтвердить.';
  if (name === 'calendar_list') {
    if (!DATE_ONLY.test(a.from || '') || !DATE_ONLY.test(a.to || '')) return { output: 'Ошибка: from и to должны быть датами YYYY-MM-DD.', error: true };
    const list = store.calendarView().filter((e) => e.date >= a.from && e.date <= a.to).slice(0, 200)
      .map((e) => ({ id: e.id, date: e.date, from: e.from, to: e.to, who: e.who, title: e.title, kind: e.kind, note: e.note, remind: e.remind }));
    return { output: list.length ? JSON.stringify(list) : 'В этот период дел нет.' };
  }
  const fields = () => ({ date: a.date, from: a.from, to: a.to, who: a.who, title: a.title, kind: a.kind, note: a.note, remind: a.remind });
  if (name === 'calendar_add') {
    const event = DATE_ONLY.test(a.date || '') ? normalizeEvent(fields()) : null;
    if (!event) return { output: 'Ошибка: нужна дата YYYY-MM-DD и время HH:MM.', error: true };
    return { output: after('Добавить в календарь: ' + eventLine(event)), action: { kind: 'calendar-add', title: event.title, event } };
  }
  if (name === 'calendar_update') {
    const prev = store.findEvent(String(a.id || ''));
    if (!prev) return { output: 'Дела с таким id нет. Найди его через calendar_list.', error: true };
    const event = DATE_ONLY.test(a.date || '') ? normalizeEvent(Object.assign(fields(), { id: prev.id })) : null;
    if (!event) return { output: 'Ошибка: нужна дата YYYY-MM-DD и время HH:MM.', error: true };
    return { output: after('Изменить в календаре: ' + eventLine(prev) + ' → ' + eventLine(event)), action: { kind: 'calendar-update', title: event.title, event, prev } };
  }
  if (name === 'calendar_delete') {
    const event = store.findEvent(String(a.id || ''));
    if (!event) return { output: 'Дела с таким id нет. Найди его через calendar_list.', error: true };
    return { output: after('Удалить из календаря: ' + eventLine(event)), action: { kind: 'calendar-delete', title: event.title, event } };
  }
  if (name === 'tasks_list') return { output: tasksForModel() };
  if (name === 'skills_list') {
    const list = store.skillsView().map((s) => ({ id: s.id, title: s.title, type: s.type, file: s.file.name, desc: s.desc.slice(0, 300) }));
    return { output: list.length ? JSON.stringify(list) : 'Скиллов пока нет.' };
  }
  if (name === 'skill_read') {
    const s = store.findSkill(String(a.id || ''));
    if (!s) return { output: 'Скилла с таким id нет. Найди его через skills_list.', error: true };
    return { output: JSON.stringify({ id: s.id, revision: s.updatedAt, title: s.title, type: s.type, desc: s.desc, file: s.file.name,
      main: s.main, files: s.inside.slice(0, 150).map((f) => f.path), text: s.text.slice(0, 60000) }) };
  }
  if (name === 'skill_set_type') {
    const s = store.findSkill(String(a.id || ''));
    if (!s) return { output: 'Скилла с таким id нет. Найди его через skills_list.', error: true };
    if (s.updatedAt !== a.revision) return { output: 'Скилл изменился после чтения. Прочитай его ещё раз через skill_read.', error: true };
    if (!SKILL_TYPES.includes(a.type)) return { output: 'Ошибка: неизвестная категория скилла.', error: true };
    if (s.type === a.type) return { output: 'У скилла «' + s.title + '» уже стоит эта категория. Менять ничего не нужно.' };
    const reason = String(a.reason || '').trim().slice(0, 500);
    if (!reason) return { output: 'Ошибка: объясни, почему новая категория подходит скиллу.', error: true };
    return { output: after('Изменить категорию скилла «' + s.title + '»: ' + skillTypeName(s.type) + ' → ' + skillTypeName(a.type)),
      action: { kind: 'skill-set-type', skillId: s.id, revision: s.updatedAt, title: s.title, prevCategory: s.type, category: a.type, text: reason } };
  }
  if (name === 'skill_add') {
    const file = chatFileOf(a.attachment);
    if (!file || !fs.existsSync(file)) return { output: 'Ошибка: такого вложения нет. Возьми ссылку из строки «ссылка для skill_add: …» в сообщении пользователя.', error: true };
    const type = SKILL_TYPES.includes(a.type) ? a.type : '';
    const title = String(a.title || '').trim().slice(0, 300) || 'Скилл';
    const desc = String(a.desc || '').trim().slice(0, 6000);
    const fileName = chatFileNames.get(String(a.attachment)) || path.basename(file);
    return { output: after('Сохранить скилл «' + title + '» во вкладку «Скиллы»'), action: { kind: 'skill-add', title, category: type, text: desc, attachment: String(a.attachment), fileName, model: currentModelId() } };
  }
  if (name === 'tasks_archive_search') return { output: archiveForModel(a.query) };
  if (name === 'task_add') {
    const task = normalizeTask(Object.assign({ title: a.title, status: a.status, subtasks: (Array.isArray(a.subtasks) ? a.subtasks : []).map((s) => ({ title: s })) }, taskFields(a)));
    if (!task) return { output: 'Ошибка: нужно название задачи.', error: true };
    return { output: after('Добавить задачу ' + taskLine(task)), action: { kind: 'task-add', title: task.title, task } };
  }
  if (name === 'task_update') {
    const prev = store.findTask(String(a.id || ''));
    if (!prev) return { output: 'Задачи с таким id нет. Найди её через tasks_list.', error: true };
    const task = normalizeTask(Object.assign({}, prev, { title: a.title || prev.title, status: a.status }, taskFields(a)));
    return { output: after('Изменить задачу: ' + taskLine(prev) + ' → ' + taskLine(task)), action: { kind: 'task-update', title: task.title, task, prevTask: prev } };
  }
  if (name === 'task_delete') {
    const task = store.findTask(String(a.id || ''));
    if (!task) return { output: 'Задачи с таким id нет. Найди её через tasks_list.', error: true };
    return { output: after('Удалить задачу ' + taskLine(task)), action: { kind: 'task-delete', title: task.title, task } };
  }
  if (name === 'timer_start') {
    const m = startTimer(a.minutes);
    const end = new Date(timer.endsAt);
    return { output: 'Таймер запущен на ' + m + ' мин., закончится в ' + pad2(end.getHours()) + ':' + pad2(end.getMinutes()) + '.' };
  }
  if (name === 'timer_stop') {
    const was = timer.state;
    timer = { state: 'idle', duration: 0, endsAt: 0, left: 0 };
    timerChanged();
    return { output: was === 'idle' ? 'Таймер и так не был запущен.' : 'Таймер остановлен.' };
  }
  if (name === 'open_tabs') {
    const tabs = (Array.isArray(a.tabs) ? a.tabs : []).map((k) => (k === 'llm' ? 'assistant' : k)).filter((k) => TAB_KINDS.includes(k)).slice(0, 8);
    if (!tabs.length) return { output: 'Ошибка: не названо ни одной вкладки.', error: true };
    return { output: 'Открыто: ' + tabs.map((k) => TAB_NAMES[k]).join(', ') + '.', open: tabs };
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
// What one answer cost so far, by the signal of its stream (an answer can be several requests when tools are used).
const runCost = new WeakMap();
function recordSpend(model, usage, signal) {
  const price = PRICES[model.id];
  if (!price || !usage) return;
  const usd = ((usage.input || 0) * price.input + (usage.cached || 0) * price.cached +
    (usage.cacheWrite || 0) * (price.cacheWrite || price.input) + (usage.output || 0) * price.output) / 1e6;
  if (!(usd > 0)) return;
  if (signal) runCost.set(signal, (runCost.get(signal) || 0) + usd);
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
    model: currentModel().id, effort: currentEffort(), models: MODELS, efforts: EFFORTS, quickModel: (quickModel() || {}).id || null,
    spend: spendInfo(), notify: settings.notify !== false, confirm: settings.confirm !== false,
    prices: PRICES, fixedChars: SYSTEM_PROMPT.length + JSON.stringify(TOOLS).length + 200
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
async function* openaiSource(model, messages, signal, opts) {
  const effort = (opts && opts.effort) || currentEffort();
  const extra = (opts && opts.extra) ? '\n\n' + opts.extra : '';
  const client = new OpenAI({ apiKey: keys.openai });
  const tools = TOOLS.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: true }));
  let input = messages.map((m) => (m.imgs && m.imgs.length
    ? { role: m.role, content: [{ type: 'input_text', text: m.content || IMAGE_ONLY_TEXT }].concat(m.imgs.map((i) => ({ type: 'input_image', image_url: 'data:' + i.media + ';base64,' + i.data }))) }
    : { role: m.role, content: m.content }));
  let wrote = false;
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const stream = await client.responses.create({
      model: model.id,
      instructions: SYSTEM_PROMPT + '\n\n' + nowLine() + extra,
      input,
      tools,
      reasoning: { effort },
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
      else if (event.type === 'response.completed') { final = event.response; recordSpend(model, openaiUsage(event.response), signal); }
      else if (event.type === 'response.incomplete') {
        recordSpend(model, openaiUsage(event.response), signal);
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
      if (r.open) yield { type: 'open', tabs: r.open };
      input.push({ type: 'function_call_output', call_id: c.call_id, output: r.output });
    }
  }
}

async function* claudeSource(model, messages, signal, opts) {
  const effort = (opts && opts.effort) || currentEffort();
  const extra = (opts && opts.extra) ? '\n\n' + opts.extra : '';
  const client = new Anthropic({ apiKey: keys.anthropic });
  const tools = TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters, strict: true }));
  let msgs = messages.map((m) => (m.imgs && m.imgs.length
    ? { role: m.role, content: m.imgs.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.media, data: i.data } })).concat([{ type: 'text', text: m.content || IMAGE_ONLY_TEXT }]) }
    : { role: m.role, content: m.content }));
  let wrote = false;
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const params = {
      model: model.id,
      max_tokens: 16000,
      tools,
      // The instructions are cached; the current time goes after them so it does not break the cache.
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }, { type: 'text', text: nowLine() + extra }],
      messages: msgs,
      output_config: { effort }
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
    recordSpend(model, { input: u.input_tokens || 0, cached: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, output: u.output_tokens || 0 }, signal);
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
      if (r.open) yield { type: 'open', tabs: r.open };
      results.push({ type: 'tool_result', tool_use_id: b.id, content: r.output, is_error: !!r.error });
    }
    msgs.push({ role: 'user', content: results });
  }
}

// The small assistant window does calendar and tasks errands: the cheapest model and quick thinking are enough.
const QUICK_MODELS = ['gpt-6-luna', 'claude-haiku-5-5'];
const QUICK_LINE = 'Это маленькое окно ассистента для быстрых дел: календарь, задачи, вкладки, таймер. Отвечай одной-двумя короткими фразами.';
function quickModel() { return QUICK_MODELS.map(modelById).find((m) => m && keys[m.provider]) || null; }

// Who answers: the chosen model if there is a key for it (in the small window, the cheapest one), otherwise the stub.
function pickSource(quick) {
  const model = quick ? quickModel() : currentModel();
  if (!model || !keys[model.provider]) return (messages, signal) => stubSource(messages, signal);
  const source = model.provider === 'openai' ? openaiSource : claudeSource;
  const opts = quick ? { effort: 'low', extra: QUICK_LINE } : null;
  return (messages, signal) => source(model, messages, signal, opts);
}

/* Notifications: when an answer is ready and the window is minimized, hidden or behind another window,
   Windows shows a notification and the taskbar button blinks. A click on it brings the chat back. */
function windowAway(w) { w = w || win; return !w || w.isDestroyed() || w.isMinimized() || !w.isVisible() || !w.isFocused(); }
// The first words of the answer without Markdown marks, for the notification text.
function plainStart(text) {
  const t = String(text || '').replace(/```[\s\S]*?(```|$)/g, ' ').replace(/[*#`>]/g, '').replace(/^\s*[-•]\s+/gm, '').replace(/\s+/g, ' ').trim();
  return t.length > 140 ? t.slice(0, 139).trimEnd() + '…' : t;
}
function notifyAnswer(text, failed, wc) {
  const w = (wc && !wc.isDestroyed() && BrowserWindow.fromWebContents(wc)) || win;
  if (settings.notify === false || !windowAway(w) || !Notification.isSupported()) return;
  const n = new Notification({
    title: failed ? 'Ассистент не смог ответить' : 'Ассистент ответил',
    body: failed ? String(text || '') : (plainStart(text) || 'Ответ готов'),
    icon: path.join(__dirname, 'assets', 'icon.png')
  });
  n.on('failed', (_e, err) => console.error('notification', err));
  if (!app.isPackaged) n.on('show', () => console.log('notification shown:', n.title));
  n.on('click', () => {
    if (!w || w.isDestroyed()) return;
    showWin(w);
    w.webContents.send('assistant-open');
  });
  n.show();
  if (w && !w.isDestroyed()) w.flashFrame(true);
}

// Reads the pictures of the conversation for the request: { media, data (base64) } in m.imgs. A missing file is skipped.
// Skill files of a message (m.docs) become text: the list of files and the main Markdown, with the reference for skill_add.
async function withImages(messages) {
  return Promise.all(messages.map(async (m) => {
    if (!m.files && !m.docs) return m;
    const imgs = [];
    for (const f of m.files || []) {
      try { imgs.push({ media: /\.png$/i.test(f) ? 'image/png' : 'image/jpeg', data: (await fsp.readFile(f)).toString('base64') }); } catch (e) { /* deleted meanwhile */ }
    }
    const docs = [];
    for (const d of m.docs || []) docs.push(await docText(d));
    const content = docs.length ? (m.content.trim() || 'Посмотри на приложенный файл.') + '\n\n' + docs.join('\n\n') : m.content;
    return { role: m.role, content, imgs };
  }));
}
// A skill file in a message is "<chat id>/<stored>": that is what skill_add gets back from the model.
const chatFileNames = new Map();   // that reference -> the file's own name
function chatFileOf(ref) {
  const m = /^([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{1,64}\.(md|zip|skill))$/.exec(String(ref || ''));
  return m ? store.chatImagePath(m[1], m[2]) : null;
}
const currentModelId = () => { const m = currentModel(); return m ? m.id : ''; };
async function docText(d) {
  const head = 'Вложение: «' + d.name + '», ссылка для skill_add: ' + d.ref;
  try {
    const r = await readSkillFile(d.path, d.name);
    const list = r.inside.slice(0, 150).map((f) => '- ' + f.path).join('\n');
    return head + (r.kind !== 'md' ? '\nАрхив, файлов: ' + r.files + (list ? '\n' + list : '') : '') +
      '\n' + (r.text ? 'Текст ' + (r.main || d.name) + ':\n```\n' + r.text.slice(0, 60000) + '\n```' : 'Текстового файла .md нет.');
  } catch (e) {
    return head + '\n(файл не прочитался: ' + (e.userMessage || 'его нет') + ')';
  }
}
const IMAGE_ONLY_TEXT = 'Посмотри на картинку.';

async function runAssistant(id, messages, controller, quick) {
  const source = pickSource(quick);
  try { messages = await withImages(messages); } catch (e) { /* send the text alone */ }
  let full = '';
  try {
    for await (const piece of source(messages, controller.signal)) {
      if (controller.signal.aborted) break;
      if (piece.type === 'text') { full += piece.text; sendAssistant({ id, kind: 'delta', text: piece.text }); }
      else if (piece.type === 'action') {
        const action = Object.assign({ id: 'a' + (++actionSeq) }, piece.action);
        let data = null;
        if (settings.confirm === false) {
          // No confirmation wanted: make the change now and keep what is needed for "Отменить".
          try {
            const r = await applyAction(action);
            action.undo = r.undo;
            action.status = 'done';
            data = ok(r.extra);
            if (liveWins().length > 1) syncOthers(data, streamOwner.get(id));
          } catch (e) {
            action.status = 'failed';
            action.error = e.userMessage || 'Не получилось.';
          }
        }
        pending.set(action.id, action);
        const shown = Object.assign({}, action, { undo: undefined, undoable: !!action.undo });
        sendAssistant({ id, kind: 'action', action: shown, data });
      } else if (piece.type === 'open') sendAssistant({ id, kind: 'open', tabs: piece.tabs });
    }
    if (!controller.signal.aborted) {
      sendAssistant({ id, kind: 'done', assistant: assistantInfo(), cost: runCost.get(controller.signal) || 0 });
      if (!quick) notifyAnswer(full, false, streamOwner.get(id));
    }
  } catch (e) {
    if (!controller.signal.aborted) {
      // Service errors are logged by status only: their message can quote part of the key.
      if (e instanceof OpenAI.APIError || e instanceof Anthropic.APIError) console.error('assistant', e.status, e.code || e.type);
      else if (!e.userMessage) console.error('assistant', e);
      const error = e.userMessage || modelError(e) || 'Ассистент не ответил. Попробуйте ещё раз.';
      sendAssistant({ id, kind: 'error', error, assistant: assistantInfo(), cost: runCost.get(controller.signal) || 0 });
      if (!quick) notifyAnswer(error, true, streamOwner.get(id));
    }
  } finally {
    streams.delete(id);
    streamOwner.delete(id);
  }
}

// messages: [{ role: 'user' | 'assistant', content: string }], the whole conversation so far.
// opts.quick: the small assistant window (cheapest model, short answers, no Windows notification).
// A user message may have images: the stored names of its pictures in "Файлы чатов/<opts.chatId>/".
handle('assistant-send', async function (messages, opts) {
  const chatId = opts && typeof opts.chatId === 'string' ? opts.chatId : '';
  const list = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => {
      const out = { role: m.role, content: m.content.slice(0, 100000) };
      const files = m.role === 'user' && chatId && Array.isArray(m.images) ? m.images.map((x) => store.chatImagePath(chatId, x)).filter(Boolean).slice(0, 6) : [];
      if (files.length) out.files = files;
      // Skill files (.md, .zip, .skill): [{ stored, name }]; they reach the model as text.
      const docs = m.role === 'user' && chatId && Array.isArray(m.docs) ? m.docs.slice(0, 6).map((d) => {
        const p = d && store.chatImagePath(chatId, String(d.stored || ''));
        if (!p || !/\.(md|zip|skill)$/.test(p)) return null;
        const ref = chatId + '/' + d.stored;
        const name = String(d.name || d.stored).slice(0, 200);
        chatFileNames.set(ref, name);
        return { path: p, ref, name };
      }).filter(Boolean) : [];
      if (docs.length) out.docs = docs;
      return out;
    });
  const last = list[list.length - 1];
  if (!last || last.role !== 'user' || !(last.content.trim() || last.files || last.docs)) return { ok: false, error: 'Напишите сообщение.' };
  const id = ++streamSeq;
  const controller = new AbortController();
  streams.set(id, controller);
  streamOwner.set(id, this.sender);
  store.recordAssistant();
  runAssistant(id, list, controller, !!(opts && opts.quick));
  return { ok: true, id };
});

// A picture for an LLM message (already made smaller by the window): bytes of a JPEG or PNG, at most 8 MB.
handle('chat-image-save', async (chatId, name, bytes, ext) => {
  if (!bytes || !(bytes.byteLength > 0) || bytes.byteLength > 8 * 1024 * 1024) return { ok: false, error: 'Эта картинка слишком большая.' };
  const image = await store.saveChatImage(chatId, name, bytes, ext);
  return { ok: true, image };
});
handle('chat-image-remove', async (chatId, stored) => { await store.removeChatImage(chatId, stored); return { ok: true }; });
handle('chat-image-open', async (chatId, stored) => {
  const file = store.chatImagePath(chatId, stored);
  if (!file || !fs.existsSync(file)) return { ok: false, error: 'Этой картинки уже нет.' };
  const err = await shell.openPath(file);
  return err ? { ok: false, error: 'Не получилось открыть картинку.' } : { ok: true };
});

/* «Транскрибация»: text, timings and subtitles of an audio or video file.
   The window reads the file, takes the sound out (WebAudio, no extra programs), cuts it at pauses of the voice and sends
   the pieces here one by one (transcribe-piece); OpenAI turns each into text with the user's ChatGPT key. Only the pieces
   with speech are sent, so the 25 MB limit of OpenAI does not matter and a long video works too.
   Transcription is priced by minutes of sound; these are estimates, the spending counts them like answers of the assistant. */
const TRANSCRIBE_MODELS = { 'gpt-4o-mini-transcribe': 0.003, 'gpt-transcribe': 0.0045, 'gpt-4o-transcribe': 0.006, 'gpt-4o-transcribe-diarize': 0.006 };
const DIARIZE_MODEL = 'gpt-4o-transcribe-diarize';
const MEDIA_EXT = ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', '3gp', 'mp3', 'm4a', 'wav', 'ogg', 'opus', 'flac', 'aac'];
const AUDIO_ONLY = ['mp3', 'm4a', 'wav', 'ogg', 'opus', 'flac', 'aac'];
const MEDIA_MAX = 2 * 1024 * 1024 * 1024;   // the window holds the whole file while it takes the sound out
const mediaAllowed = new Set();   // only files the user picked or dropped can be read
function mediaInfo(file) {
  file = String(file || '');
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!file || !MEDIA_EXT.includes(ext)) return { ok: false, error: 'Этот файл не подходит: нужно аудио или видео (' + MEDIA_EXT.join(', ') + ').' };
  let st;
  try { st = fs.statSync(file); } catch (e) { return { ok: false, error: 'Файл не открылся: возможно, его переместили или удалили.' }; }
  if (!st.isFile()) return { ok: false, error: 'Это папка, а нужен файл.' };
  if (st.size > MEDIA_MAX) return { ok: false, error: 'Файл больше 2 ГБ. Сохраните из него только звук (например, в mp3) и расшифруйте его.' };
  mediaAllowed.add(file);
  const { pathToFileURL } = require('url');
  return { ok: true, file, name: path.basename(file), size: st.size, kind: AUDIO_ONLY.includes(ext) ? 'audio' : 'video', url: pathToFileURL(file).href };
}
handle('media-pick', async function () {
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(this.sender) || activeWin(), {
    title: 'Аудио или видео для расшифровки', properties: ['openFile'], filters: [{ name: 'Аудио и видео', extensions: MEDIA_EXT }]
  });
  if (r.canceled || !r.filePaths[0]) return { ok: true, canceled: true };
  return mediaInfo(r.filePaths[0]);
});
handle('media-info', async (file) => mediaInfo(file));
handle('media-read', async (file) => {
  if (!mediaAllowed.has(String(file))) return { ok: false, error: 'Выберите файл ещё раз.' };
  const buf = await fsp.readFile(file);
  return { ok: true, data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) };
});
// One piece of speech (a 16 kHz WAV made by the window) → text. prompt: what was said just before, so a short piece
// keeps its meaning (only the text: an instruction there gets copied into the answer on an almost silent piece).
handle('transcribe-piece', async (wav, prompt, model, seconds) => {
  if (!keys.openai) return { ok: false, error: 'Для расшифровки нужен ключ ChatGPT: «Настройки» → «API-ключи».', noKey: true };
  if (!wav || !(wav.byteLength > 44) || wav.byteLength > 24 * 1024 * 1024) return { ok: false, error: 'Кусок звука не подошёл.' };
  const id = TRANSCRIBE_MODELS[model] ? model : 'gpt-transcribe';
  const client = new OpenAI({ apiKey: keys.openai, maxRetries: 2, timeout: 5 * 60 * 1000 });
  const body = { file: await toFile(Buffer.from(wav), 'piece.wav', { type: 'audio/wav' }), model: id, response_format: 'json', language: 'ru' };
  if (prompt) body.prompt = String(prompt).slice(-800);
  try {
    const r = await client.audio.transcriptions.create(body);
    const usd = Math.max(0, Number(seconds) || 0) / 60 * TRANSCRIBE_MODELS[id];
    if (usd > 0) { const sp = spendOf('openai'); sp.monthUsd += usd; sp.sinceUsd += usd; saveSettings(); }
    return { ok: true, text: String(r.text || '').trim(), usd };
  } catch (e) {
    // Only the code goes to the log: the text of a service error may contain a piece of the key.
    console.error('transcribe', e && e.status, e && (e.code || e.type));
    return { ok: false, error: modelError(e) || 'OpenAI не расшифровал кусок. Попробуйте ещё раз.' };
  }
});
// Several voices: a long part of the recording (up to about 9 minutes, a 16 kHz WAV) goes to the diarize model, which
// returns phrases with who says them. refs: [{ name, data }] — 2–10 seconds of each voice already met (a WAV data URL),
// so in the next part the same people keep their names; OpenAI takes up to 4 of them.
handle('transcribe-diarize', async (wav, refs, seconds) => {
  if (!keys.openai) return { ok: false, error: 'Для расшифровки нужен ключ ChatGPT: «Настройки» → «API-ключи».', noKey: true };
  if (!wav || !(wav.byteLength > 44) || wav.byteLength > 24.5 * 1024 * 1024) return { ok: false, error: 'Часть записи не подошла.' };
  const client = new OpenAI({ apiKey: keys.openai, maxRetries: 2, timeout: 10 * 60 * 1000 });
  const known = (Array.isArray(refs) ? refs : []).filter((r) => r && typeof r.name === 'string' && /^data:audio\/wav;base64,/.test(String(r.data))).slice(0, 4);
  const body = async (lang) => {
    const b = { file: await toFile(Buffer.from(wav), 'part.wav', { type: 'audio/wav' }), model: DIARIZE_MODEL, response_format: 'diarized_json', chunking_strategy: 'auto' };
    if (lang) b.language = 'ru';
    if (known.length) { b.known_speaker_names = known.map((r) => r.name.slice(0, 40)); b.known_speaker_references = known.map((r) => r.data); }
    return b;
  };
  try {
    let r;
    try { r = await client.audio.transcriptions.create(await body(true)); } catch (e) {
      // The model may not take the language hint: then once more without it.
      if (e.status !== 400 || !/language/i.test(String(e.error && e.error.message || e.message))) throw e;
      r = await client.audio.transcriptions.create(await body(false));
    }
    const segments = (r.segments || []).map((s) => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: String(s.text || '').trim(), speaker: String(s.speaker || '') })).filter((s) => s.text);
    const usd = Math.max(0, Number(seconds) || 0) / 60 * TRANSCRIBE_MODELS[DIARIZE_MODEL];
    if (usd > 0) { const sp = spendOf('openai'); sp.monthUsd += usd; sp.sinceUsd += usd; saveSettings(); }
    return { ok: true, segments, usd };
  } catch (e) {
    console.error('diarize', e && e.status, e && (e.code || e.type));
    return { ok: false, error: modelError(e) || 'OpenAI не расшифровал часть записи. Попробуйте ещё раз.' };
  }
});
handle('transcript-list', async () => ({ ok: true, transcripts: store.transcriptList() }));
handle('transcript-get', async (id) => {
  const t = store.getTranscript(id);
  return t ? { ok: true, transcript: t } : { ok: false, error: 'Этой расшифровки уже нет.' };
});
handle('transcript-save', async (t) => {
  const saved = await store.saveTranscript(t);
  if (!saved) return { ok: false, error: 'Не получилось сохранить расшифровку.' };
  return ok({ transcript: saved, transcripts: store.transcriptList() });
});
handle('transcript-delete', async (id) => {
  const gone = await store.deleteTranscript(id);
  return ok({ removed: gone, transcripts: store.transcriptList() });
});
handle('transcript-restore', async (t) => { await store.putTranscript(t); return ok({ transcripts: store.transcriptList() }); });

// «Кратко»: a couple of sentences about the main thing and the main points. Made only on request.
const TRANSCRIPT_SUMMARY_PROMPT = [
  'Тебе дают расшифровку аудио или видео: озвучку ролика, урок, запись разговора. Сделай краткое содержание для программы Snowball.ai.',
  'brief — 2–4 простых предложения: о чём это и чем заканчивается. points — 3–6 главных мыслей, каждая коротко, в одну строку.',
  'Расшифровку делала программа распознавания речи, в ней бывают ошибки в словах и названиях: исправляй очевидные по смыслу, но ничего не придумывай.',
  'Пиши по-русски, просто и без канцелярита.'
].join('\n');
const TRANSCRIPT_SUMMARY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['brief', 'points'],
  properties: { brief: { type: 'string' }, points: { type: 'array', items: { type: 'string' } } }
};
handle('transcript-summary', async (id) => {
  const t = store.getTranscript(id);
  if (!t) return { ok: false, error: 'Этой расшифровки уже нет.' };
  if (!keys.openai) return { ok: false, error: 'Для краткого содержания нужен ключ ChatGPT: «Настройки» → «API-ключи».' };
  const model = modelById('gpt-6.1-sol');
  const client = new OpenAI({ apiKey: keys.openai });
  const controller = new AbortController();
  try {
    const r = await client.responses.create({
      model: model.id, instructions: TRANSCRIPT_SUMMARY_PROMPT, input: 'Файл: «' + t.name + '».\n\n' + t.text.slice(0, 400000),
      reasoning: { effort: 'low' }, max_output_tokens: 8000, store: false,
      text: { format: { type: 'json_schema', name: 'summary', strict: true, schema: TRANSCRIPT_SUMMARY_SCHEMA } }
    }, { signal: controller.signal });
    recordSpend(model, openaiUsage(r), controller.signal);
    if (r.status === 'incomplete') return { ok: false, error: 'Ответ оборвался. Попробуйте ещё раз.' };
    let summary;
    try { summary = JSON.parse(r.output_text || ''); } catch (e) { return { ok: false, error: 'Модель ответила не так, как нужно. Попробуйте ещё раз.' }; }
    const saved = await store.saveTranscript({ id: t.id, summary });
    await store.recordTranscribe();
    return ok({ transcript: saved, transcripts: store.transcriptList(), cost: runCost.get(controller.signal) || 0, info: info() });
  } catch (e) {
    console.error('transcript summary', e && e.status, e && (e.code || e.type));
    return { ok: false, error: modelError(e) || 'Краткое содержание не получилось. Попробуйте ещё раз.' };
  }
});
// Text or timings copied: counts in the statistics like copying a prompt.
handle('transcript-copy', async (text) => {
  clipboard.writeText(String(text || ''));
  await store.recordTranscribe();
  return ok();
});
// Subtitles (.srt) or text (.txt) into a file the user chooses; by default next to the original file.
handle('transcript-export', async function (id, kind, content) {
  const t = store.getTranscript(id);
  if (!t) return { ok: false, error: 'Этой расшифровки уже нет.' };
  const ext = kind === 'srt' ? 'srt' : 'txt';
  const stem = path.parse(t.name).name || 'расшифровка';
  const near = t.source && fs.existsSync(path.dirname(t.source)) ? path.dirname(t.source) : app.getPath('documents');
  const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(this.sender) || activeWin(), {
    title: ext === 'srt' ? 'Сохранить субтитры' : 'Сохранить текст', defaultPath: path.join(near, stem + '.' + ext),
    filters: [ext === 'srt' ? { name: 'Субтитры', extensions: ['srt'] } : { name: 'Текст', extensions: ['txt'] }]
  });
  if (r.canceled || !r.filePath) return { ok: true, canceled: true };
  // A BOM so that old Windows programs read Russian letters right; editors for subtitles understand it too.
  await fsp.writeFile(r.filePath, '﻿' + String(content || '').replace(/\r?\n/g, '\r\n'), 'utf8');
  await store.recordTranscribe();
  return ok({ path: r.filePath });
});
handle('transcript-show-source', async (id) => {
  const t = store.getTranscript(id);
  if (!t || !t.source || !fs.existsSync(t.source)) return { ok: false, error: 'Исходного файла на месте уже нет.' };
  shell.showItemInFolder(t.source);
  return { ok: true };
});

handle('assistant-stop', async (id) => {
  const c = streams.get(id);
  if (c) c.abort();
  return { ok: true };
});

// Tasks board, stored in tasks.json beside the prompts.
handle('task-save', async (t) => { const saved = await store.saveTask(t); return ok({ taskId: saved.id }); });
handle('task-delete', async (id) => { await store.deleteTask(id); return ok(); });
// «Отменить» after deleting: the task comes back exactly as it was.
handle('task-restore', async (t) => { await store.putTask(t); return ok(); });
// The user's own columns between «В процессе» and «Готово».
handle('column-add', async (name) => { const col = await store.addColumn(name); return ok({ columnId: col.id }); });
handle('column-rename', async (id, name) => { await store.renameColumn(id, name); return ok(); });
handle('column-move', async (id, dir) => { await store.moveColumn(id, dir); return ok(); });
// Returns what «Отменить» needs: the column, its place and the tasks that moved to «Предстоит».
handle('column-delete', async (id) => { const removed = await store.deleteColumn(id); return ok({ removed }); });
handle('column-restore', async (r) => { await store.restoreColumn(r); return ok(); });
// The archive of done tasks: «Убрать в архив» (ids, or all of «Готово»), «Отменить» / «Вернуть на доску», the mode.
handle('tasks-archive', async (ids) => { const archived = await store.archiveDone(Array.isArray(ids) ? ids : null); return ok({ archived }); });
handle('tasks-unarchive', async (ids) => { await store.unarchive(Array.isArray(ids) ? ids : []); return ok(); });
handle('tasks-archive-mode', async (mode) => { await store.setArchiveMode(mode); const archived = await store.autoArchive(); return ok({ archived }); });
// Done tasks leave by themselves (store.archiveMode): a few seconds after the start and then every 5 minutes,
// so it also happens after midnight while the program stays open. The windows get the fresh board and a hint.
async function autoArchiveTasks() {
  if (!store) return;
  try {
    const ids = await store.autoArchive();
    if (!ids.length || !liveWins().length) return;
    syncOthers(ok(), null);
    broadcast('tasks-archived', ids.length);
  } catch (e) { console.error('auto archive', e); }
}

/* ---------- the tasks assistant ---------- */
// The bar above the board. Its own assistant that only knows tasks: always the cheapest model with quick thinking,
// every message is a separate request (no conversation), changes apply at once without cards,
// and «Отменить» under the answer puts back everything this one message changed. Without keys simple word rules answer.
const TASKS_PROMPT = [
  'Ты — ассистент раздела «Задачи» в программе Snowball.ai. Ты работаешь только с задачами пользователя: добавляешь, меняешь, переносишь, отмечаешь сделанными, разбиваешь на подзадачи, удаляешь и отвечаешь, что запланировано.',
  'Столбцы: todo — «Предстоит», doing — «В процессе», done — «Готово» и, может быть, свои столбцы пользователя (их id и названия — в tasks_list). Новая задача — в todo, если не сказано иное.',
  'Каждое сообщение — отдельная просьба. Делай сразу и не переспрашивай, если смысл понятен: изменения применяются сразу, а у пользователя есть кнопка «Отменить».',
  'Из одного сообщения может получиться несколько задач: «смонтировать рилс завтра и позвонить Диме в пятницу» — это две задачи.',
  'Название — суть в 2–6 словах, с большой буквы, без слов про срок и срочность. Срок (due, YYYY-MM-DD) и время (time, HH:MM) ставь, только если их назвали; даты считай от строки «Сейчас». Важность priority: 2 — срочно (срочно, горит, asap), 1 — важно, 0 — обычно, если ничего такого не сказано. Теги — 1–2 коротких слова по смыслу, лучше из тех, что уже есть у задач в tasks_list: «смонтировать рилс» → «Монтаж», «начать вёрстку сайта» → «Сайт».',
  'Чтобы изменить, перенести, отметить или удалить задачу, сначала найди её id через tasks_list. «Сделал …», «готово …» — перенеси задачу в done. subtasks_add добавляет шаги внутри задачи («разбей … на шаги» — 3–6 конкретных шагов), subtask_done отмечает шаг, subtask_delete удаляет шаги (id шагов — в tasks_list).',
  'Выполненные задачи уходят в архив: tasks_list его не показывает. «Найди в архиве …», «что я делал на прошлой неделе» — tasks_archive_search. «Убери выполненные в архив», «очисти готово» — tasks_archive_done.',
  'Если просят не про задачи (календарь, промты, вкладки), коротко скажи, что это умеет маленькое окно ассистента (звёздочка внизу слева) или раздел LLM.',
  'Ответ — одна-две короткие фразы по-русски без разметки: что сделано. Например: «Добавил 2 задачи: «Смонтировать рилс» на завтра, срочная; «Позвонить Диме» на пятницу.»'
].join('\n\n');
const sameTool = (name, description) => Object.assign({}, TOOLS.find((t) => t.name === name), description ? { description } : {});
const TASK_TOOLS = [
  sameTool('tasks_list'),
  sameTool('tasks_archive_search'),
  { name: 'tasks_archive_done', description: 'Убирает все задачи из «Готово» в архив.', parameters: { type: 'object', additionalProperties: false, required: [], properties: {} } },
  sameTool('task_add', 'Добавляет задачу на доску (сразу, без подтверждения).'),
  sameTool('task_update', 'Меняет задачу: название, столбец (done — сделано), срок, важность, теги, заметку. Передай все поля; то, что не меняется, — как было в tasks_list.'),
  { name: 'task_delete', description: 'Удаляет задачу.', parameters: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', description: 'id задачи из tasks_list' } } } },
  {
    name: 'subtasks_add',
    description: 'Добавляет шаги (подзадачи) в конец задачи.',
    parameters: { type: 'object', additionalProperties: false, required: ['id', 'titles'], properties: { id: { type: 'string', description: 'id задачи' }, titles: { type: 'array', items: { type: 'string' } } } }
  },
  {
    name: 'subtask_done',
    description: 'Отмечает шаг задачи сделанным или снимает отметку.',
    parameters: { type: 'object', additionalProperties: false, required: ['id', 'subtask_id', 'done'], properties: { id: { type: 'string', description: 'id задачи' }, subtask_id: { type: 'string' }, done: { type: 'boolean' } } }
  },
  {
    name: 'subtask_delete',
    description: 'Удаляет шаги (подзадачи) из задачи. Можно передать несколько subtask_ids сразу.',
    parameters: { type: 'object', additionalProperties: false, required: ['id', 'subtask_ids'], properties: { id: { type: 'string', description: 'id задачи' }, subtask_ids: { type: 'array', items: { type: 'string' } } } }
  }
];

// Every change goes through here and is remembered in log, so «Отменить» can put the tasks back.
async function loggedTask(log, id, fn) {
  const before = id ? store.findTask(id) : null;
  const r = await fn();
  log.push({ before: before ? JSON.parse(JSON.stringify(before)) : null, id: r ? r.id : id });
  return r;
}
async function runTaskTool(name, input, log) {
  const a = input && typeof input === 'object' ? input : {};
  if (name === 'tasks_list') return tasksForModel();
  if (name === 'tasks_archive_search') return archiveForModel(a.query);
  if (name === 'tasks_archive_done') {
    const ids = store.tasks.filter((t) => t.status === 'done' && !t.archivedAt).map((t) => t.id);
    for (const id of ids) await loggedTask(log, id, async () => { await store.archiveDone([id]); return store.findTask(id); });
    return ids.length ? 'Убрано в архив: ' + ids.length + '.' : 'В «Готово» нечего убирать.';
  }
  if (name === 'task_add') {
    const t = normalizeTask(Object.assign({ title: a.title, status: a.status, subtasks: (Array.isArray(a.subtasks) ? a.subtasks : []).map((s) => ({ title: s })) }, taskFields(a)));
    if (!t) return 'Ошибка: нужно название задачи.';
    const saved = await loggedTask(log, null, () => store.saveTask(Object.assign({}, t, { id: undefined, order: undefined, createdAt: undefined })));
    return 'Добавлено: ' + taskLine(saved) + ', id ' + saved.id;
  }
  const prev = store.findTask(String(a.id || ''));
  if (!prev) return 'Задачи с таким id нет. Найди её через tasks_list.';
  if (name === 'task_update') {
    const saved = await loggedTask(log, prev.id, () => store.saveTask(Object.assign({ id: prev.id, title: a.title || prev.title, status: store.hasColumn(a.status) ? a.status : prev.status }, taskFields(a))));
    return 'Изменено: ' + taskLine(saved);
  }
  if (name === 'task_delete') {
    await loggedTask(log, prev.id, () => store.deleteTask(prev.id));
    return 'Удалено.';
  }
  if (name === 'subtasks_add') {
    const titles = (Array.isArray(a.titles) ? a.titles : []).map((s) => ({ title: s }));
    const saved = await loggedTask(log, prev.id, () => store.saveTask({ id: prev.id, subtasks: prev.subtasks.concat(titles) }));
    return 'Шаги добавлены, теперь их ' + saved.subtasks.length + '.';
  }
  if (name === 'subtask_done') {
    if (!prev.subtasks.some((s) => s.id === a.subtask_id)) return 'Такого шага нет: возьми subtask_id из tasks_list.';
    await loggedTask(log, prev.id, () => store.saveTask({ id: prev.id, subtasks: prev.subtasks.map((s) => (s.id === a.subtask_id ? Object.assign({}, s, { done: !!a.done }) : s)) }));
    return 'Отмечено.';
  }
  if (name === 'subtask_delete') {
    const ids = new Set((Array.isArray(a.subtask_ids) ? a.subtask_ids : []).map(String));
    const gone = prev.subtasks.filter((s) => ids.has(s.id));
    if (!gone.length) return 'Таких шагов нет: возьми subtask_ids из tasks_list.';
    await loggedTask(log, prev.id, () => store.saveTask({ id: prev.id, subtasks: prev.subtasks.filter((s) => !ids.has(s.id)) }));
    return 'Удалено шагов: ' + gone.length + '.';
  }
  return 'Такого инструмента нет.';
}

// The tasks assistant and the calendar assistant run on the same two loops; cfg says which prompt, tools and runner.
const TASKS_CFG = { prompt: TASKS_PROMPT, tools: TASK_TOOLS, run: runTaskTool };
async function tasksOpenai(model, text, log, signal, cfg = TASKS_CFG) {
  const client = new OpenAI({ apiKey: keys.openai });
  const tools = cfg.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: true }));
  let input = [{ role: 'user', content: text }];
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const r = await client.responses.create({
      model: model.id, instructions: cfg.prompt +'\n\n' + nowLine(), input, tools,
      reasoning: { effort: 'low' }, max_output_tokens: 8000, store: false
    }, { signal });
    recordSpend(model, openaiUsage(r), signal);
    if (r.status === 'incomplete') throw userError('Ответ оборвался. Попробуйте написать короче.');
    const calls = (r.output || []).filter((item) => item.type === 'function_call');
    if (!calls.length) {
      return r.output_text || (r.output || []).filter((item) => item.type === 'message')
        .map((item) => (item.content || []).filter((c) => c.type === 'output_text').map((c) => c.text).join('')).join('\n').trim();
    }
    input = input.concat(r.output);
    for (const c of calls) {
      let args = null;
      try { args = JSON.parse(c.arguments || '{}'); } catch (e) { args = null; }
      input.push({ type: 'function_call_output', call_id: c.call_id, output: args ? await cfg.run(c.name, args, log) : 'Ошибка: аргументы не прочитались, повтори вызов.' });
    }
  }
  return 'Сделал, что успел.';
}
async function tasksClaude(model, text, log, signal, cfg = TASKS_CFG) {
  const client = new Anthropic({ apiKey: keys.anthropic });
  const tools = cfg.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters, strict: true }));
  let msgs = [{ role: 'user', content: text }];
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const final = await client.beta.messages.create({
      model: model.id, max_tokens: 8000, tools, messages: msgs, output_config: { effort: 'low' },
      system: [{ type: 'text', text: cfg.prompt, cache_control: { type: 'ephemeral' } }, { type: 'text', text: nowLine() }]
    }, { signal });
    const u = final.usage || {};
    recordSpend(model, { input: u.input_tokens || 0, cached: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, output: u.output_tokens || 0 }, signal);
    if (final.stop_reason === 'refusal') throw userError('Claude отказался выполнять эту просьбу. Попробуйте сформулировать иначе.');
    if (final.stop_reason !== 'tool_use') return final.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    msgs = msgs.concat([{ role: 'assistant', content: final.content }]);
    const results = [];
    for (const b of final.content) {
      if (b.type === 'tool_use') results.push({ type: 'tool_result', tool_use_id: b.id, content: await cfg.run(b.name, b.input, log) });
    }
    msgs.push({ role: 'user', content: results });
  }
  return 'Сделал, что успел.';
}

/* Without keys: simple word rules, the same ones the mockup shows (mockups/tasks.html). */
const TASK_TAG_RULES = [
  [/смонтир|монтаж|монтир/, 'Монтаж'], [/сн[яи]ть|съ[её]мк|отснять|снимать/, 'Съёмка'], [/сценари/, 'Сценарий'],
  [/пром[пт]?т/, 'Промты'], [/опублик|выложить|залить|публикац|запостить/, 'Публикация'], [/верст|сайт|лендинг/, 'Сайт'],
  [/созвон|позвонить|звонок/, 'Звонок'], [/сгенерир|генерац/, 'Генерация'], [/урок|курс/, 'Обучение']
];
const WEEK_WORDS = [['понедельник', 1], ['вторник', 2], ['сред', 3], ['четверг', 4], ['пятниц', 5], ['суббот', 6], ['воскресень', 0]];
const TASK_STEPS = {
  'Монтаж': ['Нарезать исходники', 'Собрать черновой монтаж', 'Цветокоррекция', 'Музыка и звук', 'Субтитры', 'Экспорт'],
  'Сайт': ['Структура страниц', 'Дизайн', 'Вёрстка', 'Проверить на телефоне', 'Опубликовать'],
  'Съёмка': ['Сценарий и раскадровка', 'Подготовить свет и звук', 'Снять', 'Скинуть исходники'],
  'Сценарий': ['Собрать идеи', 'Структура', 'Написать текст', 'Перечитать и сократить'],
  '': ['Подготовить всё нужное', 'Сделать', 'Проверить результат']
};
function plusDayKey(n) { const d = new Date(); d.setDate(d.getDate() + n); return dayKeyOf(d); }
// "смонтировать рилс завтра срочно" → { title: "Смонтировать рилс", due: tomorrow, priority: 2, tags: ["Монтаж"] }
function stubTaskParse(text) {
  let s = ' ' + text.trim() + ' ';
  const r = { title: '', due: '', time: '', priority: 0, tags: [] };
  const cut = (re) => { s = s.replace(re, ' '); };
  let low = s.toLowerCase(), m;
  if (/срочн|горит|asap|как можно скорее/.test(low)) { r.priority = 2; cut(/\s!*(очень\s+)?срочн[а-яё]*/gi); cut(/\s(горит|asap|как можно скорее)/gi); }
  else if (/\s!*важн/.test(low)) { r.priority = 1; cut(/\s!*(очень\s+)?важн[а-яё]*/gi); }
  low = s.toLowerCase();
  if (/\sпослезавтра\s/.test(low)) { r.due = plusDayKey(2); cut(/\s(на\s+)?послезавтра(?=\s)/gi); }
  else if (/\sзавтра\s/.test(low)) { r.due = plusDayKey(1); cut(/\s(на\s+)?завтра(?=\s)/gi); }
  else if (/\sсегодня\s/.test(low)) { r.due = plusDayKey(0); cut(/\s(на\s+)?сегодня(?=\s)/gi); }
  else if (/\sвчера\s/.test(low)) { r.due = plusDayKey(-1); cut(/\s(на\s+)?вчера(?=\s)/gi); }
  else if ((m = /\sчерез\s+(\d+)\s+(дн|день|дня)\S*/.exec(low))) { r.due = plusDayKey(+m[1]); cut(/\sчерез\s+\d+\s+(дн|день|дня)\S*/gi); }
  else if (/\sчерез неделю/.test(low)) { r.due = plusDayKey(7); cut(/\sчерез неделю/gi); }
  else {
    WEEK_WORDS.some((w) => {
      const re = new RegExp('\\s(в|во|до|к|на)?\\s*' + w[0] + '\\S*', 'i');
      if (!re.test(s)) return false;
      r.due = plusDayKey((w[1] - new Date().getDay() + 7) % 7 || 7);
      cut(re);
      return true;
    });
  }
  if ((m = /\s(в|к)?\s*(\d{1,2})[:.](\d{2})(?=\s)/.exec(s)) && +m[2] < 24) {
    r.time = pad2(+m[2]) + ':' + m[3];
    if (!r.due) r.due = plusDayKey(0);
    cut(/\s(в|к)?\s*\d{1,2}[:.]\d{2}(?=\s)/);
  }
  low = s.toLowerCase();
  TASK_TAG_RULES.forEach((tr) => { if (r.tags.length < 2 && tr[0].test(low) && !r.tags.includes(tr[1])) r.tags.push(tr[1]); });
  s = s.replace(/^\s*(надо|нужно|не забыть|напомни)\s+/i, ' ').replace(/\s+/g, ' ').replace(/[\s,.]+$/, '').trim();
  r.title = s.charAt(0).toUpperCase() + s.slice(1);
  return r;
}
const TASK_STOP = ['перенеси', 'перенести', 'сдвинь', 'передвинь', 'отметь', 'отметить', 'удали', 'удалить', 'убери', 'сделал', 'сделала', 'сделано', 'готово', 'готова',
  'выполнил', 'выполнила', 'закрой', 'разбей', 'разбить', 'задачу', 'задача', 'задачи', 'подзадачи', 'шаги', 'шагов', 'этапы', 'сделанной', 'выполненной', 'сделай',
  'поставь', 'срочной', 'срочно', 'важной', 'важно', 'обычной', 'про', 'для', 'мне', 'меня', 'что', 'какие', 'работу', 'процесс', 'предстоит'];
function taskStems(s) {
  return (String(s).toLowerCase().replace(/ё/g, 'е').match(/[а-яa-z0-9]+/g) || []).filter((w) => w.length >= 3 && !TASK_STOP.includes(w)).map((w) => w.slice(0, 4));
}
// The task whose title shares the most word beginnings with the phrase.
function stubFindTask(text, openOnly) {
  const q = taskStems(text);
  let best = null, score = 0;
  store.tasks.forEach((t) => {
    if (openOnly && t.status === 'done') return;
    const ts = taskStems(t.title);
    const sc = q.filter((x) => ts.includes(x)).length;
    if (sc > score) { score = sc; best = t; }
  });
  return best;
}
function stubTaskWords(t) {
  const more = [];
  if (t.due) more.push(taskDue(t));
  if (t.priority) more.push(PRIORITY_NAMES[t.priority]);
  t.tags.forEach((g) => more.push('#' + g));
  return '«' + t.title + '»' + (more.length ? ' (' + more.join(', ') + ')' : '');
}
const STUB_NOT_FOUND = 'Не нашёл такую задачу. Напишите точнее, как она называется.';
async function stubTasksAssistant(text, log) {
  const low = ' ' + text.toLowerCase().replace(/ё/g, 'е') + ' ';
  let t;
  if (/в архиве|из архива/.test(low)) {
    const q = text.replace(/^.*?(в архиве|из архива)\s*/i, '').replace(/[?.!]+$/, '');
    const found = archiveSearch(q);
    return found.length ? 'В архиве: ' + found.slice(0, 8).map((x) => '«' + x.title + '» (' + humanDay(dayKeyOf(new Date(x.doneAt))) + ')').join(', ') + '.' : 'В архиве такого нет.';
  }
  if (/в архив|очисти готово|убери (все )?(выполненные|готовые|сделанные)/.test(low)) {
    const ids = store.tasks.filter((x) => x.status === 'done' && !x.archivedAt).map((x) => x.id);
    for (const id of ids) await loggedTask(log, id, async () => { await store.archiveDone([id]); return store.findTask(id); });
    return ids.length ? 'Убрал в архив ' + ids.length + ' ' + (ids.length === 1 ? 'задачу' : ids.length < 5 ? 'задачи' : 'задач') + ' из «Готово».' : 'В «Готово» нечего убирать.';
  }
  if (/^\s*(что|какие|покажи|сколько)/.test(low) || /\?\s*$/.test(text)) {
    const today = dayKeyOf(new Date()), open = store.tasks.filter((x) => x.status !== 'done');
    const late = open.filter((x) => x.due && x.due < today);
    let name, list;
    if (/послезавтра/.test(low)) { name = 'На послезавтра'; list = open.filter((x) => x.due === plusDayKey(2)); }
    else if (/завтра/.test(low)) { name = 'На завтра'; list = open.filter((x) => x.due === plusDayKey(1)); }
    else if (/недел/.test(low)) { name = 'На неделю'; list = open.filter((x) => x.due && x.due >= today && x.due <= plusDayKey(7)); }
    else if (/горит|просроч|срочн/.test(low)) { name = 'Горит'; list = open.filter((x) => x.priority === 2 || (x.due && x.due < today)); }
    else { name = 'На сегодня'; list = open.filter((x) => x.due === today); }
    let s = list.length ? name + ' ' + list.length + ' ' + (list.length === 1 ? 'задача' : list.length < 5 ? 'задачи' : 'задач') + ': ' + list.map((x) => '«' + x.title + '»' + (x.time ? ' в ' + x.time : '')).join(', ') + '.' : name + ' задач нет.';
    if (name !== 'Горит' && late.length) s += ' И ещё срок прошёл у ' + late.map((x) => '«' + x.title + '»').join(', ') + '.';
    return s;
  }
  if (/разб(ей|ить)|на шаги|на подзадачи|на этапы/.test(low)) {
    if (!(t = stubFindTask(text))) return STUB_NOT_FOUND;
    const have = t.subtasks.map((s) => s.title.toLowerCase());
    const steps = (TASK_STEPS[t.tags[0]] || TASK_STEPS['']).filter((s) => !have.includes(s.toLowerCase()));
    if (!steps.length) return 'У «' + t.title + '» эти шаги уже есть.';
    await loggedTask(log, t.id, () => store.saveTask({ id: t.id, subtasks: t.subtasks.concat(steps.map((s) => ({ title: s }))) }));
    return 'Разбил «' + t.title + '» на шаги: добавил ' + steps.length + '. Лишнее можно убрать в задаче.';
  }
  if (/^\s*(удали|убери|удалить)/.test(low)) {
    if (!(t = stubFindTask(text))) return STUB_NOT_FOUND;
    await loggedTask(log, t.id, () => store.deleteTask(t.id));
    return 'Удалил «' + t.title + '».';
  }
  if (/\s(сделал[аи]?|готово|готова|выполнил[аи]?|отметь|закрой)\s/.test(low)) {
    if (!(t = stubFindTask(text, true))) return STUB_NOT_FOUND;
    await loggedTask(log, t.id, () => store.saveTask({ id: t.id, status: 'done' }));
    return 'Отметил «' + t.title + '» сделанной — она в «Готово».';
  }
  if (/^\s*(перенеси|сдвинь|передвинь|перенести)/.test(low)) {
    let target = /в работу|в процесс/.test(low) ? 'doing' : /в предсто|обратно/.test(low) ? 'todo' : null;
    let rest = text.replace(/в работу|в процесс\S*|в предсто\S*/gi, ' ');
    // "перенеси рилс в на проверке": one of the user's own columns, by its name
    store.columns.forEach((c) => {
      const at = low.indexOf(' в ' + c.name.toLowerCase().replace(/ё/g, 'е'));
      if (!target && at !== -1) { target = c.id; rest = text.slice(0, at); }
    });
    if (target) {
      if (!(t = stubFindTask(rest))) return STUB_NOT_FOUND;
      await loggedTask(log, t.id, () => store.saveTask({ id: t.id, status: target }));
      return 'Перенёс «' + t.title + '» в «' + columnName(target) + '».';
    }
    const p = stubTaskParse(text);
    if (!p.due) return 'Не понял, на когда перенести. Например: «перенеси вёрстку сайта на понедельник».';
    if (!(t = stubFindTask(p.title))) return STUB_NOT_FOUND;
    const saved = await loggedTask(log, t.id, () => store.saveTask({ id: t.id, due: p.due, time: p.time || t.time }));
    return 'Перенёс «' + t.title + '» на ' + taskDue(saved) + '.';
  }
  if (/^\s*(сделай|поставь)\s.*(срочн|важн|обычн)/.test(low)) {
    const level = /срочн/.test(low) ? 2 : /важн/.test(low) ? 1 : 0;
    if (!(t = stubFindTask(text))) return STUB_NOT_FOUND;
    await loggedTask(log, t.id, () => store.saveTask({ id: t.id, priority: level }));
    return 'Теперь «' + t.title + '» — ' + PRIORITY_NAMES[level] + '.';
  }
  const body = text.replace(/^\s*(добавь|добавить|запиши|создай|новая задача|напомни)\s*(задачу|задачи)?[:\s,]*/i, '');
  const parts = body.split(/\s*;\s*|\n+|\s+и\s+(?=[а-яё]+(?:ть|ться|ти)(?:\s|$))/i).filter((x) => x.trim());
  const made = [];
  for (const part of parts) {
    const p = stubTaskParse(part);
    if (p.title) made.push(await loggedTask(log, null, () => store.saveTask(p)));
  }
  if (!made.length) return 'Не понял, что добавить. Напишите, что нужно сделать.';
  return made.length === 1 ? 'Добавил ' + stubTaskWords(made[0]) + ' в «Предстоит».'
    : 'Добавил ' + made.length + ' ' + (made.length < 5 ? 'задачи' : 'задач') + ' в «Предстоит»: ' + made.map(stubTaskWords).join(', ') + '.';
}

const taskUndos = new Map();   // undo id -> what one message to the tasks assistant changed
let taskUndoSeq = 0;
handle('tasks-assistant', async function (text) {
  const msg = String(text || '').trim().slice(0, 2000);
  if (!msg) return { ok: false, error: 'Напишите, что сделать с задачами.' };
  store.recordAssistant();
  const model = quickModel();
  const log = [];
  const controller = new AbortController();
  let reply = '', failed = false;
  try {
    if (!model) reply = await stubTasksAssistant(msg, log);
    else reply = await (model.provider === 'openai' ? tasksOpenai : tasksClaude)(model, msg, log, controller.signal);
  } catch (e) {
    if (e instanceof OpenAI.APIError || e instanceof Anthropic.APIError) console.error('tasks assistant', e.status, e.code || e.type);
    else if (!e.userMessage) console.error('tasks assistant', e);
    reply = e.userMessage || modelError(e) || 'Ассистент не ответил. Попробуйте ещё раз.';
    failed = true;
  }
  let undoId = null;
  if (log.length) {
    undoId = 'u' + (++taskUndoSeq);
    taskUndos.set(undoId, log);
    if (taskUndos.size > 20) taskUndos.delete(taskUndos.keys().next().value);
  }
  const changed = Array.from(new Set(log.map((x) => x.id).filter((id) => id && store.findTask(id))));
  return ok({ reply: reply || 'Готово.', failed, undoId, changed, cost: runCost.get(controller.signal) || 0, info: info() });
});
// «Отменить» under the answer: everything that message changed goes back, newest change first.
handle('tasks-assistant-undo', async (undoId) => {
  const log = taskUndos.get(undoId);
  if (!log) return { ok: false, error: 'Отменить уже нельзя.' };
  taskUndos.delete(undoId);
  for (const x of log.slice().reverse()) {
    if (x.before) await store.putTask(x.before);
    else if (x.id) await store.deleteTask(x.id);
  }
  return ok();
});

/* ---------- the calendar assistant ---------- */
// The bar above the calendar works like the one above the tasks: the cheapest model, every message is a separate
// request, changes apply at once, «Отменить» puts back everything one message changed.
const CAL_PROMPT = [
  'Ты — ассистент раздела «Календарь» в программе Snowball.ai. Ты работаешь только с делами в календаре: добавляешь, переносишь, меняешь, удаляешь и отвечаешь, что запланировано и что решили на прошедших созвонах.',
  'Каждое сообщение — отдельная просьба. Делай сразу и не переспрашивай, если смысл понятен: изменения применяются сразу, а у пользователя есть кнопка «Отменить».',
  'Названия дел короткие: суть в 2–5 слов, без слова-типа («Правки монтажа YouTube», тип call). Имена собеседников — в who. Если время не названо, поставь 10:00. Напоминание по умолчанию за час (remind 60), если не сказано иное, и коротко скажи об этом. Даты считай от строки «Сейчас».',
  'Чтобы изменить или удалить дело, сначала найди его id через calendar_list. У дел с итогами созвона в списке есть recap: там коротко главное и что решили. Отвечай по ним, если спрашивают про прошедший созвон.',
  'Если просят не про календарь (задачи, промты, вкладки), коротко скажи, что это умеет маленькое окно ассистента (звёздочка внизу слева) или раздел LLM.',
  'Ответ — одна-две короткие фразы по-русски без разметки: что сделано.'
].join('\n\n');
const CAL_TOOLS = [
  sameTool('calendar_list', 'Показывает дела из календаря пользователя за период (включительно) с id. Если у дела есть итоги созвона, в recap — коротко главное и решения.'),
  sameTool('calendar_add', 'Добавляет дело в календарь сразу, без подтверждения.'),
  sameTool('calendar_update', 'Меняет дело сразу: перенос на другой день или время, название, тип, заметка, напоминание. Передай все поля; то, что не меняется, — как было в calendar_list.'),
  sameTool('calendar_delete', 'Удаляет дело из календаря сразу.')
];
async function loggedEvent(log, id, fn) {
  const before = id ? store.findEvent(id) : null;
  const r = await fn();
  log.push({ before: before ? JSON.parse(JSON.stringify(before)) : null, id: r ? r.id : id });
  return r;
}
async function runCalTool(name, input, log) {
  const a = input && typeof input === 'object' ? input : {};
  if (name === 'calendar_list') {
    if (!DATE_ONLY.test(a.from || '') || !DATE_ONLY.test(a.to || '')) return 'Ошибка: from и to должны быть датами YYYY-MM-DD.';
    const list = store.calendarView().filter((e) => e.date >= a.from && e.date <= a.to).slice(0, 200).map((e) => {
      const o = { id: e.id, date: e.date, from: e.from, to: e.to, who: e.who, title: e.title, kind: e.kind, note: e.note, remind: e.remind };
      if (e.recap) o.recap = { brief: e.recap.brief, decisions: e.recap.decisions };
      return o;
    });
    return list.length ? JSON.stringify(list) : 'В этот период дел нет.';
  }
  const fields = () => ({ date: a.date, from: a.from, to: a.to, who: a.who, title: a.title, kind: a.kind, note: a.note, remind: a.remind });
  if (name === 'calendar_add') {
    if (!DATE_ONLY.test(a.date || '') || !normalizeEvent(fields())) return 'Ошибка: нужна дата YYYY-MM-DD и время HH:MM.';
    const saved = await loggedEvent(log, null, () => store.saveEvent(fields()));
    return 'Добавлено: ' + eventLine(saved) + ', id ' + saved.id;
  }
  const prev = store.findEvent(String(a.id || ''));
  if (!prev) return 'Дела с таким id нет. Найди его через calendar_list.';
  if (name === 'calendar_update') {
    if (!DATE_ONLY.test(a.date || '')) return 'Ошибка: нужна дата YYYY-MM-DD и время HH:MM.';
    const saved = await loggedEvent(log, prev.id, () => store.saveEvent(Object.assign(fields(), { id: prev.id })));
    return 'Изменено: ' + eventLine(saved);
  }
  if (name === 'calendar_delete') {
    await loggedEvent(log, prev.id, () => store.deleteEvent(prev.id));
    return 'Удалено.';
  }
  return 'Такого инструмента нет.';
}
const CAL_CFG = { prompt: CAL_PROMPT, tools: CAL_TOOLS, run: runCalTool };
const calUndos = new Map();
let calUndoSeq = 0;
handle('cal-assistant', async function (text) {
  const msg = String(text || '').trim().slice(0, 2000);
  if (!msg) return { ok: false, error: 'Напишите, что сделать с календарём.' };
  const model = quickModel();
  if (!model) return { ok: false, error: 'Ассистенту календаря нужен ключ ChatGPT или Claude: «Настройки» → «API-ключи».' };
  store.recordAssistant();
  const log = [];
  const controller = new AbortController();
  let reply = '', failed = false;
  try {
    reply = await (model.provider === 'openai' ? tasksOpenai : tasksClaude)(model, msg, log, controller.signal, CAL_CFG);
  } catch (e) {
    if (e instanceof OpenAI.APIError || e instanceof Anthropic.APIError) console.error('calendar assistant', e.status, e.code || e.type);
    else if (!e.userMessage) console.error('calendar assistant', e);
    reply = e.userMessage || modelError(e) || 'Ассистент не ответил. Попробуйте ещё раз.';
    failed = true;
  }
  let undoId = null;
  if (log.length) {
    undoId = 'c' + (++calUndoSeq);
    calUndos.set(undoId, log);
    if (calUndos.size > 20) calUndos.delete(calUndos.keys().next().value);
  }
  const changed = Array.from(new Set(log.map((x) => x.id).filter((id) => id && store.findEvent(id))));
  return ok({ reply: reply || 'Готово.', failed, undoId, changed, cost: runCost.get(controller.signal) || 0, info: info() });
});
handle('cal-assistant-undo', async (undoId) => {
  const log = calUndos.get(undoId);
  if (!log) return { ok: false, error: 'Отменить уже нельзя.' };
  calUndos.delete(undoId);
  for (const x of log.slice().reverse()) {
    if (x.before) await store.putEvent(x.before);
    else if (x.id) await store.deleteEvent(x.id);
  }
  return ok();
});

/* ---------- call summaries in the calendar ---------- */
// The user loads a text about a call that happened (ready summary from another program, a transcript, or both);
// one request turns it into: short text, decisions, next steps, new meetings. It is kept in the event (`recap`).
// Steps become tasks and meetings become events only on the user's button in the window.
const RECAP_PROMPT = [
  'Ты разбираешь итоги созвона или встречи для программы Snowball.ai. Пользователь загрузил текст: это могут быть готовые итоги из другой программы, расшифровка разговора или и то и другое. Не выдумывай ничего, чего нет в тексте. Пиши по-русски, коротко и просто.',
  'title — название дела: суть в 2–5 словах без слова-типа («Правки монтажа YouTube»). who — с кем был разговор: имена собеседников через запятую, без самого пользователя (его ник дан ниже).',
  'brief — 2–4 предложения о самом главном. decisions — только то, о чём действительно договорились или что решили («делаем так, а не иначе»): короткие самостоятельные пункты. Пожелания, факты, обсуждение и просьбы пользователя самому себе или программе сюда не попадают.',
  'Если в тексте есть фраза, которую пользователь продиктовал не собеседнику, а себе или программе («добавь задачу…», «я хочу добавить задачу…», «напомни…»), это не решение созвона: сделай из неё шаг пользователя (mine — true), например «Создать задачу «Миникурс» с подзадачами: накидать структуру, дать креативные идеи».',
  'steps — следующие шаги: кто что пообещал сделать. t — действие коротко, с глагола («Прислать правки по вступлению»). who — имя исполнителя. mine — true, только если исполнитель сам пользователь (его ник, «я» в его реплике); если не ясно — false. due — срок в формате YYYY-MM-DD, если он назван («к пятнице», «завтра» считай от дня созвона), иначе пустая строка.',
  'meets — о чём договорились созвониться или встретиться ещё раз: t — короткая тема без слов о времени («Следующий созвон по мини-курсу», не «… завтра или послезавтра»), date — YYYY-MM-DD (от дня созвона), from — начало HH:MM (24 часа), to — окончание HH:MM; то, что не названо, — пустая строка. Если ни о чём такого не договорились, список пустой.'
].join('\n\n');
const RECAP_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['title', 'who', 'brief', 'decisions', 'steps', 'meets'],
  properties: {
    title: { type: 'string' }, who: { type: 'string' }, brief: { type: 'string' },
    decisions: { type: 'array', items: { type: 'string' } },
    steps: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['t', 'who', 'mine', 'due'], properties: { t: { type: 'string' }, who: { type: 'string' }, mine: { type: 'boolean' }, due: { type: 'string' } } } },
    meets: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['t', 'date', 'from', 'to'], properties: { t: { type: 'string' }, date: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' } } } }
  }
};
function recapModel() { return keys.openai ? modelById('gpt-6.1-sol') : keys.anthropic ? modelById('claude-haiku-5-5') : null; }
async function recapData(model, input, signal) {
  if (model.provider === 'openai') {
    const client = new OpenAI({ apiKey: keys.openai });
    const r = await client.responses.create({
      model: model.id, instructions: RECAP_PROMPT + '\n\n' + nowLine(), input,
      reasoning: { effort: 'low' }, max_output_tokens: 12000, store: false,
      text: { format: { type: 'json_schema', name: 'recap', strict: true, schema: RECAP_SCHEMA } }
    }, { signal });
    recordSpend(model, openaiUsage(r), signal);
    if (r.status === 'incomplete') throw userError('Ответ оборвался. Попробуйте ещё раз или загрузите текст покороче.');
    try { return JSON.parse(r.output_text || ''); } catch (e) { throw userError('Модель ответила не так, как нужно. Попробуйте ещё раз.'); }
  }
  const client = new Anthropic({ apiKey: keys.anthropic });
  const r = await client.beta.messages.create({
    model: model.id, max_tokens: 12000, messages: [{ role: 'user', content: input }],
    system: [{ type: 'text', text: RECAP_PROMPT, cache_control: { type: 'ephemeral' } }, { type: 'text', text: nowLine() }],
    tools: [{ name: 'save_recap', description: 'Сохраняет итоги созвона.', input_schema: RECAP_SCHEMA }],
    tool_choice: { type: 'tool', name: 'save_recap' }
  }, { signal });
  const u = r.usage || {};
  recordSpend(model, { input: u.input_tokens || 0, cached: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, output: u.output_tokens || 0 }, signal);
  const b = (r.content || []).find((x) => x.type === 'tool_use');
  if (!b) throw userError('Модель ответила не так, как нужно. Попробуйте ещё раз.');
  return b.input;
}
// o: { eventId (the event to put it on, or none for a new one), date (for a new event), text, name (where the text is from) }
async function makeRecap(o) {
  const text = String(o.text || '').trim().slice(0, 400000);
  if (!text) return { ok: false, error: 'Вставьте текст итогов или выберите файл.' };
  let ev = o.eventId ? store.findEvent(String(o.eventId)) : null;
  if (o.eventId && !ev) return { ok: false, error: 'Этого дела уже нет в календаре.' };
  const model = recapModel();
  if (!model) return { ok: false, error: 'Чтобы разобрать итоги, нужен ключ ChatGPT или Claude: «Настройки» → «API-ключи».' };
  const day = ev ? ev.date : (DATE_ONLY.test(String(o.date || '')) ? o.date : dayKeyOf(new Date()));
  const nick = store.profileView().name || 'не указан';
  const input = 'День созвона: ' + day + '.' + (ev ? ' Дело в календаре: «' + eventName(ev) + '».' : '') + ' Ник пользователя: ' + nick + '.\n\nТекст:\n' + text;
  const controller = new AbortController();
  try {
    store.recordAssistant();
    const d = await recapData(model, input, controller.signal);
    const recap = {
      brief: d.brief, decisions: d.decisions, steps: d.steps, meets: d.meets,
      source: String(o.name || '').slice(0, 200) || 'Вставленный текст', text, cost: runCost.get(controller.signal) || 0, madeAt: Date.now()
    };
    if (!ev) {
      const d2 = new Date();
      ev = await store.saveEvent({ date: day, from: pad2(d2.getHours()) + ':' + pad2(Math.floor(d2.getMinutes() / 10) * 10), to: '', who: d.who, title: d.title || 'Созвон', kind: 'call', note: '', remind: 0 });
    }
    await store.setRecap(ev.id, recap);
    return ok({ eventId: ev.id, date: ev.date, created: !o.eventId, cost: recap.cost, info: info() });
  } catch (e) {
    if (e instanceof OpenAI.APIError || e instanceof Anthropic.APIError) console.error('recap', e.status, e.code || e.type);
    else if (!e.userMessage) console.error('recap', e);
    return { ok: false, error: e.userMessage || modelError(e) || 'Итоги не получились. Попробуйте ещё раз.' };
  }
}
handle('recap-make', (o) => makeRecap(o || {}));
handle('recap-remake', (eventId) => {
  const ev = store.findEvent(String(eventId || ''));
  if (!ev || !ev.recap || !ev.recap.text) return { ok: false, error: 'У этого дела нет загруженного текста.' };
  return makeRecap({ eventId: ev.id, text: ev.recap.text, name: ev.recap.source });
});
handle('recap-update', async (eventId, recap) => { await store.setRecap(String(eventId || ''), recap && typeof recap === 'object' ? recap : null); return ok(); });
handle('recap-text', async (eventId) => ({ ok: true, text: store.recapText(String(eventId || '')) }));
handle('recap-pick-file', async function () {
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(this.sender) || activeWin(), {
    title: 'Выберите файл с итогами созвона', properties: ['openFile'],
    filters: [{ name: 'Текст', extensions: ['txt', 'md', 'srt', 'vtt', 'csv', 'log'] }]
  });
  if (r.canceled || !r.filePaths[0]) return { ok: true, canceled: true };
  const stat = await fsp.stat(r.filePaths[0]);
  if (stat.size > 5 * 1024 * 1024) return { ok: false, error: 'Файл больше 5 МБ — для итогов это слишком много.' };
  const text = (await fsp.readFile(r.filePaths[0], 'utf8')).replace(/^﻿/, '');
  return { ok: true, name: path.basename(r.filePaths[0]), text };
});

// Calendar, stored in calendar.json beside the prompts.
handle('cal-save', async (ev) => { const saved = await store.saveEvent(ev); return ok({ id: saved.id, date: saved.date }); });
handle('cal-delete', async (id) => { await store.deleteEvent(id); return ok(); });

/* Reminders: every 20 seconds main.js looks for events whose reminder time has come (up to 5 minutes late,
   so a reminder missed while the program was closed does not pop up hours later) and shows a notification. */
const reminded = new Set();
function remindLabel(min) { return min >= 1440 ? 'завтра' : min >= 60 ? 'через час' : 'через ' + min + ' минут'; }
/* ---------- focus timer ---------- */
// One timer for the whole program: kept here, so every window shows the same, and in settings.json, so it survives
// a restart. state: 'idle' | 'running' | 'paused' | 'ringing' (time is up, the window plays the melody until "Выключить").
// While it runs, the program's button on the Windows taskbar fills with a progress bar.
const TIMER_MAX = 240;   // minutes
let timer = { state: 'idle', duration: 0, endsAt: 0, left: 0 };
let timerTimeout = null;
let timerTick = null;
function timerLeft() { return timer.state === 'running' ? Math.max(0, timer.endsAt - Date.now()) : timer.left; }
function timerView() { return { state: timer.state, duration: timer.duration, endsAt: timer.endsAt, left: timerLeft() }; }
function paintTimerBar() {
  const frac = timer.duration ? 1 - timerLeft() / timer.duration : 0;
  liveWins().forEach((w) => {
    if (timer.state === 'running') w.setProgressBar(Math.min(1, Math.max(0.01, frac)), { mode: 'normal' });
    else if (timer.state === 'paused') w.setProgressBar(Math.min(1, Math.max(0.01, frac)), { mode: 'paused' });
    else if (timer.state === 'ringing') w.setProgressBar(1, { mode: 'error' });
    else w.setProgressBar(-1);
  });
}
function timerChanged() {
  clearTimeout(timerTimeout);
  clearInterval(timerTick);
  if (timer.state === 'running') {
    timerTimeout = setTimeout(ringTimer, Math.max(0, timer.endsAt - Date.now()));
    timerTick = setInterval(paintTimerBar, 5000);
  }
  paintTimerBar();
  settings.timer = timer.state === 'idle' ? undefined : Object.assign({}, timer);
  saveSettings();
  broadcast('timer', timerView());
}
function startTimer(minutes) {
  const m = Math.round(Math.min(TIMER_MAX, Math.max(1, Number(minutes) || 0)));
  timer = { state: 'running', duration: m * 60000, endsAt: Date.now() + m * 60000, left: m * 60000 };
  timerChanged();
  return m;
}
function ringTimer() {
  const minutes = Math.round(timer.duration / 60000);
  timer = { state: 'ringing', duration: timer.duration, endsAt: Date.now(), left: 0 };
  timerChanged();
  const away = !liveWins().some((w) => w.isFocused() && w.isVisible() && !w.isMinimized());
  if (away && Notification.isSupported()) {
    const n = new Notification({ title: 'Время вышло', body: 'Таймер на ' + minutes + ' ' + plural(minutes, 'минуту', 'минуты', 'минут') + ' закончился.', icon: path.join(__dirname, 'assets', 'icon.png') });
    n.on('failed', (_e, err) => console.error('notification', err));
    if (!app.isPackaged) n.on('show', () => console.log('notification shown:', n.title));
    n.on('click', () => showWin(win));
    n.show();
  }
  if (away && win && !win.isDestroyed()) win.flashFrame(true);
}
// After a restart: a running timer goes on; one that ended while the program was closed just ends quietly.
function restoreTimer() {
  const t = settings.timer;
  if (!t || typeof t !== 'object' || !(t.duration > 0)) return;
  if (t.state === 'running' && t.endsAt > Date.now()) timer = { state: 'running', duration: t.duration, endsAt: t.endsAt, left: 0 };
  else if (t.state === 'paused' && t.left > 0) timer = { state: 'paused', duration: t.duration, endsAt: 0, left: t.left };
  else timer = { state: 'idle', duration: 0, endsAt: 0, left: 0 };
  timerChanged();
}
// cmd: 'state', 'start' (arg — minutes), 'pause', 'resume', 'add' (arg — minutes), 'stop' (also silences the melody).
handle('timer', async (cmd, arg) => {
  if (cmd === 'start') startTimer(arg);
  else if (cmd === 'pause' && timer.state === 'running') { timer = { state: 'paused', duration: timer.duration, endsAt: 0, left: timerLeft() }; timerChanged(); }
  else if (cmd === 'resume' && timer.state === 'paused') { timer = { state: 'running', duration: timer.duration, endsAt: Date.now() + timer.left, left: timer.left }; timerChanged(); }
  else if (cmd === 'add' && (timer.state === 'running' || timer.state === 'paused')) {
    const ms = Math.round(Math.min(60, Math.max(1, Number(arg) || 5))) * 60000;
    timer.duration += ms;
    if (timer.state === 'running') timer.endsAt += ms; else timer.left += ms;
    timerChanged();
  } else if (cmd === 'add' && timer.state === 'ringing') startTimer(arg || 5);
  else if (cmd === 'stop') { timer = { state: 'idle', duration: 0, endsAt: 0, left: 0 }; timerChanged(); }
  return { ok: true, timer: timerView() };
});

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
      title: 'Напоминание: ' + eventName(e),
      body: (e.remind >= 1440 ? 'Завтра' : 'Сегодня') + ' в ' + e.from + (e.to ? '–' + e.to : '') + ', ' + remindLabel(e.remind) + (e.note ? '. ' + e.note : ''),
      icon: path.join(__dirname, 'assets', 'icon.png')
    });
    n.on('failed', (_e, err) => console.error('notification', err));
    if (!app.isPackaged) n.on('show', () => console.log('notification shown:', n.title));
    n.on('click', () => {
      const w = activeWin();
      if (!w || w.isDestroyed()) return;
      showWin(w);
      w.webContents.send('calendar-open', e.date);
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

/* «Скиллы» on the «Промты» page: instructions for assistants, a .md file or a .zip/.skill archive, kept as they were
   (storage.js addSkill). The description (5–6 sentences) and the type are written by one request to GPT-6.1 Sol
   with medium thinking (without a ChatGPT key, Claude Haiku); its price goes to the spending like any answer. */
const SKILL_PROMPT = [
  'Ты разбираешь скилл — набор инструкций для ИИ-ассистента (ChatGPT, Claude и других). Тебе дан список его файлов и текст главного файла.',
  'desc — описание для человека, который не программист: 5–6 простых предложений по-русски, одним абзацем, без разметки и без списков. Скажи, что это за скилл, для чего он нужен и когда его брать, как он работает (что делает ассистент по шагам) и что лежит внутри, если файлов несколько. Не выдумывай того, чего нет в файлах.',
  'type — для чего скилл: static — картинки (изображения, фото, иллюстрации, персонажи), video — видео (генерация, монтаж, клипы и визуальные сцены), audio — звук (музыка, голос, озвучка, подкасты, обработка аудио), text — тексты (статьи, книги, сценарии, диалоги, редактура, перевод), code — программирование и технические задачи (интерфейсы, сайты, автоматизация). Выбери основное назначение скилла; сценарий без видео относится к text, а сценарий ролика с кадрами и монтажом — к video. Если не подходит ни одно точно, выбери ближайшее по смыслу.'
].join('\n\n');
const SKILL_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['desc', 'type'],
  properties: { desc: { type: 'string' }, type: { type: 'string', enum: SKILL_TYPES } }
};
function skillModel() { return keys.openai ? modelById('gpt-6.1-sol') : keys.anthropic ? modelById('claude-haiku-5-5') : null; }
// What the model reads about a skill: the file, the list of files of an archive and the main Markdown text.
function skillInput(s) {
  const list = s.inside.slice(0, 150).map((f) => '- ' + f.path + ' (' + Math.max(1, Math.round(f.size / 1024)) + ' КБ)').join('\n');
  return 'Файл: ' + s.file.name + (s.file.kind !== 'md' ? ', архив, файлов: ' + s.files + (s.files > 150 ? ' (показаны первые 150)' : '') + '\n' + list : '') +
    '\n\n' + (s.text ? 'Главный файл' + (s.main ? ' (' + s.main + ')' : '') + ':\n' + s.text.slice(0, 60000) : 'Текстового файла .md в архиве нет.');
}
async function skillData(model, input, signal) {
  if (model.provider === 'openai') {
    const client = new OpenAI({ apiKey: keys.openai });
    const r = await client.responses.create({
      model: model.id, instructions: SKILL_PROMPT, input,
      reasoning: { effort: 'medium' }, max_output_tokens: 8000, store: false,
      text: { format: { type: 'json_schema', name: 'skill', strict: true, schema: SKILL_SCHEMA } }
    }, { signal });
    recordSpend(model, openaiUsage(r), signal);
    if (r.status === 'incomplete') throw userError('Ответ оборвался. Попробуйте ещё раз.');
    try { return JSON.parse(r.output_text || ''); } catch (e) { throw userError('Модель ответила не так, как нужно. Попробуйте ещё раз.'); }
  }
  const client = new Anthropic({ apiKey: keys.anthropic });
  const r = await client.beta.messages.create({
    model: model.id, max_tokens: 8000, messages: [{ role: 'user', content: input }],
    system: [{ type: 'text', text: SKILL_PROMPT, cache_control: { type: 'ephemeral' } }],
    tools: [{ name: 'save_skill', description: 'Сохраняет описание и тип скилла.', input_schema: SKILL_SCHEMA }],
    tool_choice: { type: 'tool', name: 'save_skill' }
  }, { signal });
  const u = r.usage || {};
  recordSpend(model, { input: u.input_tokens || 0, cached: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, output: u.output_tokens || 0 }, signal);
  const b = (r.content || []).find((x) => x.type === 'tool_use');
  if (!b) throw userError('Модель ответила не так, как нужно. Попробуйте ещё раз.');
  return b.input;
}
// keepType: the type stays as it is (the user chose it); otherwise the model's type is put on the skill.
async function describeSkill(id, keepType) {
  const s = store.findSkill(String(id || ''));
  if (!s) return { ok: false, error: 'Этого скилла уже нет.' };
  const model = skillModel();
  if (!model) return { ok: false, nokey: true, error: 'Чтобы описание написалось само, нужен ключ ChatGPT или Claude: «Настройки» → «API-ключи». Или напишите его сами.' };
  const controller = new AbortController();
  try {
    const d = await skillData(model, skillInput(s), controller.signal);
    const desc = String(d.desc || '').trim();
    if (!desc) throw userError('Модель не написала описание. Попробуйте ещё раз.');
    const cost = runCost.get(controller.signal) || 0;
    const fields = { id: s.id, desc, descBy: model.id, descCost: cost, descAt: Date.now() };
    if (!keepType && SKILL_TYPES.includes(d.type)) fields.type = d.type;
    await store.saveSkill(fields);
    return ok({ skillId: s.id, cost, info: info() });
  } catch (e) {
    if (e instanceof OpenAI.APIError || e instanceof Anthropic.APIError) console.error('skill', e.status, e.code || e.type);
    else if (!e.userMessage) console.error('skill', e);
    return { ok: false, error: e.userMessage || modelError(e) || 'Описание не получилось. Попробуйте ещё раз.' };
  }
}
const skillAllowed = new Set();   // only files the user picked or dropped can be added as skills
const skillDownloads = new Map(); // skill id -> where it was last saved, for «Показать в папке»
async function inspectSkill(file) {
  file = String(file || '');
  if (!skillKind(file)) return { ok: false, error: 'Скилл — это файл .md или архив .zip либо .skill.' };
  try {
    const r = await readSkillFile(file, path.basename(file));
    skillAllowed.add(file);
    return { ok: true, path: file, name: path.basename(file), size: r.size, kind: r.kind, files: r.files, main: r.main, title: skillTitle(r.text, path.basename(file), r.inside) };
  } catch (e) {
    if (e.userMessage) return { ok: false, error: e.userMessage };
    return { ok: false, error: 'Файл не открылся: возможно, его переместили или удалили.' };
  }
}
handle('skill-pick', async function () {
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(this.sender) || activeWin(), {
    title: 'Выберите скилл: файл .md или архив .zip либо .skill', properties: ['openFile'],
    filters: [{ name: 'Скиллы', extensions: ['md', 'markdown', 'zip', 'skill'] }]
  });
  if (r.canceled || !r.filePaths[0]) return { ok: true, canceled: true };
  return inspectSkill(r.filePaths[0]);
});
handle('skill-inspect', (file) => inspectSkill(file));
// o: { path (picked or dropped), title, type ('' — the assistant chooses), desc ('' — the assistant writes it) }
handle('skill-add', async (o) => {
  const file = String((o && o.path) || '');
  if (!skillAllowed.has(file)) return { ok: false, error: 'Выберите файл скилла ещё раз.' };
  const desc = String((o && o.desc) || '').trim();
  const skill = await store.addSkill({ path: file, title: o.title, type: o.type, desc, descBy: desc ? 'manual' : '' });
  return ok({ skillId: skill.id });
});
handle('skill-describe', (id, keepType) => describeSkill(id, !!keepType));
handle('skill-save', async (o) => {
  const s = o && typeof o === 'object' ? o : {};
  const fields = { id: String(s.id || '') };
  if (typeof s.title === 'string') fields.title = s.title;
  if (typeof s.type === 'string') fields.type = s.type;
  if (typeof s.desc === 'string') Object.assign(fields, { desc: s.desc, descBy: s.desc.trim() ? 'manual' : '', descCost: 0, descAt: Date.now() });
  const saved = await store.saveSkill(fields);
  if (!saved) return { ok: false, error: 'Этого скилла уже нет.' };
  return ok();
});
handle('skill-delete', async (id) => { await store.deleteSkill(String(id || '')); return ok(); });
// «Скачать»: the original .md or archive, exactly as it was added.
handle('skill-download', async function (id) {
  const s = store.findSkill(String(id || ''));
  const file = s && store.skillFilePath(s.id);
  if (!file || !fs.existsSync(file)) return { ok: false, error: 'Файла этого скилла нет в папке с данными.' };
  const ext = path.extname(s.file.name).slice(1) || 'md';
  const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(this.sender) || activeWin(), {
    title: 'Сохранить скилл «' + s.title + '»',
    defaultPath: path.join(app.getPath('downloads'), s.file.name),
    filters: [{ name: s.file.kind !== 'md' ? 'Архив скилла' : 'Скилл', extensions: [ext] }]
  });
  if (r.canceled || !r.filePath) return { ok: true, canceled: true };
  await fsp.copyFile(file, r.filePath);
  skillDownloads.set(s.id, r.filePath);
  return { ok: true, path: r.filePath };
});
handle('skill-reveal', async (id) => {
  const file = skillDownloads.get(String(id || ''));
  if (!file || !fs.existsSync(file)) return { ok: false, error: 'Файла уже нет на этом месте.' };
  shell.showItemInFolder(file);
  return { ok: true };
});
// A skill file for an LLM message (.md, .zip or .skill as it is, at most 20 MB), beside the pictures of the conversation.
handle('chat-file-save', async (chatId, name, bytes) => {
  if (!skillKind(String(name || ''))) return { ok: false, error: 'В LLM можно приложить картинки, а также скиллы: .md, .zip или .skill.' };
  if (!bytes || !(bytes.byteLength > 0) || bytes.byteLength > 20 * 1024 * 1024) return { ok: false, error: 'Этот файл больше 20 МБ.' };
  const file = await store.saveChatFile(chatId, name, bytes);
  return { ok: true, image: file };
});

// Makes the change a card describes. Returns what is needed to undo it.
async function applyAction(action) {
  if (action.kind === 'create-prompt') {
    const r = await store.savePrompt({ item: { title: action.title, type: action.category, text: action.text } });
    return { undo: { promptId: r.id }, extra: r };
  }
  if (action.kind === 'calendar-add') {
    const ev = await store.saveEvent(Object.assign({}, action.event, { id: undefined }));
    return { undo: { eventId: ev.id }, extra: { eventId: ev.id, date: ev.date } };
  }
  if (action.kind === 'calendar-update') {
    if (!store.findEvent(action.prev.id)) throw userError('Этого дела уже нет в календаре.');
    const ev = await store.saveEvent(Object.assign({}, action.event, { id: action.prev.id }));
    return { undo: { restore: action.prev }, extra: { date: ev.date } };
  }
  if (action.kind === 'calendar-delete') {
    const gone = await store.deleteEvent(action.event.id);
    if (!gone) throw userError('Этого дела уже нет в календаре.');
    return { undo: { restore: gone }, extra: { date: gone.date } };
  }
  if (action.kind === 'task-add') {
    const t = await store.saveTask(Object.assign({}, action.task, { id: undefined, order: undefined }));
    return { undo: { taskId: t.id }, extra: { taskId: t.id } };
  }
  if (action.kind === 'task-update') {
    if (!store.findTask(action.prevTask.id)) throw userError('Этой задачи уже нет на доске.');
    const t = await store.saveTask(Object.assign({ id: action.prevTask.id, title: action.task.title, status: action.task.status }, taskFields(action.task)));
    return { undo: { restoreTask: action.prevTask }, extra: { taskId: t.id } };
  }
  if (action.kind === 'task-delete') {
    const gone = await store.deleteTask(action.task.id);
    if (!gone) throw userError('Этой задачи уже нет на доске.');
    return { undo: { restoreTask: gone }, extra: {} };
  }
  if (action.kind === 'skill-add') {
    const file = chatFileOf(action.attachment);
    if (!file || !fs.existsSync(file)) throw userError('Файла скилла уже нет в разговоре.');
    const skill = await store.addSkill({ path: file, name: action.fileName, title: action.title, type: action.category, desc: action.text, descBy: action.model || 'manual' });
    return { undo: { skillId: skill.id }, extra: { skillId: skill.id } };
  }
  if (action.kind === 'skill-set-type') {
    const s = store.findSkill(action.skillId);
    if (!s) throw userError('Этого скилла уже нет.');
    if (s.updatedAt !== action.revision || s.type !== action.prevCategory) throw userError('Скилл изменился. Попросите ассистента перепроверить его ещё раз.');
    if (!SKILL_TYPES.includes(action.category)) throw userError('Такой категории скиллов нет.');
    const saved = await store.saveSkill({ id: s.id, type: action.category });
    return { undo: { skillType: { id: s.id, before: s.type, revision: saved.updatedAt } }, extra: { skillId: s.id } };
  }
  throw userError('Такое действие ассистент пока не умеет.');
}

// The user pressed "Создать"/"Добавить" (accept) or "Отмена" on a card the assistant suggested.
handle('assistant-decide', async (actionId, accept) => {
  const action = pending.get(actionId);
  if (!action) return { ok: false, error: 'Эта карточка устарела. Попросите ассистента ещё раз.' };
  pending.delete(actionId);
  if (!accept) return { ok: true };
  const r = await applyAction(action);
  return ok(r.extra);
});

// "Отменить" on a card that was applied at once (confirmations off).
handle('assistant-undo', async (actionId) => {
  const action = pending.get(actionId);
  if (!action || !action.undo) return { ok: false, error: 'Отменить уже нельзя: карточка устарела.' };
  pending.delete(actionId);
  const u = action.undo;
  if (u.promptId) await store.deletePrompt(u.promptId);
  if (u.eventId) await store.deleteEvent(u.eventId);
  if (u.restore) await store.saveEvent(u.restore);   // puts the old version back under the same id
  if (u.taskId) await store.deleteTask(u.taskId);
  if (u.restoreTask) await store.putTask(u.restoreTask);   // exactly as it was, not counted again
  if (u.skillId) await store.deleteSkill(u.skillId);
  if (u.skillType) {
    const s = store.findSkill(u.skillType.id);
    if (!s || s.updatedAt !== u.skillType.revision) throw userError('Скилл уже изменился. Верните прежнюю категорию вручную, если нужно.');
    await store.saveSkill({ id: s.id, type: u.skillType.before });
  }
  return ok({ date: u.restore ? u.restore.date : undefined });
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

// Off: the assistant makes calendar and prompt changes at once, and the card offers "Отменить".
// A dialog opened or closed in a window: darken the Windows buttons like the rest of the page.
handle('dim-controls', async function (on) {
  const w = BrowserWindow.fromWebContents(this.sender);
  if (!w || w.isDestroyed() || !IS_WIN) return {};
  if (on) dimmedWins.add(w); else dimmedWins.delete(w);
  try { w.setTitleBarOverlay(overlayColors(!!on)); } catch (e) { /* older Windows */ }
  return {};
});

handle('set-confirm', async (on) => {
  settings.confirm = !!on;
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
  app.on('second-instance', (_event, argv) => {
    if (!win) return;
    showWin(win);
    openArchiveFromOS(archiveFromArgs(argv));
  });

  // Windows ties the taskbar icon and notifications to this id through a Start Menu shortcut, and Electron
  // makes or repoints that shortcut to whatever exe shows a notification. A run from the sources gets its own id,
  // so it never takes over the installed program's shortcut (and its icon).
  if (IS_WIN) app.setAppUserModelId(app.isPackaged ? 'local.snowball.prompts' : 'local.snowball.prompts.dev');
  Menu.setApplicationMenu(null);

  app.whenReady().then(async () => {
    loadSettings();
    if (settings.theme === 'zaklex') { migrateTheme(settings); saveSettings(true); }
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
    pendingArchive = archiveFromArgs(process.argv);
    // The editor window gets "macos:<accent>" for the macOS theme (src/screenshots.js splits it).
    captures = setupScreenshots({ dir: () => store.dir, main: () => (win && !win.isDestroyed() ? win : null), theme: () => (currentTheme() === 'macos' ? 'macos:' + macAccent() : currentTheme()), key: () => settings.captureShortcut,
      initialized: () => !!settings.captureShortcutInitialized,
      saveKey: key => { settings.captureShortcut = key; settings.captureShortcutInitialized = true; saveSettings(true); },
      record: async () => { await store.recordScreenshot(); broadcast('sync', { activity: store.activityView() }); } });
    createWindow();
    setupUpdates();
    setTimeout(autoArchiveTasks, 5000);
    setInterval(autoArchiveTasks, 5 * 60 * 1000);
    setInterval(checkReminders, 20 * 1000);
    setTimeout(checkReminders, 3000);
    restoreTimer();
  });

  app.on('before-quit', () => saveSettings(true));
  app.on('window-all-closed', () => { saveSettings(true); app.quit(); });
}
