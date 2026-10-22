'use strict';
// Data folder layout:
//   <dir>/prompts.json          — all prompts (readable in any text editor)
//   <dir>/prompts.backup.json   — the previous version, refreshed on every save
//   <dir>/Файлы/<promptId>/...  — files attached to each prompt
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
    this.queue = Promise.resolve();
  }

  get dataPath() { return path.join(this.dir, DATA_FILE); }
  get backupPath() { return path.join(this.dir, BACKUP_FILE); }
  get filesRoot() { return path.join(this.dir, FILES_DIR); }
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
      id: p.id, title: p.title, type: p.type, text: p.text, createdAt: p.createdAt, updatedAt: p.updatedAt,
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
      if (!prompt) {
        prompt = normalizePrompt({ id: item.id, createdAt: now, updatedAt: now });
        if (this.find(prompt.id)) prompt.id = newId('p');
        this.data.prompts.push(prompt);
      }
      prompt.title = str(item.title, 300).trim();
      prompt.type = str(item.type, 60).trim();
      prompt.text = str(item.text, 2000000);
      prompt.updatedAt = now;
      await this.removeFiles(prompt, input && input.removeFileIds);
      await this.copyIn(prompt, input && input.addFiles, errors);
      await this.write();
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
      if (prompt.files.length !== before) { prompt.updatedAt = Date.now(); await this.write(); }
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
        id: p.id, title: p.title, type: p.type, text: p.text, createdAt: p.createdAt, updatedAt: p.updatedAt,
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

// Copies the data (prompts.json and the files folder) into another folder.
async function copyDataTo(fromDir, toDir) {
  await fsp.mkdir(toDir, { recursive: true });
  await fsp.copyFile(path.join(fromDir, DATA_FILE), path.join(toDir, DATA_FILE));
  const files = path.join(fromDir, FILES_DIR);
  if (await exists(files)) await fsp.cp(files, path.join(toDir, FILES_DIR), { recursive: true, force: false, errorOnExist: false });
}

async function hasData(dir) { return exists(path.join(dir, DATA_FILE)); }

module.exports = { Store, copyDataTo, hasData, sanitizeName, kindOf, parseData, DATA_FILE, FILES_DIR };
