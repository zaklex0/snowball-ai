'use strict';
// Data folder layout:
//   <dir>/prompts.json          — all prompts (readable in any text editor)
//   <dir>/prompts.backup.json   — the previous version, refreshed on every save
//   <dir>/Файлы/<promptId>/...  — files attached to each prompt
//   <dir>/profile.json          — nickname and whether the welcome screen was shown
//   <dir>/avatar-<id>.png      — the current avatar (legacy profiles use avatar.png)
//   <dir>/activity.json         — actions per day for the statistics page
//   <dir>/chats.json            — the assistant's conversations
//   <dir>/Файлы чатов/<chatId>/ — pictures attached to messages in LLM conversations
//   <dir>/calendar.json         — things planned in the calendar
//   <dir>/tasks.json            — the tasks board: to do, in progress, done
//   <dir>/Транскрибации/<id>.json — text and timings of an audio or video file (the file itself is not copied)
// This module only uses Node's fs/path, so it can be tested without Electron.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { numberedTasks } = require('./src/task-board-model');
const { pathToFileURL } = require('url');
const { pipeline } = require('stream/promises');
const { readZipIndex } = require('./archive');

const FORMAT = 'snowball';
const DATA_FILE = 'prompts.json';
const BACKUP_FILE = 'prompts.backup.json';
const FILES_DIR = 'Файлы';
const CHAT_FILES_DIR = 'Файлы чатов';
const CHAT_IMAGES_MAX = 6;   // pictures in one message
const PROFILE_FILE = 'profile.json';
const AVATAR_FILE = 'avatar.png';
const AVATAR_NAME_RE = /^avatar-[a-f0-9]{24}\.png$/;
const ACTIVITY_FILE = 'activity.json';
const CHATS_FILE = 'chats.json';
const CALENDAR_FILE = 'calendar.json';
const TASKS_FILE = 'tasks.json';
const TRANSCRIPTS_DIR = 'Транскрибации';
const SKILLS_FILE = 'skills.json';
const SKILLS_DIR = 'Скиллы';
// What counts as an action on the statistics page. Deleting and importing do not count.
// calendar: a new or changed event; assistant: a message sent to the assistant;
// tasks: a new task, one moved to another column, a new subtask or a subtask ticked off;
// transcribe: a file turned into text, its short summary, its text or timings copied, subtitles or text saved to a file;
// skills: a new skill on the «Скиллы» page.
const ACTIONS = ['created', 'edited', 'files', 'copied', 'calendar', 'assistant', 'tasks', 'transcribe', 'screenshots', 'skills'];
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

// Fixed attachment names in a backup may already exist in an orphaned folder. Never overwrite them.
async function copyImportedFixed(from, to) {
  try { await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL); return; }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
  // Never follow an existing destination symlink while deciding whether it is safe to reuse.
  const [a, b] = await Promise.all([fsp.stat(from), fsp.lstat(to)]);
  if (a.isFile() && b.isFile() && a.size === b.size) {
    const digest = async (file) => {
      const hash = crypto.createHash('sha256');
      for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
      return hash.digest('hex');
    };
    if ((await digest(from)) === (await digest(to))) return;
  }
  const e = new Error('import attachment already exists');
  e.userMessage = 'Не удалось восстановить вложение: в папке данных уже есть другой файл с таким именем. Существующий файл сохранён. Обратитесь за помощью, чтобы восстановить копию.';
  throw e;
}

// Local calendar day, so an action at 23:50 lands on the day the user saw it.
function dayKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function readJson(file) {
  try { return JSON.parse(String(await fsp.readFile(file, 'utf8')).replace(/^﻿/, '')); } catch (e) { return null; }
}
async function readArchiveList(file, field) {
  let raw;
  try { raw = await fsp.readFile(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  try {
    const value = JSON.parse(raw.replace(/^\uFEFF/, ''));
    if (value && Array.isArray(value[field])) return value;
  } catch (e) { /* report a damaged section below */ }
  const e = new Error('invalid archive list');
  e.userMessage = 'Не удалось прочитать раздел «' + path.basename(file) + '» в архиве. Проверьте, что файл копии не повреждён.';
  throw e;
}
async function readArchiveObject(file) {
  let raw;
  try { raw = await fsp.readFile(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  try {
    const value = JSON.parse(raw.replace(/^\uFEFF/, ''));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch (e) { /* report a damaged section below */ }
  const e = new Error('invalid archive profile');
  e.userMessage = 'Не удалось прочитать профиль в архиве. Проверьте, что файл копии не повреждён.';
  throw e;
}
function missingArchiveAttachment() {
  const e = new Error('missing archive attachment');
  e.userMessage = 'В архиве отсутствует один из файлов вложений. Проверьте, что файл копии не повреждён.';
  return e;
}
async function writeJson(file, value) {
  const tmp = file + '.tmp';
  try {
    await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
    await retry(() => fsp.rename(tmp, file));
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

// Keep a separately readable copy of the latest successful save for important lists.
const extraBackupPath = (file) => file.replace(/\.json$/i, '.backup.json');
async function copyBackup(file, backup) {
  const tmp = backup + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  try {
    await retry(() => fsp.copyFile(file, tmp));
    await retry(() => fsp.rename(tmp, backup));
  } finally { await fsp.rm(tmp, { force: true }).catch(() => {}); }
}
async function writeProtectedJson(file, value) {
  await writeJson(file, value);
  try { await copyBackup(file, extraBackupPath(file)); return true; }
  catch (e) { console.error('Could not update data backup', path.basename(file), e.code); return false; }
}
async function readProtectedJson(file, valid, warnings) {
  let raw;
  try { raw = await fsp.readFile(file, 'utf8'); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    const backup = await readJson(extraBackupPath(file));
    if (!valid(backup)) return null;
    await writeJson(file, backup);
    warnings.push({ file: path.basename(file), restored: true, missing: true });
    return backup;
  }
  let value;
  try { value = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch (e) { value = null; }
  if (valid(value)) {
    const backup = extraBackupPath(file);
    if (!(await exists(backup))) {
      try { await copyBackup(file, backup); }
      catch (e) { console.error('Could not create data backup', path.basename(file), e.code); }
    }
    return value;
  }
  // Preserve the original even when there is no usable backup. Never confuse an I/O error with damaged JSON.
  const broken = file.replace(/\.json$/i, `.broken-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.json`);
  await retry(() => fsp.copyFile(file, broken));
  const backup = await readJson(extraBackupPath(file));
  const restored = valid(backup);
  if (restored) await writeJson(file, backup);
  warnings.push({ file: path.basename(file), restored, broken: path.basename(broken) });
  return restored ? backup : null;
}

function normalizeProfile(p) {
  p = p && typeof p === 'object' ? p : {};
  return { name: str(p.name, NAME_MAX).trim(), welcomed: !!p.welcomed, avatarAt: num(p.avatarAt),
    avatarFile: AVATAR_NAME_RE.test(str(p.avatarFile)) ? p.avatarFile : '' };
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

// One thing in the calendar. date is the local day, from/to are "HH:MM" (to may be empty),
// remind is minutes before the start (0 = no reminder).
const EVENT_KINDS = ['task', 'meet', 'call', 'shoot', 'edit'];
const REMINDS = [0, 15, 30, 60, 1440];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
// The summary of a call that happened (loaded by the user, structured by an assistant): short text, decisions,
// next steps (a step may become a task: `added` is the task id), meetings agreed on (a meeting may become an event:
// `added` is the event id) and the full text it was made from.
function normalizeRecap(r) {
  if (!r || typeof r !== 'object') return null;
  const list = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
  const itemId = (x) => (ID_RE.test(str(x && x.id)) ? x.id : newId('r'));
  return {
    brief: str(r.brief, 3000).trim(),
    decisions: list(r.decisions, 30).map((x) => str(x, 500).trim()).filter(Boolean),
    steps: list(r.steps, 40).map((s) => {
      const t = s && typeof s === 'object' ? str(s.t, 500).trim() : '';
      return t ? { id: itemId(s), t, who: str(s.who, 100).trim(), mine: !!s.mine, due: DATE_RE.test(str(s.due)) ? s.due : '', added: ID_RE.test(str(s.added)) ? s.added : '' } : null;
    }).filter(Boolean),
    meets: list(r.meets, 20).map((m) => {
      const t = m && typeof m === 'object' ? str(m.t, 300).trim() : '';
      const from = TIME_RE.test(str(m && m.from)) ? m.from : '';
      return t ? { id: itemId(m), t, date: DATE_RE.test(str(m.date)) ? m.date : '', from, to: from && TIME_RE.test(str(m.to)) && m.to > from ? m.to : '', added: ID_RE.test(str(m.added)) ? m.added : '' } : null;
    }).filter(Boolean),
    source: str(r.source, 200).trim(),
    text: str(r.text, 400000),
    cost: num(r.cost),
    madeAt: num(r.madeAt) || Date.now()
  };
}
function recapRevision(recap) {
  return recap ? crypto.createHash('sha256').update(JSON.stringify(recap)).digest('hex') : 'none';
}
function normalizeEvent(e, fallbackTime) {
  if (!e || typeof e !== 'object' || !DATE_RE.test(str(e.date))) return null;
  const now = fallbackTime || Date.now();
  const from = TIME_RE.test(str(e.from)) ? e.from : '09:00';
  const to = TIME_RE.test(str(e.to)) && e.to > from ? e.to : '';
  const remind = REMINDS.includes(Number(e.remind)) ? Number(e.remind) : 0;
  return {
    id: ID_RE.test(str(e.id)) ? e.id : newId('e'),
    date: e.date, from, to,
    who: str(e.who, 200).trim(),
    title: str(e.title, 300).trim() || 'Без названия',
    kind: EVENT_KINDS.includes(e.kind) ? e.kind : 'task',
    note: str(e.note, 5000).trim(),
    remind,
    recap: normalizeRecap(e.recap),
    createdAt: num(e.createdAt) || now,
    updatedAt: num(e.updatedAt) || num(e.createdAt) || now
  };
}

// One card on the tasks board. status is its column: todo — «Предстоит», doing — «В процессе», done — «Готово».
// order keeps the place inside the column (smaller is higher). due is the day (YYYY-MM-DD or empty), time is "HH:MM"
// (only with a day), priority: 0 — обычная, 1 — важная, 2 — срочная. doneFrom: the column it came from into «Готово»,
// so taking the tick off puts it back there. Tasks from older versions get the new fields empty.
const TASK_STATUSES = ['todo', 'doing', 'done'];
// Columns of the user's own sit between «В процессе» and «Готово». Their ids start with "col"; color is one of six (0–5).
const BASE_COLUMNS = [{ id: 'todo', name: 'Предстоит' }, { id: 'doing', name: 'В процессе' }, { id: 'done', name: 'Готово' }];
const COLUMN_ID = /^col[A-Za-z0-9_-]{1,40}$/;
const COLUMN_MAX = 8;
const isTaskStatus = (s) => TASK_STATUSES.includes(s) || COLUMN_ID.test(str(s));
function normalizeColumn(c) {
  if (!c || typeof c !== 'object' || !COLUMN_ID.test(str(c.id))) return null;
  const name = str(c.name, 40).trim();
  if (!name) return null;
  return { id: c.id, name, color: Math.max(0, Math.min(5, Math.round(num(c.color)))) };
}
function normalizeTaskGroups(list) {
  const ids = new Set();
  return (Array.isArray(list) ? list : []).slice(0, 200).flatMap(g => {
    if (!g || !ID_RE.test(str(g.id)) || ids.has(g.id)) return [];
    const name = str(g.name, 60).trim();
    if (!name) return [];
    ids.add(g.id);
    return [{ id: g.id, name }];
  });
}
const TASK_TAG_MAX = 30;
const ARCHIVE_MODES = ['day', 'week', 'manual'];
function normalizeTags(list) {
  const out = [];
  (Array.isArray(list) ? list : []).forEach((x) => {
    const tag = str(x, TASK_TAG_MAX).trim();
    if (tag && out.length < 10 && !out.some((y) => y.toLowerCase() === tag.toLowerCase())) out.push(tag);
  });
  return out;
}
function normalizeSubtasks(list) {
  return (Array.isArray(list) ? list : []).slice(0, 100).map((s) => {
    if (!s || typeof s !== 'object') return null;
    const title = str(s.title, 300).trim();
    return title ? { id: ID_RE.test(str(s.id)) ? s.id : newId('s'), title, done: !!s.done } : null;
  }).filter(Boolean);
}
function normalizeTask(t, fallbackTime) {
  if (!t || typeof t !== 'object') return null;
  const title = str(t.title, 300).trim();
  if (!title) return null;
  const now = fallbackTime || Date.now();
  const status = isTaskStatus(t.status) ? t.status : 'todo';
  const due = DATE_RE.test(str(t.due)) ? t.due : '';
  return {
    id: ID_RE.test(str(t.id)) ? t.id : newId('t'),
    title,
    status,
    parentId: ID_RE.test(str(t.parentId)) && t.parentId !== t.id ? t.parentId : '',
    groupId: ID_RE.test(str(t.groupId)) ? t.groupId : '',
    note: str(t.note, 5000).trim(),
    due,
    time: due && TIME_RE.test(str(t.time)) ? t.time : '',
    priority: [1, 2].includes(Number(t.priority)) ? Number(t.priority) : 0,
    tags: normalizeTags(t.tags),
    subtasks: normalizeSubtasks(t.subtasks),
    doneFrom: status === 'done' && t.doneFrom !== 'done' && isTaskStatus(t.doneFrom) ? t.doneFrom : '',
    // When it was ticked off (tasks done in older versions get the time of their last change) and when it went
    // to the archive. Both only for a task in «Готово»: taking it out of there clears them.
    // The first time it left «Предстоит» for work (kept when it goes back; a task in work from an older version gets
    // the time of its last change; one done straight from «Предстоит» has none).
    startedAt: num(t.startedAt) || (status !== 'todo' && status !== 'done' ? num(t.updatedAt) || now : 0),
    doneAt: status === 'done' ? num(t.doneAt) || num(t.updatedAt) || now : 0,
    archivedAt: status === 'done' ? num(t.archivedAt) : 0,
    order: Number.isFinite(Number(t.order)) ? Number(t.order) : now,
    createdAt: num(t.createdAt) || now,
    updatedAt: num(t.updatedAt) || num(t.createdAt) || now
  };
}

// A suggested change in a chat ("Создать промт …?") and what the user answered.
const ACTION_STATUSES = ['done', 'canceled', 'stale', 'undone', 'failed'];
function normalizeAction(a) {
  if (!a || typeof a !== 'object') return null;
  const out = {
    id: str(a.id, 64), kind: str(a.kind, 40), title: str(a.title, 300), category: str(a.category, 60), text: str(a.text, 200000),
    // A card nobody answered cannot be answered after a restart: main.js has forgotten it.
    status: ACTION_STATUSES.includes(a.status) ? a.status : 'stale'
  };
  // Calendar cards also carry the event they add or delete.
  if (a.event && typeof a.event === 'object') out.event = normalizeEvent(a.event);
  // Task cards carry the task, and for a change also how it was before.
  if (a.task && typeof a.task === 'object') out.task = normalizeTask(a.task);
  if (a.prevTask && typeof a.prevTask === 'object') out.prevTask = normalizeTask(a.prevTask);
  if (a.kind === 'skill-set-type') {
    out.skillId = ID_RE.test(str(a.skillId)) ? a.skillId : '';
    out.prevCategory = str(a.prevCategory, 60);
  }
  return out;
}
// A picture in a message: its file is "Файлы чатов/<chat id>/<stored>". Skill files are kept the same way.
const STORED_RE = /^[A-Za-z0-9_-]{1,64}\.(jpg|png|md|zip|skill)$/;
const eventActionSignature = (e) => JSON.stringify([e.date, e.from, e.to, e.who, e.title, e.kind, e.note, e.remind]);
function staleAssistantAction() {
  const e = new Error('assistant action is stale');
  e.userMessage = 'Дело или задачу уже изменили. Попросите ассистента проверить её ещё раз.';
  return e;
}
function normalizeChatImages(list) {
  return (Array.isArray(list) ? list : []).slice(0, CHAT_IMAGES_MAX).map((x) => {
    if (!x || typeof x !== 'object' || !STORED_RE.test(str(x.stored))) return null;
    return { id: ID_RE.test(str(x.id)) ? x.id : newId('i'), name: str(x.name, NAME_MAX * 4).trim() || 'картинка', stored: x.stored };
  }).filter(Boolean);
}
function normalizeChat(c) {
  if (!c || typeof c !== 'object' || !ID_RE.test(str(c.id))) return null;
  const messages = (Array.isArray(c.messages) ? c.messages : []).map((m) => {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return null;
    const out = { role: m.role, text: str(m.text, 200000) };
    const images = m.role === 'user' ? normalizeChatImages(m.images) : [];
    if (images.length) out.images = images;
    if (m.note) out.note = str(m.note, 500);
    if (m.failed) out.failed = true;
    if (num(m.cost) > 0) out.cost = num(m.cost);   // what the answer cost, in dollars
    const actions = Array.isArray(m.actions) ? m.actions.map(normalizeAction).filter(Boolean) : [];
    if (actions.length) out.actions = actions;
    return out;
  }).filter(Boolean);
  if (!messages.length) return null;
  const now = Date.now();
  return { id: c.id, title: str(c.title, 120).trim() || 'Без названия', createdAt: num(c.createdAt) || now, updatedAt: num(c.updatedAt) || now, messages };
}

// A transcription: the text of a file, its phrases with times (cues, in seconds) and the pauses of the voice
// (the subtitles are built from them again after the text is corrected). summary: null or { brief, points }.
const TRANSCRIPT_CUES_MAX = 20000;
const TRANSCRIPT_PAUSES_MAX = 50000;
function sec(v) { return Math.max(0, Math.round(num(v) * 1000) / 1000); }
function normalizeTranscript(t) {
  if (!t || typeof t !== 'object' || !ID_RE.test(str(t.id))) return null;
  const cues = (Array.isArray(t.cues) ? t.cues : []).slice(0, TRANSCRIPT_CUES_MAX).map((c) => {
    if (!c || typeof c !== 'object') return null;
    const text = str(c.text, 5000).trim();
    if (!text) return null;
    const start = sec(c.start);
    const cue = { start, end: Math.max(start, sec(c.end)), text };
    // Who says it, for recordings with several voices («Собеседник 1» or a name the user wrote instead).
    const speaker = str(c.speaker, 60).trim();
    if (speaker) cue.speaker = speaker;
    return cue;
  }).filter(Boolean);
  const pauses = (Array.isArray(t.pauses) ? t.pauses : []).slice(0, TRANSCRIPT_PAUSES_MAX)
    .filter((p) => Array.isArray(p) && p.length === 2).map((p) => [sec(p[0]), sec(p[1])]).filter((p) => p[1] > p[0]);
  let summary = null;
  if (t.summary && typeof t.summary === 'object' && str(t.summary.brief).trim()) {
    summary = { brief: str(t.summary.brief, 5000).trim(), points: (Array.isArray(t.summary.points) ? t.summary.points : []).map((x) => str(x, 500).trim()).filter(Boolean).slice(0, 20) };
  }
  const now = Date.now();
  return {
    id: t.id, name: str(t.name, 300).trim() || 'файл', source: str(t.source, 2000), kind: t.kind === 'audio' ? 'audio' : 'video',
    poster: /^data:image\/jpeg;base64,[a-z0-9+/=]+$/i.test(str(t.poster)) && str(t.poster).length < 250000 ? t.poster : '',
    size: Math.max(0, Math.round(num(t.size))), duration: sec(t.duration), model: str(t.model, 60),
    // With several voices: the model that wrote the text (the voices and times are from `model`, the diarize one).
    textModel: str(t.textModel, 60),
    createdAt: num(t.createdAt) || now, updatedAt: num(t.updatedAt) || now,
    text: str(t.text, 2000000).trim() || cues.map((c) => c.text).join(' '), cues, pauses, summary,
    usd: Math.max(0, num(t.usd)), sent: sec(t.sent), pieces: Math.max(0, Math.round(num(t.pieces)))
  };
}

// Keep damaged originals in place and tell the user instead of silently hiding a transcription.
async function readTranscripts(dir, warnings) {
  let names = [];
  try { names = await fsp.readdir(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const out = [];
  for (const name of names) {
    if (!/\.json$/i.test(name) || /\.backup\.json$/i.test(name) || /\.broken-[^.]+\.json$/i.test(name)) continue;
    let raw;
    try { raw = await fsp.readFile(path.join(dir, name), 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    let t = null;
    try { t = normalizeTranscript(JSON.parse(raw.replace(/^\uFEFF/, ''))); } catch (e) { /* reported below */ }
    if (t && name === t.id + '.json') { out.push(t); continue; }
    if (warnings) warnings.push({ file: path.join(TRANSCRIPTS_DIR, name), broken: path.join(TRANSCRIPTS_DIR, name), restored: false, transcript: true });
    else {
      const e = new Error('invalid archive transcript');
      e.userMessage = 'В архиве есть повреждённая расшифровка. Проверьте файл резервной копии.';
      throw e;
    }
  }
  return out;
}

/* ---------- «Скиллы»: instructions for assistants, a .md file or a .zip/.skill archive kept as it was ---------- */
const SKILL_TYPES = ['static', 'video', 'audio', 'text', 'code'];
const SKILL_TEXT_MAX = 200000;     // the main Markdown file, for search, the description and the assistant
const SKILL_INSIDE_MAX = 300;      // files of an archive listed in the record
const SKILL_MD_SIZE = 2 * 1024 * 1024;
const SKILL_ZIP_SIZE = 200 * 1024 * 1024;
const skillKind = (name) => { const archive = /\.(zip|skill)$/i.exec(name); return archive ? archive[1].toLowerCase() : /\.(md|markdown)$/i.test(name) ? 'md' : ''; };
function normalizeSkill(s) {
  if (!s || typeof s !== 'object' || !ID_RE.test(str(s.id))) return null;
  const f = s.file && typeof s.file === 'object' ? s.file : {};
  const stored = sanitizeName(str(f.stored, 300) || str(f.name, 300) || 'skill.md');
  if (!skillKind(stored)) return null;
  const now = Date.now();
  return {
    id: s.id,
    title: str(s.title, 300).trim(),
    type: SKILL_TYPES.includes(s.type) ? s.type : '',
    desc: str(s.desc, 6000).trim(),
    descBy: str(s.descBy, 60),          // the model that wrote the description, 'manual', or '' while there is none
    descCost: Math.max(0, num(s.descCost)),
    descAt: num(s.descAt),
    file: { name: str(f.name, 300) || stored, stored, size: Math.max(0, num(f.size)), kind: skillKind(stored) },
    main: str(s.main, 500),             // the path of the main .md inside an archive
    inside: (Array.isArray(s.inside) ? s.inside : []).slice(0, SKILL_INSIDE_MAX)
      .map((x) => (x && typeof x === 'object' ? { path: str(x.path, 500), size: Math.max(0, num(x.size)) } : null)).filter((x) => x && x.path),
    files: Math.max(0, num(s.files)),   // how many files the archive has (inside may be cut)
    text: str(s.text, SKILL_TEXT_MAX),
    createdAt: num(s.createdAt) || now,
    updatedAt: num(s.updatedAt) || num(s.createdAt) || now
  };
}
// The title a skill gives itself: "name:" in the front matter of its .md, else the folder of the archive or the file name.
function skillTitle(text, fileName, inside) {
  const fm = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text || '');
  const m = fm && /^name:\s*["']?(.+?)["']?\s*$/m.exec(fm[1]);
  if (m && m[1].trim()) return m[1].trim().slice(0, 300);
  const tops = new Set((inside || []).map((x) => x.path.split('/')[0]));
  if (tops.size === 1 && (inside || []).every((x) => x.path.includes('/'))) return [...tops][0].slice(0, 300);
  const stem = path.basename(String(fileName || ''), path.extname(String(fileName || '')));
  if (/^skill$/i.test(stem)) { const h1 = /^#\s+(.+)$/m.exec(text || ''); if (h1) return h1[1].trim().slice(0, 300); }
  return stem.slice(0, 300) || 'Скилл';
}
// Reads a skill file: its kind, size, files inside and the text of the main Markdown file. Throws userMessage errors.
async function readSkillFile(file, name) {
  const kind = skillKind(name || file);
  const bad = (msg) => { const e = new Error('bad skill'); e.userMessage = msg; return e; };
  if (!kind) throw bad('Скилл — это файл .md или архив .zip либо .skill.');
  const st = await fsp.stat(file);
  if (!st.isFile()) throw bad('Это папка, а нужен файл .md или архив .zip либо .skill.');
  if (kind === 'md') {
    if (st.size > SKILL_MD_SIZE) throw bad('Файл .md больше 2 МБ — это не похоже на скилл.');
    const text = (await fsp.readFile(file, 'utf8')).replace(/^﻿/, '');
    return { kind, size: st.size, text: text.slice(0, SKILL_TEXT_MAX), main: '', inside: [], files: 1 };
  }
  if (st.size > SKILL_ZIP_SIZE) throw bad('Архив больше 200 МБ — слишком большой для скилла.');
  let idx;
  try { idx = await readZipIndex(file); } catch (e) { throw bad('Этот архив не открылся: он повреждён или это не zip.'); }
  if (!idx.files.length) throw bad('Архив пустой.');
  return { kind, size: st.size, text: idx.text.replace(/^﻿/, '').slice(0, SKILL_TEXT_MAX), main: idx.main, inside: idx.files.slice(0, SKILL_INSIDE_MAX), files: idx.files.length };
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
    this.dataWarnings = [];
    this.profile = normalizeProfile(null);
    this.activity = normalizeActivity(null);
    this.chats = [];
    this.events = [];
    this.tasks = [];
    this.taskGroups = [];
    this.columns = [];       // the user's own task columns, in their order
    this.archiveMode = 'day'; // done tasks go to the archive by themselves: 'day', 'week' or 'manual'
    this.transcripts = [];   // «Транскрибация»: one file per transcription in Транскрибации/
    this.skills = [];        // «Скиллы»: skills.json, their files in Скиллы/<id>/
    this.queue = Promise.resolve();
  }

  get dataPath() { return path.join(this.dir, DATA_FILE); }
  get backupPath() { return path.join(this.dir, BACKUP_FILE); }
  get filesRoot() { return path.join(this.dir, FILES_DIR); }
  get profilePath() { return path.join(this.dir, PROFILE_FILE); }
  get avatarPath() { return path.join(this.dir, AVATAR_FILE); }
  get activityPath() { return path.join(this.dir, ACTIVITY_FILE); }
  get chatsPath() { return path.join(this.dir, CHATS_FILE); }
  get chatFilesRoot() { return path.join(this.dir, CHAT_FILES_DIR); }
  chatFilesDir(chatId) {
    if (!ID_RE.test(str(chatId))) throw new Error('bad id');
    return path.join(this.chatFilesRoot, chatId);
  }
  // The file of a picture in a conversation, or null for a name that is not ours (no "..", no folders).
  chatImagePath(chatId, stored) {
    if (!ID_RE.test(str(chatId)) || !STORED_RE.test(str(stored))) return null;
    return path.join(this.chatFilesRoot, chatId, stored);
  }
  // A picture for a message (already made smaller by the window): bytes of a JPEG or PNG.
  saveChatImage(chatId, name, bytes, ext) {
    return this.run(async () => {
    const dir = this.chatFilesDir(chatId);
    await fsp.mkdir(dir, { recursive: true });
    const id = newId('i');
    const stored = id + '.' + (ext === 'png' ? 'png' : 'jpg');
    await fsp.writeFile(path.join(dir, stored), Buffer.from(bytes));
    return { id, name: str(name, NAME_MAX * 4).trim() || 'картинка', stored };
    });
  }
  removeChatImage(chatId, stored) {
    return this.run(async () => {
    const file = this.chatImagePath(chatId, stored);
    if (file && await exists(file)) { try { await this.trash(file); } catch (e) { await fsp.rm(file, { force: true }); } }
    });
  }
  get transcriptsRoot() { return path.join(this.dir, TRANSCRIPTS_DIR); }
  transcriptPath(id) {
    if (!ID_RE.test(str(id))) throw new Error('bad id');
    return path.join(this.transcriptsRoot, id + '.json');
  }
  // A skill file sent with an LLM message (.md, .zip or .skill), beside the pictures of the conversation.
  saveChatFile(chatId, name, bytes) {
    return this.run(async () => {
    const kind = skillKind(name);
    if (!kind) throw new Error('bad kind');
    const dir = this.chatFilesDir(chatId);
    await fsp.mkdir(dir, { recursive: true });
    const id = newId('i');
    const stored = id + '.' + kind;
    await fsp.writeFile(path.join(dir, stored), Buffer.from(bytes));
    return { id, name: str(name, NAME_MAX * 4).trim() || 'skill.' + kind, stored };
    });
  }
  get skillsPath() { return path.join(this.dir, SKILLS_FILE); }
  get skillsRoot() { return path.join(this.dir, SKILLS_DIR); }
  skillDir(id) {
    if (!ID_RE.test(str(id))) throw new Error('bad id');
    return path.join(this.skillsRoot, id);
  }
  get calendarPath() { return path.join(this.dir, CALENDAR_FILE); }
  get tasksPath() { return path.join(this.dir, TASKS_FILE); }
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

  // Publish the changed lists only after their files have been saved successfully.
  runLists(keys, fn) {
    if (keys.includes('tasks') && !keys.includes('taskGroups')) keys = keys.concat('taskGroups');
    return this.run(async () => {
      const draft = Object.create(this);
      keys.forEach((key) => { draft[key] = structuredClone(this[key]); });
      const result = await fn.call(draft);
      keys.forEach((key) => { this[key] = draft[key]; });
      return result;
    });
  }

  async init(seed) {
    await this.initData(seed);
    await this.loadExtras();
    return this;
  }

  // Profile and statistics live beside prompts.json and never block opening the prompts.
  async loadExtras() {
    this.profile = normalizeProfile(await readProtectedJson(this.profilePath, (v) => !!v && typeof v === 'object' && !Array.isArray(v), this.dataWarnings));
    const chats = await readProtectedJson(this.chatsPath, (v) => !!v && Array.isArray(v.chats), this.dataWarnings);
    this.chats = chats && Array.isArray(chats.chats) ? chats.chats.map(normalizeChat).filter(Boolean) : [];
    const cal = await readProtectedJson(this.calendarPath, (v) => !!v && Array.isArray(v.events), this.dataWarnings);
    this.events = cal && Array.isArray(cal.events) ? cal.events.map((e) => normalizeEvent(e)).filter(Boolean) : [];
    const tasks = await readProtectedJson(this.tasksPath, (v) => !!v && Array.isArray(v.tasks), this.dataWarnings);
    this.columns = tasks && Array.isArray(tasks.columns) ? tasks.columns.map(normalizeColumn).filter(Boolean).slice(0, COLUMN_MAX) : [];
    this.archiveMode = tasks && ARCHIVE_MODES.includes(tasks.archiveMode) ? tasks.archiveMode : 'day';
    this.tasks = tasks && Array.isArray(tasks.tasks) ? tasks.tasks.map((t) => this.fitColumn(normalizeTask(t))).filter(Boolean) : [];
    this.taskGroups = normalizeTaskGroups(tasks?.groups);
    this.transcripts = await readTranscripts(this.transcriptsRoot, this.dataWarnings);
    const skills = await readProtectedJson(this.skillsPath, (v) => !!v && Array.isArray(v.skills), this.dataWarnings);
    this.skills = skills && Array.isArray(skills.skills) ? skills.skills.map(normalizeSkill).filter(Boolean) : [];
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
  recordAssistant() { return this.run(() => this.bump('assistant', 1)); }
  recordTranscribe() { return this.run(() => this.bump('transcribe', 1)); }
  recordScreenshot() { return this.run(() => this.bump('screenshots', 1)); }

  activityView() { return { since: this.activity.since, days: this.activity.days }; }

  profileView() {
    const p = this.profile;
    const file = this.profileAvatarPath(p);
    const avatar = p.avatarAt && fs.existsSync(file) ? pathToFileURL(file).href + '?v=' + p.avatarAt : null;
    return { name: p.name, welcomed: p.welcomed, avatar, avatarVersion: JSON.stringify([p.avatarAt, p.avatarFile]) };
  }

  profileAvatarPath(profile) { return path.join(this.dir, profile.avatarFile || AVATAR_FILE); }
  async createProfileAvatar(source) {
    let file, name, handle;
    for (;;) {
      name = 'avatar-' + crypto.randomBytes(12).toString('hex') + '.png';
      file = path.join(this.dir, name);
      try { handle = await fsp.open(file, 'wx'); break; }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    try {
      if (Buffer.isBuffer(source)) await handle.writeFile(source);
      else await pipeline(fs.createReadStream(source), handle.createWriteStream());
      await handle.close();
      return name;
    } catch (e) {
      await handle.close().catch(() => {});
      await fsp.rm(file, { force: true }).catch(() => {});
      throw e;
    }
  }

  // input: { name?, avatar?: PNG Buffer | null (remove) | undefined (keep) }
  saveProfile(input) {
    return this.run(async () => {
      const prev = this.profile;
      const expected = input && input.expected;
      if (expected && ((typeof expected.name === 'string' && expected.name !== prev.name) ||
        (typeof expected.avatar === 'string' && expected.avatar !== JSON.stringify([prev.avatarAt, prev.avatarFile])))) {
        const e = new Error('profile changed while editing');
        e.userMessage = 'Профиль изменили в другом окне. Ваши изменения остались в форме: скопируйте ник и откройте профиль заново.';
        throw e;
      }
      const p = Object.assign({}, prev);
      let created = '';
      if (input && typeof input.name === 'string') p.name = str(input.name, NAME_MAX).trim();
      if (input && input.avatar === null) {
        p.avatarAt = 0; p.avatarFile = '';
      } else if (input && Buffer.isBuffer(input.avatar)) {
        created = await this.createProfileAvatar(input.avatar);
        p.avatarFile = created;
        p.avatarAt = Date.now();
      }
      p.welcomed = true;
      let backupUpdated;
      try { backupUpdated = await writeProtectedJson(this.profilePath, p); }
      catch (e) { if (created) await fsp.rm(path.join(this.dir, created), { force: true }).catch(() => {}); throw e; }
      this.profile = p;
      const oldFile = prev.avatarAt && this.profileAvatarPath(prev);
      const replaced = oldFile && (p.avatarAt === 0 || oldFile !== this.profileAvatarPath(p));
      let oldAvatarLeft = false;
      if (replaced && await exists(oldFile)) {
        if (!backupUpdated) oldAvatarLeft = true;
        else { try { await this.trash(oldFile); } catch (e) { oldAvatarLeft = true; } }
      }
      return { oldAvatarLeft, backupUpdated };
    });
  }

  /* ---------- calendar ---------- */
  // Sorted by day and time.
  // The window gets the summary without the long source text (recapText gives it when it is opened).
  calendarView() {
    return this.events.slice().sort((a, b) => (a.date + a.from).localeCompare(b.date + b.from))
      .map((e) => Object.assign({}, e, { recapRevision: recapRevision(e.recap) },
        e.recap ? { recap: Object.assign({}, e.recap, { text: '', hasText: !!e.recap.text }) } : {}));
  }
  recapText(id) { const e = this.findEvent(id); return e && e.recap ? e.recap.text : ''; }
  recapRevision(id) { const e = this.findEvent(id); return e ? recapRevision(e.recap) : null; }
  // Puts a summary on an event (null takes it off) without touching the event's other fields or the statistics.
  setRecap(id, recap, expected) {
    return this.runLists(['events'], async function () {
      const prev = this.findEvent(id);
      if (typeof expected === 'string' && (!prev || recapRevision(prev.recap) !== expected)) {
        const e = new Error('recap changed while editing');
        e.userMessage = 'Итоги изменили или дело удалили в другом окне. Откройте дело заново и повторите действие.';
        throw e;
      }
      if (!prev) return null;
      const next = recap ? normalizeRecap(Object.assign({}, recap, !recap.text && prev.recap ? { text: prev.recap.text } : {})) : null;
      const ev = Object.assign({}, prev, { recap: next, updatedAt: Date.now() });
      this.events[this.events.indexOf(prev)] = ev;
      await this.writeCalendar();
      return ev;
    });
  }
  findEvent(id) { return this.events.find((e) => e.id === id) || null; }
  writeCalendar() { return writeProtectedJson(this.calendarPath, { format: 'snowball-calendar', version: 1, events: this.events }); }

  // A new event (no id or an unknown one) or a change to an existing one.
  saveEvent(input) {
    return this.runLists(['events'], async function () {
      const prev = input && input.id ? this.findEvent(input.id) : null;
      const now = Date.now();
      const sig = (e) => JSON.stringify([e.date, e.from, e.to, e.who, e.title, e.kind, e.note, e.remind]);
      if (input && typeof input.expectedAction === 'string' && (!prev || sig(prev) !== input.expectedAction)) throw staleAssistantAction();
      if (input && typeof input.expected === 'string' && (!prev || sig(prev) !== input.expected)) {
        const e = new Error('event changed while editing');
        e.userMessage = 'Дело изменили в другом окне. Ваш текст остался в форме: скопируйте его и откройте дело заново.';
        throw e;
      }
      // A change from the form or an assistant does not carry the summary: it stays as it was (setRecap changes it).
      const keepRecap = prev && !(input && input.recap && typeof input.recap === 'object') ? { recap: prev.recap } : {};
      const ev = normalizeEvent(Object.assign({}, input, keepRecap, { createdAt: prev ? prev.createdAt : now, updatedAt: now }));
      if (!ev) throw Object.assign(new Error('bad event'), { userMessage: 'Не получилось сохранить дело: проверьте день и время.' });
      // "Сохранить" without real changes is not an action on the statistics page.
      const changed = !prev || sig(prev) !== sig(ev);
      if (prev && !changed) return prev;
      if (prev) this.events[this.events.indexOf(prev)] = ev;
      else { if (this.findEvent(ev.id)) ev.id = newId('e'); this.events.push(ev); }
      await this.writeCalendar();
      await this.bump('calendar', 1);
      return ev;
    });
  }

  // An event exactly as it was (for «Отменить»): replaces the one with this id or puts it back; no statistics.
  putEvent(input) {
    return this.runLists(['events'], async function () {
      const ev = normalizeEvent(input);
      if (!ev) return null;
      const prev = this.findEvent(ev.id);
      if (prev) this.events[this.events.indexOf(prev)] = ev; else this.events.push(ev);
      await this.writeCalendar();
      return ev;
    });
  }

  deleteEvent(id, expectedAction) {
    return this.runLists(['events'], async function () {
      const ev = this.findEvent(id);
      if (typeof expectedAction === 'string' && (!ev || eventActionSignature(ev) !== expectedAction)) throw staleAssistantAction();
      if (!ev) return null;
      this.events = this.events.filter((e) => e.id !== id);
      await this.writeCalendar();
      return ev;
    });
  }

  /* ---------- tasks board ---------- */
  // All columns in their order: «Предстоит», «В процессе», the user's own, «Готово».
  columnsView() {
    return [BASE_COLUMNS[0], BASE_COLUMNS[1]].map((c) => Object.assign({ base: true }, c))
      .concat(this.columns.map((c) => Object.assign({}, c)), [Object.assign({ base: true }, BASE_COLUMNS[2])]);
  }
  hasColumn(id) { return TASK_STATUSES.includes(id) || this.columns.some((c) => c.id === id); }
  // A task whose own column is gone goes to «Предстоит».
  fitColumn(t) {
    if (!t) return t;
    if (!this.hasColumn(t.status)) t.status = 'todo';
    if (t.doneFrom && !this.hasColumn(t.doneFrom)) t.doneFrom = '';
    return t;
  }
  // By column, then by place in the column.
  tasksView() {
    return numberedTasks(this.tasks, this.columnsView(), this.taskGroups);
  }
  groupsView() { return structuredClone(this.taskGroups); }
  addTaskGroup(name) {
    return this.runLists(['tasks', 'columns', 'archiveMode'], async function () {
      name = str(name, 60).trim();
      if (!name) throw Object.assign(new Error('bad task group'), { userMessage: 'Напишите название подгруппы.' });
      const existing = this.taskGroups.find(g => g.name.toLocaleLowerCase('ru') === name.toLocaleLowerCase('ru'));
      if (existing) return existing;
      if (this.taskGroups.length >= 200) throw Object.assign(new Error('too many groups'), { userMessage: 'На доске уже 200 подгрупп.' });
      const group = { id: newId('grp'), name };
      this.taskGroups.push(group); await this.writeTasks(); return group;
    });
  }
  renameTaskGroup(id, name, expectedName) {
    return this.runLists(['tasks', 'columns', 'archiveMode'], async function () {
      const group = this.taskGroups.find(g => g.id === id);
      if (!group || expectedName !== undefined && group.name !== expectedName) throw Object.assign(new Error('group changed'), { userMessage: 'Подгруппу изменили в другом окне. Обновите доску.' });
      name = str(name, 60).trim();
      if (!name || this.taskGroups.some(g => g.id !== id && g.name.toLocaleLowerCase('ru') === name.toLocaleLowerCase('ru'))) throw Object.assign(new Error('bad task group name'), { userMessage: 'Укажите непустое название, отличающееся от других подгрупп.' });
      group.name = name; await this.writeTasks(); return group;
    });
  }
  taskNumber(id) { return this.tasksView().find(t => t.id === id)?.number ?? null; }
  findTasksByNumber(number, status, archived = false) {
    return this.tasksView().filter(t => String(t.number) === String(number) && !!t.archivedAt === archived && (!status || t.status === status));
  }
  findTaskByNumber(number, status, archived = false) {
    const found = this.findTasksByNumber(number, status, archived);
    return found.length === 1 ? this.findTask(found[0].id) : null;
  }
  findTask(id) { return this.tasks.find((t) => t.id === id) || null; }
  tasksFile(tasks = this.tasks) { return { format: 'snowball-tasks', version: 1, columns: this.columns, groups: this.taskGroups, archiveMode: this.archiveMode, tasks }; }
  async writeTasks() {
    const file = this.tasksFile();
    await writeProtectedJson(this.tasksPath, file);
  }

  // The user's own columns: add, rename, move left (-1) or right (+1) among them, delete and bring back.
  addColumn(name) {
    return this.runLists(['tasks', 'columns', 'archiveMode'], async function () {
      if (this.columns.length >= COLUMN_MAX) throw Object.assign(new Error('too many columns'), { userMessage: 'Своих столбцов может быть не больше ' + COLUMN_MAX + '.' });
      const used = this.columns.map((c) => c.color);
      const color = [0, 1, 2, 3, 4, 5].find((n) => !used.includes(n));
      const col = normalizeColumn({ id: newId('col'), name, color: color === undefined ? this.columns.length % 6 : color });
      if (!col) throw Object.assign(new Error('bad column'), { userMessage: 'Напишите название столбца.' });
      this.columns.push(col);
      await this.writeTasks();
      return col;
    });
  }
  renameColumn(id, name) {
    return this.runLists(['tasks', 'columns', 'archiveMode'], async function () {
      const col = this.columns.find((c) => c.id === id);
      const v = str(name, 40).trim();
      if (!col || !v) return null;
      col.name = v;
      await this.writeTasks();
      return col;
    });
  }
  moveColumn(id, dir) {
    return this.runLists(['tasks', 'columns', 'archiveMode'], async function () {
      const i = this.columns.findIndex((c) => c.id === id), j = i + (dir < 0 ? -1 : 1);
      if (i === -1 || j < 0 || j >= this.columns.length) return;
      const [col] = this.columns.splice(i, 1);
      this.columns.splice(j, 0, col);
      await this.writeTasks();
    });
  }
  // Its tasks go to the bottom of «Предстоит». Returns what is needed to bring it all back.
  deleteColumn(id) {
    return this.runLists(['tasks', 'columns', 'archiveMode'], async function () {
      const index = this.columns.findIndex((c) => c.id === id);
      if (index === -1) return null;
      const [column] = this.columns.splice(index, 1);
      const todo = this.tasks.filter((t) => t.status === 'todo');
      let order = todo.length ? Math.max.apply(null, todo.map((t) => t.order)) + 1 : Date.now();
      const moved = [];
      this.tasks.forEach((t) => {
        if (t.status === id) { t.status = 'todo'; t.order = order++; moved.push(t.id); }
        if (t.doneFrom === id) t.doneFrom = '';
      });
      await this.writeTasks();
      return { column, index, moved };
    });
  }
  restoreColumn(r) {
    return this.runLists(['tasks', 'columns', 'archiveMode'], async function () {
      const column = normalizeColumn(r && r.column);
      if (!column || this.columns.some((c) => c.id === column.id) || this.columns.length >= COLUMN_MAX) return;
      this.columns.splice(Math.max(0, Math.min(this.columns.length, num(r.index))), 0, column);
      const ids = Array.isArray(r.moved) ? r.moved : [];
      this.tasks.forEach((t) => { if (ids.includes(t.id) && t.status === 'todo') t.status = column.id; });
      await this.writeTasks();
    });
  }

  // A new task (no id or an unknown one) lands at the bottom of its column; a known one changes (only the fields given).
  moveTaskChildren(task, prev, now) {
    if (!prev) return;
    // Follow each field independently: a completed child keeps its status, while
    // children in the parent's old column travel with it through every nesting level.
    for (const field of ['status', 'groupId']) {
      if (task[field] === prev[field]) continue;
      const moved = new Set([task.id]);
      let added = true;
      while (added) {
        added = false;
        this.tasks.forEach((child, index) => {
          if (moved.has(child.id) || !moved.has(child.parentId) || child[field] !== prev[field]) return;
          const merged = { ...child, [field]: task[field], updatedAt: now };
          if (field === 'status') {
            merged.archivedAt = 0;
            if (task.status === 'done') { merged.doneFrom = child.status; merged.doneAt = now; }
            if (!['todo', 'done'].includes(task.status) && !merged.startedAt) merged.startedAt = now;
          }
          this.tasks[index] = normalizeTask(merged);
          moved.add(child.id); added = true;
        });
      }
    }
  }
  // Moving to another column without an order puts it at the bottom there.
  // Statistics: a new task, a move to another column, every new subtask and every subtask ticked off count as actions.
  // Edits, deleting, a move inside the column and taking a tick back (out of «Готово» too) do not.
  saveTask(input) {
    return this.runLists(['tasks', 'columns', 'archiveMode'], async function () {
      if (input && input.status && !this.hasColumn(input.status)) input = Object.assign({}, input, { status: 'todo' });
      const prev = input && input.id ? this.findTask(input.id) : null;
      if (input && typeof input.expectedAction === 'string' && (!prev || JSON.stringify(prev) !== input.expectedAction)) throw staleAssistantAction();
      if (input && input.expectedFields && typeof input.expectedFields === 'object') {
        const fields = Object.keys(input.expectedFields);
        if (!prev || fields.some((key) => JSON.stringify(prev[key]) !== input.expectedFields[key])) {
          const e = new Error('task changed while editing');
          e.userMessage = 'Эту часть задачи изменили в другом окне. Ваш текст остался в панели: скопируйте его, затем откройте задачу заново.';
          throw e;
        }
      }
      const now = Date.now();
      const merged = Object.assign({}, prev || {}, input, { createdAt: prev ? prev.createdAt : now, updatedAt: now });
      if (input.groupId && input.groupId !== prev?.groupId && !this.taskGroups.some(g => g.id === input.groupId)) throw Object.assign(new Error('missing task group'), { userMessage: 'Подгруппа больше недоступна. Обновите доску.' });
      // A moved card keeps all of its fields. Reject missing parents and loops inside the same write queue.
      if (input.parentId) {
        const seen = new Set([merged.id]);
        let parent = this.findTask(input.parentId);
        if (!prev || !parent || parent.archivedAt) throw Object.assign(new Error('bad parent'), { userMessage: 'Задача для вложения больше недоступна. Обновите доску и попробуйте снова.' });
        while (parent) {
          if (seen.has(parent.id)) throw Object.assign(new Error('task cycle'), { userMessage: 'Нельзя вложить задачу в саму себя или в её подзадачу.' });
          seen.add(parent.id);
          parent = this.findTask(parent.parentId);
        }
      }
      const moved = prev && input.status && input.status !== prev.status;
      if ((!prev || moved) && input.order === undefined) {
        const col = this.tasks.filter((t) => t.status === (merged.status || 'todo') && t !== prev);
        merged.order = col.length ? Math.max.apply(null, col.map((t) => t.order)) + 1 : now;
      }
      if (moved && merged.status === 'done' && input.doneFrom === undefined) merged.doneFrom = prev.status;
      if ((!prev || moved) && merged.status === 'done' && input.doneAt === undefined) { merged.doneAt = now; merged.archivedAt = 0; }
      if ((!prev || moved) && !['todo', 'done'].includes(merged.status || 'todo') && !num(merged.startedAt)) merged.startedAt = now;
      const task = this.fitColumn(normalizeTask(merged));
      if (!task) throw Object.assign(new Error('bad task'), { userMessage: 'Напишите, что нужно сделать.' });
      if (prev) this.tasks[this.tasks.indexOf(prev)] = task;
      else { if (this.findTask(task.id)) task.id = newId('t'); this.tasks.push(task); }
      // Keep the nested tree together when moving columns or categories.
      this.moveTaskChildren(task, prev, now);
      await this.writeTasks();
      let n = !prev || (moved && prev.status !== 'done') ? 1 : 0;
      const before = new Map((prev ? prev.subtasks : []).map((s) => [s.id, s]));
      task.subtasks.forEach((s) => {
        const was = before.get(s.id);
        if (!was) n += s.done ? 2 : 1;
        else if (s.done && !was.done) n += 1;
      });
      await this.bump('tasks', n);
      return task;
    });
  }

  restoreTaskChanges(batches) {
    return this.runLists(['tasks'], async function () {
      for (const changes of batches) {
        for (const change of changes) {
          if (JSON.stringify(this.findTask(change.id) || null) !== JSON.stringify(change.after || null)) throw Object.assign(new Error('undo conflict'), { userMessage: 'Эти задачи уже изменились после действия ассистента. Отмена остановлена, чтобы сохранить новые изменения.' });
        }
        for (const change of changes) {
          this.tasks = this.tasks.filter(t => t.id !== change.id);
          if (change.before) this.tasks.push(structuredClone(change.before));
        }
      }
      await this.writeTasks();
    });
  }

  // Resolve numbers before calling this method: moving a category can renumber the board.
  moveTasks(ids, { status = null, groupId = null } = {}) {
    return this.runLists(['tasks', 'columns', 'archiveMode'], async function () {
      if (!Array.isArray(ids) || !ids.length || ids.length > 500 || ids.some(id => typeof id !== 'string' || !this.findTask(id))) throw Object.assign(new Error('missing tasks'), { userMessage: 'Некоторые задачи больше недоступны. Обновите доску.' });
      if (status !== null && !this.hasColumn(status)) throw Object.assign(new Error('missing column'), { userMessage: 'Столбец не найден.' });
      if (groupId !== null && groupId !== '' && !this.taskGroups.some(g => g.id === groupId)) throw Object.assign(new Error('missing group'), { userMessage: 'Подгруппа не найдена.' });
      const before = structuredClone(this.tasks), now = Date.now(); let count = 0;
      const tasks = [...new Set(ids)].map(id => {
        const prev = this.findTask(id), merged = { ...prev, updatedAt: now };
        if (groupId !== null) merged.groupId = groupId;
        if (status !== null && status !== prev.status) {
          merged.status = status; merged.archivedAt = 0;
          merged.order = Math.max(now, ...this.tasks.filter(t => t.status === status).map(t => t.order)) + 1;
          if (status === 'done') { merged.doneFrom = prev.status; merged.doneAt = now; }
          if (!['todo', 'done'].includes(status) && !merged.startedAt) merged.startedAt = now;
          if (prev.status !== 'done') count++;
        }
        const task = this.fitColumn(normalizeTask(merged));
        this.tasks[this.tasks.indexOf(prev)] = task;
        this.moveTaskChildren(task, prev, now);
        return task;
      });
      await this.writeTasks(); await this.bump('tasks', count);
      return { tasks, before: before.filter(t => JSON.stringify(t) !== JSON.stringify(this.findTask(t.id))) };
    });
  }

  /* ---------- the archive of done tasks ---------- */
  // Done tasks leave the board for the archive: by the «Убрать в архив» button, by the assistant, or by themselves
  // (archiveMode 'day' — everything done before today; 'week' — done more than 7 days ago; 'manual' — never by itself).
  // They stay in tasks.json with archivedAt. Not an action on the statistics page. Returns the ids that moved.
  archiveDone(ids) {
    return this.runLists(['tasks', 'columns', 'archiveMode'], async function () {
      const now = Date.now(), moved = [];
      this.tasks.forEach((t) => {
        if (t.status !== 'done' || t.archivedAt || (ids && !ids.includes(t.id))) return;
        t.archivedAt = now;
        moved.push(t.id);
      });
      if (moved.length) await this.writeTasks();
      return moved;
    });
  }
  // Back to «Готово» on the board («Отменить» after archiving, «Вернуть на доску»).
  unarchive(ids) {
    return this.runLists(['tasks', 'columns', 'archiveMode'], async function () {
      let n = 0;
      this.tasks.forEach((t) => { if (t.archivedAt && ids.includes(t.id)) { t.archivedAt = 0; n++; } });
      if (n) await this.writeTasks();
      return n;
    });
  }
  // The day a done task leaves by itself: before today, or before the day 6 days ago (more than a week).
  archiveBefore() {
    if (this.archiveMode === 'manual') return 0;
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    if (this.archiveMode === 'week') d.setDate(d.getDate() - 6);
    return d.getTime();
  }
  autoArchive() {
    const before = this.archiveBefore();
    if (!before) return Promise.resolve([]);
    const ids = this.tasks.filter((t) => t.status === 'done' && !t.archivedAt && t.doneAt < before).map((t) => t.id);
    return ids.length ? this.archiveDone(ids) : Promise.resolve([]);
  }
  setArchiveMode(mode) {
    return this.runLists(['tasks', 'columns', 'archiveMode'], async function () {
      if (!ARCHIVE_MODES.includes(mode) || mode === this.archiveMode) return;
      this.archiveMode = mode;
      await this.writeTasks();
    });
  }

  // Puts a task back exactly as it was (undo after deleting or after the assistant's changes). Not an action.
  putTask(input) {
    return this.runLists(['tasks', 'columns', 'archiveMode'], async function () {
      const task = this.fitColumn(normalizeTask(input));
      if (!task) return null;
      const prev = this.findTask(task.id);
      if (prev) this.tasks[this.tasks.indexOf(prev)] = task; else this.tasks.push(task);
      this.moveTaskChildren(task, prev, Date.now());
      await this.writeTasks();
      return task;
    });
  }

  deleteTask(id, expectedAction) {
    return this.runLists(['tasks', 'columns', 'archiveMode'], async function () {
      const task = this.findTask(id);
      if (typeof expectedAction === 'string' && (!task || JSON.stringify(task) !== expectedAction)) throw staleAssistantAction();
      if (!task) return null;
      this.tasks = this.tasks.filter((t) => t.id !== id);
      await this.writeTasks();
      return task;
    });
  }

  /* ---------- assistant chats ---------- */
  // Newest first, without the messages: enough for the history list.
  chatList() {
    return this.chats.slice().sort((a, b) => b.updatedAt - a.updatedAt)
      .map((c) => ({ id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt }));
  }
  getChat(id) { return this.chats.find((c) => c.id === id) || null; }
  writeChats() { return writeProtectedJson(this.chatsPath, { format: 'snowball-chats', version: 1, chats: this.chats }); }

  // Replaces the whole conversation: the window holds it and sends it after every finished message.
  saveChat(input) {
    return this.runLists(['chats'], async function () {
      const prev = this.getChat(input && input.id);
      if (input && Object.prototype.hasOwnProperty.call(input, 'expectedUpdatedAt') &&
          (prev ? prev.updatedAt !== input.expectedUpdatedAt : input.expectedUpdatedAt !== null)) {
        const e = new Error('conversation changed in another window');
        e.code = 'CHAT_CONFLICT';
        throw e;
      }
      const chat = normalizeChat(Object.assign({}, input, { createdAt: prev ? prev.createdAt : Date.now(), updatedAt: Math.max(Date.now(), prev ? prev.updatedAt + 1 : 0) }));
      if (!chat) return null;
      if (prev) this.chats[this.chats.indexOf(prev)] = chat; else this.chats.push(chat);
      await this.writeChats();
      return chat;
    });
  }

  deleteChat(id) {
    return this.runLists(['chats'], async function () {
      const before = this.chats.length;
      this.chats = this.chats.filter((c) => c.id !== id);
      if (this.chats.length === before) return;
      await this.writeChats();
      // Its pictures go to the Recycle Bin with it.
      if (ID_RE.test(str(id)) && await exists(this.chatFilesDir(id))) { try { await this.trash(this.chatFilesDir(id)); } catch (e) { /* leftover files are harmless */ } }
    });
  }

  /* ---------- «Транскрибация» ---------- */
  // Newest first, without the timings: enough for the history list. first: the beginning of the text.
  transcriptList() {
    return this.transcripts.slice().sort((a, b) => b.createdAt - a.createdAt).map((t) => ({
      id: t.id, name: t.name, kind: t.kind, duration: t.duration, createdAt: t.createdAt, summary: !!t.summary,
      first: t.text.slice(0, 160), words: t.text.slice(0, 4000)
    }));
  }
  getTranscript(id) { return this.transcripts.find((t) => t.id === id) || null; }
  async checkTranscriptPathFree(id) {
    try { await fsp.stat(this.transcriptPath(id)); }
    catch (e) { if (e.code === 'ENOENT') return; throw e; }
    const e = new Error('transcript file already exists');
    e.userMessage = 'В папке с данными уже есть файл этой расшифровки. Он оставлен без изменений; проверьте его перед восстановлением.';
    throw e;
  }
  // A new transcription (counted in the statistics) or the same one with corrected text, timings or a summary.
  saveTranscript(input) {
    return this.run(async () => {
      const prev = this.getTranscript(input && input.id);
      if (input && input.expectedFields && typeof input.expectedFields === 'object') {
        const fields = Object.keys(input.expectedFields);
        if (!prev || fields.some((key) => JSON.stringify(prev[key]) !== input.expectedFields[key])) {
          const e = new Error('transcript changed while editing');
          e.userMessage = 'Расшифровку изменили или удалили в другом окне. Ваш текст остался на экране: скопируйте его и откройте запись заново.';
          throw e;
        }
      }
      const updatedAt = Math.max(Date.now(), prev ? prev.updatedAt + 1 : 0);
      const t = normalizeTranscript(Object.assign({}, prev || {}, input, prev ? { createdAt: prev.createdAt } : {}, { updatedAt }));
      if (!t) return null;
      await fsp.mkdir(this.transcriptsRoot, { recursive: true });
      if (!prev) await this.checkTranscriptPathFree(t.id);
      await writeJson(this.transcriptPath(t.id), Object.assign({ format: 'snowball-transcript', version: 1 }, t));
      if (prev) this.transcripts[this.transcripts.indexOf(prev)] = t;
      else { this.transcripts.push(t); await this.bump('transcribe', 1); }
      return t;
    });
  }
  // Gone at once; the window keeps a copy for «Отменить» (putTranscript), which does not count in the statistics.
  deleteTranscript(id) {
    return this.run(async () => {
      const t = this.getTranscript(id);
      if (!t) return null;
      const file = this.transcriptPath(id);
      let present = true;
      try { await fsp.stat(file); } catch (e) { if (e.code !== 'ENOENT') throw e; present = false; }
      if (present) {
        try { await this.trash(file); }
        catch (e) { if (!e.userMessage) e.userMessage = 'Не удалось переместить расшифровку в корзину. Запись осталась в истории.'; throw e; }
      }
      this.transcripts = this.transcripts.filter((x) => x !== t);
      return t;
    });
  }
  putTranscript(input) {
    return this.run(async () => {
      const t = normalizeTranscript(input);
      if (!t || this.getTranscript(t.id)) return null;
      await fsp.mkdir(this.transcriptsRoot, { recursive: true });
      await this.checkTranscriptPathFree(t.id);
      await writeJson(this.transcriptPath(t.id), Object.assign({ format: 'snowball-transcript', version: 1 }, t));
      this.transcripts.push(t);
      return t;
    });
  }

  /* ---------- «Скиллы» ---------- */
  writeSkills() { return writeProtectedJson(this.skillsPath, { format: 'snowball-skills', version: 1, skills: this.skills }); }
  findSkill(id) { return this.skills.find((s) => s.id === id) || null; }
  skillFilePath(id) {
    const s = this.findSkill(id);
    return s ? path.join(this.skillDir(s.id), s.file.stored) : null;
  }
  // Newest first. The text is cut: the window needs it only for search and the beginning of the file.
  skillsView() {
    return this.skills.slice().sort((a, b) => b.createdAt - a.createdAt)
      .map((s) => Object.assign({}, s, { text: s.text.slice(0, 40000) }));
  }
  // A new skill from a file (path) or its bytes (bytes + name): the file is kept as it was, in Скиллы/<id>/.
  // The title comes from the file unless given; counted in the statistics.
  addSkill(input) {
    return this.run(async () => {
      const o = input || {};
      const name = sanitizeName(str(o.name, 300) || (o.path ? path.basename(String(o.path)) : ''));
      if (!skillKind(name)) { const e = new Error('bad skill'); e.userMessage = 'Скилл — это файл .md или архив .zip либо .skill.'; throw e; }
      await fsp.mkdir(this.skillsRoot, { recursive: true });
      let id, dir;
      for (;;) {
        id = newId('k');
        if (this.findSkill(id)) continue;
        dir = this.skillDir(id);
        try { await fsp.mkdir(dir); break; }
        catch (e) { if (e.code !== 'EEXIST') throw e; }
      }
      const target = path.join(dir, name);
      let copied = false, committed = false;
      try {
        if (o.path) await fsp.copyFile(String(o.path), target, fs.constants.COPYFILE_EXCL);
        else if (o.bytes) await fsp.writeFile(target, Buffer.from(o.bytes), { flag: 'wx' });
        else throw new Error('empty source');
        copied = true;
        const r = await readSkillFile(target, name);
        const now = Date.now();
        const desc = str(o.desc, 6000).trim();
        const skill = normalizeSkill({
          id, title: str(o.title, 300).trim() || skillTitle(r.text, name, r.inside), type: o.type,
          desc, descBy: desc ? str(o.descBy, 60) || 'manual' : '', descAt: desc ? now : 0, descCost: o.descCost,
          file: { name, stored: name, size: r.size }, main: r.main, inside: r.inside, files: r.files, text: r.text, createdAt: now, updatedAt: now
        });
        const draft = Object.create(this);
        draft.skills = this.skills.concat(skill);
        await draft.writeSkills();
        this.skills = draft.skills;
        committed = true;
        await this.bump('skills', 1);
        return skill;
      } catch (e) {
        if (!committed && copied) await fsp.rm(target, { force: true }).catch(() => {});
        if (!committed) await fsp.rmdir(dir).catch(() => {});
        throw e;
      }
    });
  }
  // Changes only the fields passed: title, type, desc (with descBy, descCost, descAt). Not counted in the statistics.
  saveSkill(input) {
    return this.run(async () => {
      const s = this.findSkill(input && input.id);
      if (input && input.expectedFields && typeof input.expectedFields === 'object') {
        const fields = Object.keys(input.expectedFields);
        if (!s || fields.some((key) => JSON.stringify(s[key]) !== input.expectedFields[key])) {
          const e = new Error('skill changed while editing');
          e.userMessage = 'Скилл изменили или удалили в другом окне. Если вы правили текст, он остался в редакторе: скопируйте его и откройте скилл заново.';
          throw e;
        }
      }
      if (!s) return null;
      const next = normalizeSkill(Object.assign({}, s, ['title', 'type', 'desc', 'descBy', 'descCost', 'descAt'].reduce((o, k) => {
        if (input[k] !== undefined) o[k] = input[k];
        return o;
      }, {}), { updatedAt: Date.now() }));
      if (!next.title) next.title = s.title;
      const draft = Object.create(this);
      draft.skills = this.skills.slice();
      draft.skills[this.skills.indexOf(s)] = next;
      await draft.writeSkills();
      this.skills = draft.skills;
      return next;
    });
  }
  // The record goes at once; its folder goes to the Recycle Bin.
  deleteSkill(id) {
    return this.run(async () => {
      const s = this.findSkill(id);
      if (!s) return null;
      const draft = Object.create(this);
      draft.skills = this.skills.filter((x) => x !== s);
      await draft.writeSkills();
      this.skills = draft.skills;
      const dir = this.skillDir(s.id);
      let fileStatus = 'missing';
      if (await exists(dir)) {
        try { await this.trash(dir); fileStatus = 'trash'; }
        catch (e) { fileStatus = 'left'; }
      }
      return { skill: s, fileStatus };
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

  // Cloud records are independent: editing one task never replaces the whole other device's board.
  cloudRecords() {
    const records = {};
    for (const [kind, list] of Object.entries({ prompt: this.data.prompts, task: this.tasks, event: this.events, chat: this.chats, transcript: this.transcripts, skill: this.skills })) {
      for (const item of list) {
        const value = structuredClone(item);
        if (kind === 'transcript') value.source = ''; // The source path is local to this computer, never uploaded.
        records[kind + ':' + item.id] = value;
      }
    }
    if (this.columns.length || this.taskGroups.length || this.archiveMode !== 'day') records['config:tasks'] = { columns: this.columns, groups: this.taskGroups, archiveMode: this.archiveMode };
    if (this.profile.name || this.profile.avatarAt) records['config:profile'] = this.profile;
    for (const [day, counts] of Object.entries(this.activity.days)) records['activity:' + day] = counts;
    return structuredClone(records);
  }

  // Called under run() by the cloud adapter. Publish only after the atomic disk write succeeded.
  async applyCloudRecord(key, input) {
    const [kind, id] = key.split(':');
    const definitions = {
      prompt: ['data', normalizePrompt],
      task: ['tasks', normalizeTask], event: ['events', normalizeEvent], chat: ['chats', normalizeChat],
      transcript: ['transcripts', normalizeTranscript], skill: ['skills', normalizeSkill]
    };
    if (kind === 'config' && id === 'tasks') {
      const columns = (input?.columns || []).map(normalizeColumn).filter(Boolean).slice(0, COLUMN_MAX);
      const taskGroups = input?.groups === undefined ? this.taskGroups : normalizeTaskGroups(input.groups);
      const archiveMode = ARCHIVE_MODES.includes(input?.archiveMode) ? input.archiveMode : 'day';
      await writeProtectedJson(this.tasksPath, { ...this.tasksFile(), columns, groups: taskGroups, archiveMode });
      this.columns = columns; this.taskGroups = taskGroups; this.archiveMode = archiveMode; return;
    }
    if (kind === 'config' && id === 'profile') {
      const profile = normalizeProfile(input);
      await writeProtectedJson(this.profilePath, profile); this.profile = profile; return;
    }
    if (kind === 'activity' && /^\d{4}-\d{2}-\d{2}$/.test(id)) {
      const activity = structuredClone(this.activity);
      if (input) activity.days[id] = input; else delete activity.days[id];
      const normalized = normalizeActivity(activity);
      await writeJson(this.activityPath, normalized); this.activity = normalized; return;
    }
    if (!definitions[kind] || !ID_RE.test(id)) throw Error('Неизвестная облачная запись.');
    const [prop, normalize] = definitions[kind];
    if (input && input.id !== id) throw Error('Повреждена облачная запись.');
    const list = kind === 'prompt' ? this.data.prompts : this[prop];
    const old = list.find(x => x.id === id);
    const next = input ? normalize(input) : null;
    if (input && !next) throw Error('Повреждена облачная запись.');
    if (next && kind === 'transcript') next.source = old?.source || '';
    const updated = list.filter(x => x.id !== id);
    if (next) updated.push(next);
    if (kind === 'prompt') {
      const data = { ...this.data, prompts: updated }; await this.write({ data }); this.data = data;
    } else if (kind === 'transcript') {
      await fsp.mkdir(this.transcriptsRoot, { recursive: true });
      if (next) await writeJson(this.transcriptPath(id), { format: 'snowball-transcript', version: 1, ...next });
      else if (old) await this.trash(this.transcriptPath(id));
      this.transcripts = updated;
    } else {
      const spec = { task: [this.tasksPath, this.tasksFile(updated)], event: [this.calendarPath, { format: 'snowball-calendar', version: 1, events: updated }],
        chat: [this.chatsPath, { format: 'snowball-chats', version: 1, chats: updated }], skill: [this.skillsPath, { format: 'snowball-skills', version: 1, skills: updated }] }[kind];
      await writeProtectedJson(spec[0], spec[1]); this[prop] = updated;
    }
    // Attachments survive cloud deletion on this device for recovery; no recursive file removal here.
  }

  async write(opts) {
    const data = opts && opts.data ? opts.data : this.data;
    data.updatedAt = Date.now();
    const json = JSON.stringify(data, null, 2);
    const tmp = this.dataPath + '.tmp';
    await fsp.writeFile(tmp, json, 'utf8');
    try {
      if (!(opts && opts.skipBackup)) {
        try { await copyBackup(this.dataPath, this.backupPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      }
      await retry(() => fsp.rename(tmp, this.dataPath));
    } catch (e) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw e;
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
        return { id: f.id, name: f.name, size: f.size, kind: f.kind, addedAt: f.addedAt, available: fs.existsSync(abs), url: pathToFileURL(abs).href };
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
          await fsp.copyFile(src.path, path.join(dir, stored), fs.constants.COPYFILE_EXCL);
          size = st.size;
          name = stored;
        } else if (src && src.data) {
          const buf = Buffer.from(src.data.buffer ? new Uint8Array(src.data.buffer, src.data.byteOffset || 0, src.data.byteLength) : src.data);
          name = sanitizeName(src.name || 'картинка.png');
          const stored = await uniqueTarget(dir, name);
          await fsp.writeFile(path.join(dir, stored), buf, { flag: 'wx' });
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

  // Write the new record before discarding old attachments. Failed saves restore the in-memory record and
  // remove only the new files copied by this attempt, so another window cannot see an unsaved edit.
  async commitPrompt(previous, next, created) {
    const index = previous ? this.data.prompts.indexOf(previous) : this.data.prompts.length;
    const data = Object.assign({}, this.data, { prompts: this.data.prompts.slice() });
    if (previous) data.prompts[index] = next; else data.prompts.push(next);
    try { await this.write({ data }); }
    catch (e) {
      for (const file of created || []) await fsp.rm(path.join(this.promptDir(next.id), file.stored), { force: true }).catch(() => {});
      throw e;
    }
    this.data = data;
  }
  async removeCommittedFiles(prompt, ids) {
    try { await this.removeFiles(prompt, ids); }
    catch (e) { console.error('Could not remove an old prompt attachment', e.code); }
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
      const previous = item.id ? this.find(item.id) : null;
      if (input && typeof input.expected === 'string') {
        const current = previous && JSON.stringify([previous.title, previous.type, previous.text, previous.comment, previous.files.map((f) => f.id)]);
        if (current !== input.expected) {
          const e = new Error('prompt changed while editing');
          e.userMessage = 'Промт изменили в другом окне. Ваш текст остался в редакторе: скопируйте его, затем откройте промт заново.';
          throw e;
        }
      }
      const now = Date.now();
      const isNew = !previous;
      let prompt;
      if (previous) prompt = Object.assign({}, previous, { files: previous.files.slice() });
      else {
        prompt = normalizePrompt({ id: item.id, createdAt: now, updatedAt: now });
        if (this.find(prompt.id)) prompt.id = newId('p');
      }
      const sig = () => JSON.stringify([prompt.title, prompt.type, prompt.text, prompt.comment, prompt.files.map((f) => f.id)]);
      const before = sig();
      prompt.title = str(item.title, 300).trim();
      prompt.type = str(item.type, 60).trim();
      prompt.text = str(item.text, 2000000);
      prompt.comment = str(item.comment, 100000);
      const removed = Array.isArray(input && input.removeFileIds) ? input.removeFileIds : [];
      const removedIds = new Set(removed);
      prompt.files = prompt.files.filter((f) => !removedIds.has(f.id));
      const kept = prompt.files.length;
      await this.copyIn(prompt, input && input.addFiles, errors);
      // "Сохранить" without real changes keeps the date and does not count as an edit.
      const changed = isNew || before !== sig();
      if (!changed) return { id: prompt.id, errors };
      prompt.updatedAt = now;
      await this.commitPrompt(previous, prompt, prompt.files.slice(kept));
      if (previous && removed.length) await this.removeCommittedFiles(Object.assign({}, previous, { files: previous.files.slice() }), removed);
      await this.bump(isNew ? 'created' : 'edited', 1);
      await this.bump('files', prompt.files.length - kept);
      return { id: prompt.id, errors };
    });
  }

  addFiles(promptId, sources) {
    return this.run(async () => {
      const previous = this.find(promptId);
      if (!previous) throw new Error('Промт не найден');
      const prompt = Object.assign({}, previous, { files: previous.files.slice() });
      const errors = [];
      const before = prompt.files.length;
      await this.copyIn(prompt, sources, errors);
      if (prompt.files.length !== before) {
        prompt.updatedAt = Date.now();
        await this.commitPrompt(previous, prompt, prompt.files.slice(before));
        await this.bump('files', prompt.files.length - before);
      }
      return { added: prompt.files.length - before, errors };
    });
  }

  removeFile(promptId, fileId) {
    return this.run(async () => {
      const previous = this.find(promptId);
      if (!previous) return;
      const prompt = Object.assign({}, previous, { files: previous.files.filter((f) => f.id !== fileId) });
      prompt.updatedAt = Date.now();
      await this.commitPrompt(previous, prompt, []);
      await this.removeCommittedFiles(Object.assign({}, previous, { files: previous.files.slice() }), [fileId]);
    });
  }

  deletePrompt(id) {
    return this.run(async () => {
      const prompt = this.find(id);
      if (!prompt) return;
      const data = Object.assign({}, this.data, { prompts: this.data.prompts.filter((p) => p.id !== id) });
      await this.write({ data });
      this.data = data;
      const dir = this.promptDir(id);
      if (await exists(dir)) { try { await this.trash(dir); } catch (e) { /* the record is gone; leftover files are harmless */ } }
    });
  }

  // importJson reads the prompt lists saved by versions before 1.9 (prompts only, no files).
  importJson(raw) {
    return this.run(async () => {
      const incoming = parseData(raw).prompts;
      let added = 0;
      let skipped = 0;
      const sig = (p) => p.title.trim().toLowerCase() + '\u0000' + p.text.trim();
      const known = new Set(this.data.prompts.map(sig));
      const ids = new Set(this.data.prompts.map((p) => p.id));
      const data = Object.assign({}, this.data, { prompts: this.data.prompts.slice() });
      for (const p of incoming) {
        if (!p.title && !p.text) { skipped++; continue; }
        if (ids.has(p.id) || known.has(sig(p))) { skipped++; continue; }
        p.files = []; // attachments are not part of an export file
        data.prompts.push(p);
        ids.add(p.id);
        known.add(sig(p));
        added++;
      }
      if (added) { await this.write({ data }); this.data = data; }
      return { added, skipped };
    });
  }

  /* ---------- backup (.snowball) and shared prompts (.snowprompt) ---------- */
  // Both are zip archives (archive.js) with prompts.json and files/<prompt id>/<file>. A backup also carries
  // chats.json, calendar.json, tasks.json, activity.json, profile.json and avatar.png. ids: the prompts to share, or null for all.
  packEntries(kind, ids) {
    const chosen = ids ? this.data.prompts.filter((p) => ids.includes(p.id)) : this.data.prompts;
    const entries = [], missing = [];
    const prompts = chosen.map((p) => {
      const files = p.files.filter((f) => {
        const present = fs.existsSync(path.join(this.promptDir(p.id), f.stored));
        if (!present) missing.push('Промт «' + (p.title || 'Без названия') + '»: ' + f.name);
        return present;
      });
      files.forEach((f) => entries.push({ name: 'files/' + p.id + '/' + f.stored, file: path.join(this.promptDir(p.id), f.stored) }));
      return Object.assign({}, p, { files });
    });
    const counts = { prompts: prompts.length, files: entries.length, chats: 0, events: 0, tasks: 0 };
    entries.unshift({ name: 'prompts.json', data: JSON.stringify({ format: FORMAT, version: 1, prompts }, null, 2) });
    if (kind === 'backup') {
      entries.push({ name: CHATS_FILE, data: JSON.stringify({ format: 'snowball-chats', version: 1, chats: this.chats }, null, 2) });
      this.chats.forEach((c) => c.messages.forEach((m) => (m.images || []).forEach((im) => {
        const file = this.chatImagePath(c.id, im.stored);
        if (file && fs.existsSync(file)) entries.push({ name: 'chatfiles/' + c.id + '/' + im.stored, file });
        else missing.push('Разговор «' + c.title + '»: ' + im.name);
      })));
      entries.push({ name: CALENDAR_FILE, data: JSON.stringify({ format: 'snowball-calendar', version: 1, events: this.events }, null, 2) });
      entries.push({ name: TASKS_FILE, data: JSON.stringify(this.tasksFile(), null, 2) });
      entries.push({ name: ACTIVITY_FILE, data: JSON.stringify(this.activity, null, 2) });
      entries.push({ name: PROFILE_FILE, data: JSON.stringify(this.profile, null, 2) });
      const avatar = this.profileAvatarPath(this.profile);
      if (this.profile.avatarAt && fs.existsSync(avatar)) entries.push({ name: AVATAR_FILE, file: avatar });
      else if (this.profile.avatarAt) missing.push('Аватар профиля');
      this.transcripts.forEach((t) => entries.push({ name: 'transcripts/' + t.id + '.json', data: JSON.stringify(Object.assign({ format: 'snowball-transcript', version: 1 }, t)) }));
      counts.chats = this.chats.length;
      counts.events = this.events.length;
      counts.tasks = this.tasks.length;
      counts.transcripts = this.transcripts.length;
      // Skills: the list and each skill's file as it was, in skills/<id>/.
      entries.push({ name: SKILLS_FILE, data: JSON.stringify({ format: 'snowball-skills', version: 1, skills: this.skills }, null, 2) });
      this.skills.forEach((s) => {
        const file = path.join(this.skillDir(s.id), s.file.stored);
        if (fs.existsSync(file)) entries.push({ name: 'skills/' + s.id + '/' + s.file.stored, file });
        else missing.push('Скилл «' + s.title + '»: ' + s.file.name);
      });
      counts.skills = this.skills.length;
    }
    return { entries, counts, missing };
  }

  // Brings in what an unpacked archive (dir) holds without changing or removing anything already here.
  // 'backup': prompts, chats and events keep their ids and dates; those already here (same id) stay as they are.
  // 'share': prompts from someone else get new ids and today's date; one with the same title and text as here is skipped.
  mergeFrom(dir, kind) {
    return this.run(async () => {
      const res = { prompts: 0, files: 0, skipped: 0, chats: 0, events: 0, tasks: 0, transcripts: 0 };
      let incoming;
      try { incoming = parseData(await fsp.readFile(path.join(dir, 'prompts.json'), 'utf8')).prompts; }
      catch (e) { throw Object.assign(new Error('invalid archive prompts'), { userMessage: 'Не удалось прочитать список промтов в архиве. Проверьте, что файл копии не повреждён.' }); }
      const sig = (p) => p.title.trim().toLowerCase() + '\u0000' + p.text.trim();
      const known = new Set(this.data.prompts.map(sig));
      const ids = new Set(this.data.prompts.map((p) => p.id));
      const data = Object.assign({}, this.data, { prompts: this.data.prompts.slice() });
      const copied = [];
      const now = Date.now();
      try {
        for (const p of incoming) {
          if (!p.title && !p.text) { res.skipped++; continue; }
          if (kind === 'backup' ? ids.has(p.id) : known.has(sig(p))) { res.skipped++; continue; }
          const src = path.join(dir, 'files', p.id);   // the folder the files were packed under
          const prompt = Object.assign({}, p, { files: [] });
          if (kind === 'share' || ids.has(prompt.id)) prompt.id = newId('p');
          if (kind === 'share') { prompt.createdAt = now; prompt.updatedAt = now; }
          for (const f of p.files) {
            const from = path.join(src, f.stored);
            if (!(await exists(from))) throw missingArchiveAttachment();
            const target = this.promptDir(prompt.id);
            await fsp.mkdir(target, { recursive: true });
            const stored = await uniqueTarget(target, sanitizeName(f.stored));
            const destination = path.join(target, stored);
            await fsp.copyFile(from, destination, fs.constants.COPYFILE_EXCL);
            copied.push(destination);
            prompt.files.push({ id: f.id, name: f.name, stored, size: f.size, kind: kindOf(stored), addedAt: f.addedAt || now });
            res.files++;
          }
          data.prompts.push(prompt);
          ids.add(prompt.id);
          known.add(sig(prompt));
          res.prompts++;
        }
        if (res.prompts) { await this.write({ data }); this.data = data; }
      } catch (e) {
        for (const file of copied) await fsp.rm(file, { force: true }).catch(() => {});
        throw e;
      }
      if (kind !== 'backup') return res;

      // Each imported list becomes visible only after its own file is saved.
      const draft = Object.create(this);
      draft.chats = this.chats.slice();
      const chats = await readArchiveList(path.join(dir, CHATS_FILE), 'chats');
      for (const c of (chats && Array.isArray(chats.chats) ? chats.chats : []).map(normalizeChat).filter(Boolean)) {
        if (draft.getChat(c.id)) continue;
        draft.chats.push(c);
        res.chats++;
        for (const m of c.messages) {
          for (const im of m.images || []) {
            const from = path.join(dir, 'chatfiles', c.id, im.stored);
            if (!(await exists(from))) throw missingArchiveAttachment();
            await fsp.mkdir(this.chatFilesDir(c.id), { recursive: true });
            await copyImportedFixed(from, this.chatImagePath(c.id, im.stored));
          }
        }
      }
      if (res.chats) { await draft.writeChats(); this.chats = draft.chats; }
      draft.events = this.events.slice();
      const cal = await readArchiveList(path.join(dir, CALENDAR_FILE), 'events');
      (cal && Array.isArray(cal.events) ? cal.events : []).map((e) => normalizeEvent(e)).filter(Boolean).forEach((e) => {
        if (draft.findEvent(e.id)) return;
        draft.events.push(e);
        res.events++;
      });
      if (res.events) { await draft.writeCalendar(); this.events = draft.events; }
      draft.columns = this.columns.slice();
      draft.tasks = this.tasks.slice();
      draft.taskGroups = structuredClone(this.taskGroups);
      const tasks = await readArchiveList(path.join(dir, TASKS_FILE), 'tasks');
      let newGroups = 0;
      for (const group of normalizeTaskGroups(tasks?.groups)) {
        if (!draft.taskGroups.some(g => g.id === group.id)) { draft.taskGroups.push(group); newGroups++; }
      }
      // The backup's own columns come along when there is room for them.
      let newColumns = 0;
      (tasks && Array.isArray(tasks.columns) ? tasks.columns : []).map(normalizeColumn).filter(Boolean).forEach((c) => {
        if (!draft.columns.some((x) => x.id === c.id) && draft.columns.length < COLUMN_MAX) { draft.columns.push(c); newColumns++; }
      });
      (tasks && Array.isArray(tasks.tasks) ? tasks.tasks : []).map((t) => draft.fitColumn(normalizeTask(t))).filter(Boolean).forEach((t) => {
        if (draft.findTask(t.id)) return;
        draft.tasks.push(t);
        res.tasks++;
      });
      if (res.tasks || newColumns || newGroups) { await draft.writeTasks(); this.columns = draft.columns; this.taskGroups = draft.taskGroups; this.tasks = draft.tasks; }
      // Transcriptions come by id, like chats; the ones already here stay as they are.
      for (const t of await readTranscripts(path.join(dir, 'transcripts'))) {
        if (this.getTranscript(t.id)) continue;
        await fsp.mkdir(this.transcriptsRoot, { recursive: true });
        await this.checkTranscriptPathFree(t.id);
        await writeJson(this.transcriptPath(t.id), Object.assign({ format: 'snowball-transcript', version: 1 }, t));
        this.transcripts.push(t);
        res.transcripts++;
      }
      // Skills come by id too, each with its file. A missing file means the archive is incomplete.
      const skills = await readArchiveList(path.join(dir, SKILLS_FILE), 'skills');
      draft.skills = this.skills.slice();
      res.skills = 0;
      for (const s of (skills && Array.isArray(skills.skills) ? skills.skills : []).map(normalizeSkill).filter(Boolean)) {
        if (draft.findSkill(s.id)) continue;
        const from = path.join(dir, 'skills', s.id, s.file.stored);
        if (!(await exists(from))) throw missingArchiveAttachment();
        await fsp.mkdir(this.skillDir(s.id), { recursive: true });
        await copyImportedFixed(from, path.join(this.skillDir(s.id), s.file.stored));
        draft.skills.push(s);
        res.skills++;
      }
      if (res.skills) { await draft.writeSkills(); this.skills = draft.skills; }
      // Statistics: for each day and kind the larger number, so restoring the same backup twice does not double it.
      const act = await readJson(path.join(dir, ACTIVITY_FILE));
      if (act) {
        const a = normalizeActivity(act);
        Object.keys(a.days).forEach((k) => {
          const day = this.activity.days[k] || (this.activity.days[k] = {});
          ACTIONS.forEach((n) => { if ((a.days[k][n] || 0) > (day[n] || 0)) day[n] = a.days[k][n]; });
        });
        if (a.since && (!this.activity.since || a.since < this.activity.since)) this.activity.since = a.since;
        try { await writeJson(this.activityPath, this.activity); } catch (e) { /* statistics are a convenience */ }
      }
      // Profile: only fills what is empty here (a fresh install has no nickname and no avatar).
      const prof = await readArchiveObject(path.join(dir, PROFILE_FILE));
      const pr = Object.assign({}, this.profile);
      let profChanged = false;
      if (prof && !pr.name && normalizeProfile(prof).name) { pr.name = normalizeProfile(prof).name; pr.welcomed = true; profChanged = true; }
      let createdAvatar = '';
      const sourceAvatar = path.join(dir, AVATAR_FILE);
      const hasAvatar = await exists(sourceAvatar);
      if (!pr.avatarAt && prof && normalizeProfile(prof).avatarAt && !hasAvatar) throw missingArchiveAttachment();
      if (!pr.avatarAt && hasAvatar) {
        createdAvatar = await this.createProfileAvatar(sourceAvatar);
        pr.avatarFile = createdAvatar;
        pr.avatarAt = Date.now();
        pr.welcomed = true;
        profChanged = true;
      }
      if (profChanged) {
        let backupUpdated;
        try { backupUpdated = await writeProtectedJson(this.profilePath, pr); }
        catch (e) { if (createdAvatar) await fsp.rm(path.join(this.dir, createdAvatar), { force: true }).catch(() => {}); throw e; }
        this.profile = pr;
        res.profile = true;
        if (!backupUpdated) res.profileBackupWarning = true;
      }
      return res;
    });
  }
}

async function copyDataFile(from, to) {
  try { await copyImportedFixed(from, to); }
  catch (e) {
    if (e.message === 'import attachment already exists') e.userMessage = 'В выбранной папке уже есть другой файл «' + path.basename(to) + '». Он оставлен без изменений; выберите пустую папку или уберите конфликтующий файл.';
    throw e;
  }
}
async function dataPathExists(file) {
  try { await fsp.lstat(file); return true; }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
function dataFolderConflict(name) {
  const e = new Error('data folder conflict');
  e.userMessage = 'В выбранной папке уже есть другой файл или ссылка «' + name + '». Ничего не перезаписано; выберите другую папку.';
  return e;
}
async function copyDataTree(from, to) {
  const source = await fsp.lstat(from);
  if (source.isDirectory()) {
    try { await fsp.mkdir(to); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const destination = await fsp.lstat(to);
      if (!destination.isDirectory()) throw dataFolderConflict(path.basename(to));
    }
    for (const name of await fsp.readdir(from)) await copyDataTree(path.join(from, name), path.join(to, name));
    return;
  }
  if (source.isFile()) { await copyDataFile(from, to); return; }
  if (source.isSymbolicLink()) {
    let destination = null;
    try { destination = await fsp.lstat(to); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (destination) {
      if (destination.isSymbolicLink() && await fsp.readlink(from) === await fsp.readlink(to)) return;
      throw dataFolderConflict(path.basename(to));
    }
    await fsp.cp(from, to, { recursive: true, dereference: false, verbatimSymlinks: true, force: false, errorOnExist: true });
    return;
  }
  throw dataFolderConflict(path.basename(to));
}
function pathIsInside(parent, child) {
  const relative = path.relative(parent, child);
  return !relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

// Copies the data into another folder without overwriting files already there.
async function copyDataTo(fromDir, toDir) {
  await fsp.mkdir(toDir, { recursive: true });
  const sourceRoot = await fsp.realpath(fromDir), targetRoot = await fsp.realpath(toDir);
  if (!path.relative(sourceRoot, targetRoot)) throw dataFolderConflict(path.basename(toDir));
  const folders = [FILES_DIR, CHAT_FILES_DIR, TRANSCRIPTS_DIR, SKILLS_DIR, 'Снимки', '.cloud-sync'];
  for (const name of folders) {
    let source;
    try { source = await fsp.realpath(path.join(fromDir, name)); }
    catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (pathIsInside(source, targetRoot)) {
      const e = new Error('destination inside data folder');
      e.userMessage = 'Нельзя выбрать папку внутри файлов самой программы. Выберите другую папку.';
      throw e;
    }
  }
  for (const name of [BACKUP_FILE, PROFILE_FILE, extraBackupPath(PROFILE_FILE), AVATAR_FILE, ACTIVITY_FILE, CHATS_FILE, CALENDAR_FILE, TASKS_FILE, SKILLS_FILE,
    ...[CHATS_FILE, CALENDAR_FILE, TASKS_FILE, SKILLS_FILE].map(extraBackupPath)]) {
    if (await dataPathExists(path.join(fromDir, name))) await copyDataFile(path.join(fromDir, name), path.join(toDir, name));
  }
  const avatarNames = new Set();
  for (const name of [PROFILE_FILE, extraBackupPath(PROFILE_FILE)]) {
    const raw = await readJson(path.join(fromDir, name));
    const profile = normalizeProfile(raw);
    if (profile.avatarAt && profile.avatarFile) avatarNames.add(profile.avatarFile);
  }
  for (const name of avatarNames) {
    const source = path.join(fromDir, name);
    if (!(await dataPathExists(source))) throw Object.assign(new Error('missing profile avatar'), { userMessage: 'Не удалось перенести профиль: файл аватарки недоступен. Исходная папка не изменена.' });
    await copyDataFile(source, path.join(toDir, name));
  }
  for (const name of folders) {
    const source = path.join(fromDir, name);
    if (await dataPathExists(source)) await copyDataTree(source, path.join(toDir, name));
  }
  // The presence of prompts.json marks the destination as a usable data folder: publish it last.
  await copyDataFile(path.join(fromDir, DATA_FILE), path.join(toDir, DATA_FILE));
}

async function hasData(dir) { return exists(path.join(dir, DATA_FILE)); }

module.exports = { Store, copyDataTo, hasData, sanitizeName, kindOf, parseData, dayKey, normalizeEvent, normalizeTask, TASK_STATUSES, DATA_FILE, FILES_DIR, NAME_MAX,
  SKILL_TYPES, skillKind, readSkillFile, skillTitle };
