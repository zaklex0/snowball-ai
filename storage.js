'use strict';
// Data folder layout:
//   <dir>/prompts.json          — all prompts (readable in any text editor)
//   <dir>/prompts.backup.json   — the previous version, refreshed on every save
//   <dir>/Файлы/<promptId>/...  — files attached to each prompt
//   <dir>/profile.json          — nickname and whether the welcome screen was shown
//   <dir>/avatar.png            — the avatar, already cropped to a square
//   <dir>/activity.json         — actions per day for the statistics page
//   <dir>/chats.json            — the assistant's conversations
// This module only uses Node's fs/path, so it can be tested without Electron.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const FORMAT = 'snowball';
const DATA_FILE = 'prompts.json';
const BACKUP_FILE = 'prompts.backup.json';
const FILES_DIR = 'Файлы';
const PROFILE_FILE = 'profile.json';
const AVATAR_FILE = 'avatar.png';
const ACTIVITY_FILE = 'activity.json';
const CHATS_FILE = 'chats.json';
// What counts as an action on the statistics page. Deleting and importing do not count.
const ACTIONS = ['created', 'edited', 'files', 'copied'];
const NAME_MAX = 32;

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif', '.svg', '.ico']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.m4v', '.ogv', '.mkv']);
const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac', '.opus']);

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function newId(prefix) {
  return (prefix || 'p') + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

function kindOf(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  return 'file';
}

// A file name that is valid on Windows, keeps the extension and stays readable.
function sanitizeName(name) {
  let base = path.basename(String(name || '').replace(/\\/g, '/'));
  base = base.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').replace(/[. ]+$/g, '').trim();
  if (!base || base === '.' || base === '..') base = 'файл';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(base)) base = '_' + base;
  if (base.length > 120) {
    const ext = path.extname(base).slice(0, 16);
    base = base.slice(0, 120 - ext.length) + ext;
  }
  return base;
}

function str(v, max) {
  const s = typeof v === 'string' ? v : (v === undefined || v === null ? '' : String(v));
  return max ? s.slice(0, max) : s;
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function normalizeFile(f) {
  if (!f || typeof f !== 'object') return null;
  const stored = str(f.stored);
  if (!stored || path.basename(stored) !== stored || stored === '.' || stored === '..') return null;
  return {
    id: ID_RE.test(str(f.id)) ? f.id : newId('f'),
    name: str(f.name, 300) || stored,
    stored,
    size: num(f.size),
    kind: kindOf(stored),
    addedAt: num(f.addedAt)
  };
}

function normalizePrompt(p, fallbackTime) {
  if (!p || typeof p !== 'object') return null;
  const now = fallbackTime || Date.now();
  return {
    id: ID_RE.test(str(p.id)) ? p.id : newId('p'),
    title: str(p.title, 300).trim(),
    type: str(p.type, 60).trim(),
    text: str(p.text, 2000000),
    comment: str(p.comment, 100000),
    createdAt: num(p.createdAt) || now,
    updatedAt: num(p.updatedAt) || num(p.createdAt) || now,
    files: Array.isArray(p.files) ? p.files.map(normalizeFile).filter(Boolean) : []
  };
}

function parseData(raw) {
  const parsed = JSON.parse(String(raw).replace(/^﻿/, ''));
  const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.prompts) ? parsed.prompts : null);
  if (!list) throw new Error('В файле нет списка промтов');
  const seen = new Set();
  const prompts = [];
  list.forEach((p) => {
    const n = normalizePrompt(p);
    if (!n) return;
    while (seen.has(n.id)) n.id = newId('p');
    seen.add(n.id);
    prompts.push(n);
  });
  return { format: FORMAT, version: 1, updatedAt: num(parsed && parsed.updatedAt), prompts };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function exists(p) {
  try { await fsp.access(p); return true; } catch (e) { return false; }
}

// Windows sometimes holds a file for a moment (antivirus, cloud sync). Retry briefly.
async function retry(fn) {
  let last;
  for (let i = 0; i < 6; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e && e.code)) throw e;
      await sleep(80 * (i + 1));
    }
  }
  throw last;
}

// Local calendar day, so an action at 23:50 lands on the day the user saw it.
function dayKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function readJson(file) {
  try { return JSON.parse(String(await fsp.readFile(file, 'utf8')).replace(/^﻿/, '')); } catch (e) { return null; }
}
async function writeJson(file, value) {
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  try { await retry(() => fsp.rename(tmp, file)); } catch (e) {
    await retry(() => fsp.writeFile(file, JSON.stringify(value, null, 2), 'utf8'));
    await fsp.rm(tmp, { force: true });
  }
}

function normalizeProfile(p) {
  p = p && typeof p === 'object' ? p : {};
  return { name: str(p.name, NAME_MAX).trim(), welcomed: !!p.welcomed, avatarAt: num(p.avatarAt) };
}
function normalizeActivity(a) {
  const days = {};
  const src = a && typeof a === 'object' && a.days && typeof a.days === 'object' ? a.days : {};
  Object.keys(src).forEach((k) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !src[k] || typeof src[k] !== 'object') return;
    const day = {};
    ACTIONS.forEach((n) => { const v = Math.max(0, Math.round(num(src[k][n]))); if (v) day[n] = v; });
    if (Object.keys(day).length) days[k] = day;
  });
  return { format: 'snowball-activity', version: 1, since: num(a && a.since), days };
}

// A suggested change in a chat ("Создать промт …?") and what the user answered.
const ACTION_STATUSES = ['done', 'canceled', 'stale'];
function normalizeAction(a) {
  if (!a || typeof a !== 'object') return null;
  return {
    id: str(a.id, 64), kind: str(a.kind, 40), title: str(a.title, 300), category: str(a.category, 60), text: str(a.text, 200000),
    // A card nobody answered cannot be answered after a restart: main.js has forgotten it.
    status: ACTION_STATUSES.includes(a.status) ? a.status : 'stale'
  };
}
function normalizeChat(c) {
  if (!c || typeof c !== 'object' || !ID_RE.test(str(c.id))) return null;
  const messages = (Array.isArray(c.messages) ? c.messages : []).map((m) => {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return null;
    const out = { role: m.role, text: str(m.text, 200000) };
    if (m.note) out.note = str(m.note, 500);
    if (m.failed) out.failed = true;
    const actions = Array.isArray(m.actions) ? m.actions.map(normalizeAction).filter(Boolean) : [];
    if (actions.length) out.actions = actions;
    return out;
  }).filter(Boolean);
  if (!messages.length) return null;
  const now = Date.now();
  return { id: c.id, title: str(c.title, 120).trim() || 'Без названия', createdAt: num(c.createdAt) || now, updatedAt: num(c.updatedAt) || now, messages };
}

async function uniqueTarget(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let i = 2; await exists(path.join(dir, candidate)); i++) candidate = `${stem} (${i})${ext}`;
  return candidate;
}

class Store {
  constructor(dir, opts) {
    this.dir = dir;
    this.trash = (opts && opts.trash) || ((p) => fsp.rm(p, { recursive: true, force: true }));
    this.data = null;
    this.mtimeMs = 0;
    this.notice = null;      // 'created' | 'restored' | 'reset'
    this.profile = normalizeProfile(null);
    this.activity = normalizeActivity(null);
    this.chats = [];
    this.queue = Promise.resolve();
  }

  get dataPath() { return path.join(this.dir, DATA_FILE); }
  get backupPath() { return path.join(this.dir, BACKUP_FILE); }
  get filesRoot() { return path.join(this.dir, FILES_DIR); }
  get profilePath() { return path.join(this.dir, PROFILE_FILE); }
  get avatarPath() { return path.join(this.dir, AVATAR_FILE); }
  get activityPath() { return path.join(this.dir, ACTIVITY_FILE); }
  get chatsPath() { return path.join(this.dir, CHATS_FILE); }
  promptDir(id) {
    if (!ID_RE.test(id)) throw new Error('bad id');
    return path.join(this.filesRoot, id);
  }

  // Runs mutations one at a time so two quick clicks never interleave writes.
  run(fn) {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  async init(seed) {
    await this.initData(seed);
    await this.loadExtras();
    return this;
  }

  // Profile and statistics live beside prompts.json and never block opening the prompts.
  async loadExtras() {
    this.profile = normalizeProfile(await readJson(this.profilePath));
    const chats = await readJson(this.chatsPath);
    this.chats = chats && Array.isArray(chats.chats) ? chats.chats.map(normalizeChat).filter(Boolean) : [];
    const raw = await readJson(this.activityPath);
    if (raw) { this.activity = normalizeActivity(raw); return; }
    this.activity = this.backfillActivity();
    try { await writeJson(this.activityPath, this.activity); } catch (e) { /* statistics are a convenience */ }
  }

  // First start with statistics: rebuild what the prompts remember (creation, last edit, attached files).
  backfillActivity() {
    const a = normalizeActivity(null);
    let since = Date.now();
    const add = (t, kind, n) => {
      if (!t) return;
      const day = a.days[dayKey(t)] || (a.days[dayKey(t)] = {});
      day[kind] = (day[kind] || 0) + (n || 1);
    };
    this.data.prompts.forEach((p) => {
      since = Math.min(since, p.createdAt || since);
      add(p.createdAt, 'created');
      if (p.updatedAt - p.createdAt > 60 * 1000) add(p.updatedAt, 'edited');
      p.files.forEach((f) => add(f.addedAt, 'files'));
    });
    a.since = since;
    return a;
  }

  // Called from inside run(), so it must not queue itself.
  async bump(kind, n) {
    if (!ACTIONS.includes(kind) || !(n > 0)) return;
    const key = dayKey(Date.now());
    const day = this.activity.days[key] || (this.activity.days[key] = {});
    day[kind] = (day[kind] || 0) + n;
    if (!this.activity.since) this.activity.since = Date.now();
    try { await writeJson(this.activityPath, this.activity); } catch (e) { /* statistics are a convenience */ }
  }

  recordCopy() { return this.run(() => this.bump('copied', 1)); }

  activityView() { return { since: this.activity.since, days: this.activity.days }; }

  profileView() {
    const p = this.profile;
    const avatar = p.avatarAt && fs.existsSync(this.avatarPath) ? pathToFileURL(this.avatarPath).href + '?v=' + p.avatarAt : null;
    return { name: p.name, welcomed: p.welcomed, avatar };
  }

  // input: { name?, avatar?: PNG Buffer | null (remove) | undefined (keep) }
  saveProfile(input) {
    return this.run(async () => {
      const p = this.profile;
      if (input && typeof input.name === 'string') p.name = str(input.name, NAME_MAX).trim();
      if (input && input.avatar === null && p.avatarAt) {
        if (await exists(this.avatarPath)) { try { await this.trash(this.avatarPath); } catch (e) { await fsp.rm(this.avatarPath, { force: true }); } }
        p.avatarAt = 0;
      } else if (input && Buffer.isBuffer(input.avatar)) {
        await retry(() => fsp.writeFile(this.avatarPath, input.avatar));
        p.avatarAt = Date.now();
      }
      p.welcomed = true;
      await writeJson(this.profilePath, p);
    });
  }

  /* ---------- assistant chats ---------- */
  // Newest first, without the messages: enough for the history list.
  chatList() {
    return this.chats.slice().sort((a, b) => b.updatedAt - a.updatedAt)
      .map((c) => ({ id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt }));
  }
  getChat(id) { return this.chats.find((c) => c.id === id) || null; }
  writeChats() { return writeJson(this.chatsPath, { format: 'snowball-chats', version: 1, chats: this.chats }); }

  // Replaces the whole conversation: the window holds it and sends it after every finished message.
  saveChat(input) {
    return this.run(async () => {
      const prev = this.getChat(input && input.id);
      const chat = normalizeChat(Object.assign({}, input, { createdAt: prev ? prev.createdAt : Date.now(), updatedAt: Date.now() }));
      if (!chat) return null;
      if (prev) this.chats[this.chats.indexOf(prev)] = chat; else this.chats.push(chat);
      await this.writeChats();
      return chat;
    });
  }

  deleteChat(id) {
    return this.run(async () => {
      const before = this.chats.length;
      this.chats = this.chats.filter((c) => c.id !== id);
      if (this.chats.length !== before) await this.writeChats();
    });
  }

  async initData(seed) {
    await fsp.mkdir(this.dir, { recursive: true });
    let raw = null;
    try { raw = await fsp.readFile(this.dataPath, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (raw === null) {
      const prompts = (typeof seed === 'function' ? seed() : []).map((p) => normalizePrompt(p)).filter(Boolean);
      this.data = { format: FORMAT, version: 1, updatedAt: 0, prompts };
      this.notice = 'created';
      await this.write({ skipBackup: true });
      return this;
    }
    try {
      this.data = parseData(raw);
    } catch (e) {
      const broken = path.join(this.dir, `prompts.broken-${Date.now()}.json`);
      await retry(() => fsp.copyFile(this.dataPath, broken));
      let restored = null;
      try { restored = parseData(await fsp.readFile(this.backupPath, 'utf8')); } catch (e2) { restored = null; }
      this.data = restored || { format: FORMAT, version: 1, updatedAt: 0, prompts: [] };
      this.notice = restored ? 'restored' : 'reset';
      this.brokenCopy = broken;
      await this.write({ skipBackup: true });
      return this;
    }
    await this.stat();
    return this;
  }

  async stat() {
    try { this.mtimeMs = (await fsp.stat(this.dataPath)).mtimeMs; } catch (e) { this.mtimeMs = 0; }
  }

  async write(opts) {
    this.data.updatedAt = Date.now();
    const json = JSON.stringify(this.data, null, 2);
    const tmp = this.dataPath + '.tmp';
    await fsp.writeFile(tmp, json, 'utf8');
    if (!(opts && opts.skipBackup)) {
      try { await retry(() => fsp.copyFile(this.dataPath, this.backupPath)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    try {
      await retry(() => fsp.rename(tmp, this.dataPath));
    } catch (e) {
      await retry(() => fsp.writeFile(this.dataPath, json, 'utf8'));
      await fsp.rm(tmp, { force: true });
    }
    await this.stat();
  }

  // Picks up edits made outside the app (another computer via a synced folder, a text editor).
  async reloadIfChanged() {
    return this.run(async () => {
      let st;
      try { st = await fsp.stat(this.dataPath); } catch (e) { return false; }
      if (Math.abs(st.mtimeMs - this.mtimeMs) < 1) return false;
      try {
        this.data = parseData(await fsp.readFile(this.dataPath, 'utf8'));
        this.mtimeMs = st.mtimeMs;
        return true;
      } catch (e) {
        return false; // half-written by a sync client; try again next time
      }
    });
  }

  find(id) { return this.data.prompts.find((p) => p.id === id) || null; }

  filePath(promptId, fileId) {
    const p = this.find(promptId);
    const f = p && p.files.find((x) => x.id === fileId);
    if (!f) return null;
    return path.join(this.promptDir(p.id), f.stored);
  }

  view() {
    return this.data.prompts.map((p) => ({
      id: p.id, title: p.title, type: p.type, text: p.text, comment: p.comment, createdAt: p.createdAt, updatedAt: p.updatedAt,
      files: p.files.map((f) => {
        const abs = path.join(this.promptDir(p.id), f.stored);
        return { id: f.id, name: f.name, size: f.size, kind: f.kind, addedAt: f.addedAt, url: pathToFileURL(abs).href };
      })
    }));
  }

  async copyIn(prompt, sources, errors) {
    if (!sources || !sources.length) return;
    const dir = this.promptDir(prompt.id);
    await fsp.mkdir(dir, { recursive: true });
    for (const src of sources) {
      try {
        let name;
        let size = 0;
        if (src && typeof src.path === 'string' && src.path) {
          const st = await fsp.stat(src.path);
          if (!st.isFile()) throw new Error('not a file');
          name = sanitizeName(src.name || path.basename(src.path));
          const stored = await uniqueTarget(dir, name);
          await fsp.copyFile(src.path, path.join(dir, stored));
          size = st.size;
          name = stored;
        } else if (src && src.data) {
          const buf = Buffer.from(src.data.buffer ? new Uint8Array(src.data.buffer, src.data.byteOffset || 0, src.data.byteLength) : src.data);
          name = sanitizeName(src.name || 'картинка.png');
          const stored = await uniqueTarget(dir, name);
          await fsp.writeFile(path.join(dir, stored), buf);
          size = buf.length;
          name = stored;
        } else {
          throw new Error('empty source');
        }
        prompt.files.push({ id: newId('f'), name, stored: name, size, kind: kindOf(name), addedAt: Date.now() });
      } catch (e) {
        errors.push((src && (src.name || (src.path && path.basename(src.path)))) || 'файл');
      }
    }
  }

  async removeFiles(prompt, fileIds) {
    if (!fileIds || !fileIds.length) return;
    const ids = new Set(fileIds);
    const keep = [];
    for (const f of prompt.files) {
      if (!ids.has(f.id)) { keep.push(f); continue; }
      const abs = path.join(this.promptDir(prompt.id), f.stored);
      if (await exists(abs)) { try { await this.trash(abs); } catch (e) { await fsp.rm(abs, { force: true }); } }
    }
    prompt.files = keep;
  }

  savePrompt(input) {
    return this.run(async () => {
      const item = (input && input.item) || {};
      const errors = [];
      let prompt = item.id ? this.find(item.id) : null;
      const now = Date.now();
      const isNew = !prompt;
      if (!prompt) {
        prompt = normalizePrompt({ id: item.id, createdAt: now, updatedAt: now });
        if (this.find(prompt.id)) prompt.id = newId('p');
        this.data.prompts.push(prompt);
      }
      const sig = () => JSON.stringify([prompt.title, prompt.type, prompt.text, prompt.comment, prompt.files.map((f) => f.id)]);
      const before = sig();
      prompt.title = str(item.title, 300).trim();
      prompt.type = str(item.type, 60).trim();
      prompt.text = str(item.text, 2000000);
      prompt.comment = str(item.comment, 100000);
      await this.removeFiles(prompt, input && input.removeFileIds);
      const kept = prompt.files.length;
      await this.copyIn(prompt, input && input.addFiles, errors);
      // "Сохранить" without real changes keeps the date and does not count as an edit.
      const changed = isNew || before !== sig();
      if (!changed) return { id: prompt.id, errors };
      prompt.updatedAt = now;
      await this.write();
      await this.bump(isNew ? 'created' : 'edited', 1);
      await this.bump('files', prompt.files.length - kept);
      return { id: prompt.id, errors };
    });
  }

  addFiles(promptId, sources) {
    return this.run(async () => {
      const prompt = this.find(promptId);
      if (!prompt) throw new Error('Промт не найден');
      const errors = [];
      const before = prompt.files.length;
      await this.copyIn(prompt, sources, errors);
      if (prompt.files.length !== before) {
        prompt.updatedAt = Date.now();
        await this.write();
        await this.bump('files', prompt.files.length - before);
      }
      return { added: prompt.files.length - before, errors };
    });
  }

  removeFile(promptId, fileId) {
    return this.run(async () => {
      const prompt = this.find(promptId);
      if (!prompt) return;
      await this.removeFiles(prompt, [fileId]);
      prompt.updatedAt = Date.now();
      await this.write();
    });
  }

  deletePrompt(id) {
    return this.run(async () => {
      const prompt = this.find(id);
      if (!prompt) return;
      this.data.prompts = this.data.prompts.filter((p) => p.id !== id);
      await this.write();
      const dir = this.promptDir(id);
      if (await exists(dir)) { try { await this.trash(dir); } catch (e) { /* the record is gone; leftover files are harmless */ } }
    });
  }

  exportJson() {
    return JSON.stringify({
      format: FORMAT,
      version: 1,
      exportedAt: new Date().toISOString(),
      prompts: this.data.prompts.map((p) => ({
        id: p.id, title: p.title, type: p.type, text: p.text, comment: p.comment, createdAt: p.createdAt, updatedAt: p.updatedAt,
        files: p.files.map((f) => f.name)
      }))
    }, null, 2);
  }

  importJson(raw) {
    return this.run(async () => {
      const incoming = parseData(raw).prompts;
      let added = 0;
      let skipped = 0;
      const sig = (p) => p.title.trim().toLowerCase() + '\u0000' + p.text.trim();
      const known = new Set(this.data.prompts.map(sig));
      const ids = new Set(this.data.prompts.map((p) => p.id));
      for (const p of incoming) {
        if (!p.title && !p.text) { skipped++; continue; }
        if (ids.has(p.id) || known.has(sig(p))) { skipped++; continue; }
        p.files = []; // attachments are not part of an export file
        this.data.prompts.push(p);
        ids.add(p.id);
        known.add(sig(p));
        added++;
      }
      if (added) await this.write();
      return { added, skipped };
    });
  }
}

// Copies the data (prompts.json, profile, statistics, chats and the files folder) into another folder.
async function copyDataTo(fromDir, toDir) {
  await fsp.mkdir(toDir, { recursive: true });
  await fsp.copyFile(path.join(fromDir, DATA_FILE), path.join(toDir, DATA_FILE));
  for (const name of [PROFILE_FILE, AVATAR_FILE, ACTIVITY_FILE, CHATS_FILE]) {
    if (await exists(path.join(fromDir, name))) await fsp.copyFile(path.join(fromDir, name), path.join(toDir, name));
  }
  const files = path.join(fromDir, FILES_DIR);
  if (await exists(files)) await fsp.cp(files, path.join(toDir, FILES_DIR), { recursive: true, force: false, errorOnExist: false });
}

async function hasData(dir) { return exists(path.join(dir, DATA_FILE)); }

module.exports = { Store, copyDataTo, hasData, sanitizeName, kindOf, parseData, dayKey, DATA_FILE, FILES_DIR, NAME_MAX };
