// A separate test program, not part of Snowball.ai: records the microphone and the computer sound into two files
// and turns them into text with several OpenAI models, to check how recording calls will work.
// Run: npx.cmd electron tools/record-test/main.js
// --selftest plays a short tone, records 4 seconds, prints what got into both files and quits.
// --selftest-tr transcribes the newest recording with every model, prints the result and quits
// (with OPENAI_BASE_URL pointing at a fake server it costs nothing).
const { app, BrowserWindow, ipcMain, session, desktopCapturer, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai').default;
const { toFile } = require('openai');

app.setName('Snowball record test');
const SELFTEST = process.argv.includes('--selftest');
const SELFTEST_TR = process.argv.includes('--selftest-tr');
const TRACKS = { mic: 'микрофон.webm', sys: 'звук компьютера.webm' };
let win = null;
let dir = null;

function base() { return path.join(app.getPath('documents'), 'Snowball.ai — проверка записи'); }
function stamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => callback(permission === 'media'));
  // getDisplayMedia in the window gets the whole screen plus 'loopback': everything Windows plays through the speakers.
  // The window throws the picture away at once and keeps only the sound.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] })
      .then(sources => callback({ video: sources[0], audio: 'loopback' }))
      .catch(() => callback({}));
  });

  win = new BrowserWindow({
    width: 760, height: 900, title: 'Проверка записи созвона', autoHideMenuBar: true, backgroundColor: '#FCEEE4',
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  });
  const fileArg = process.argv.find(a => a.startsWith('--selftest-file='));
  const query = SELFTEST ? { selftest: '1' } : SELFTEST_TR ? { selftestTr: '1' } : process.argv.includes('--selftest-vad') ? { selftestVad: '1' } :
    process.argv.includes('--selftest-sum') ? { selftestSum: '1' } : fileArg ? { selftestFile: fileArg.slice('--selftest-file='.length) } : {};
  win.loadFile(path.join(__dirname, 'index.html'), { query });
});

/* ---------- step 1: recording ---------- */
// Each recording goes to its own folder; pieces are appended every few seconds, so nothing is lost if the program crashes.
ipcMain.handle('rec-start', () => {
  dir = path.join(base(), stamp());
  fs.mkdirSync(dir, { recursive: true });
  for (const name of Object.values(TRACKS)) fs.writeFileSync(path.join(dir, name), Buffer.alloc(0));
  return dir;
});
ipcMain.handle('rec-append', (e, name, data) => {
  if (!dir || !Object.values(TRACKS).includes(name)) return;
  fs.appendFileSync(path.join(dir, name), Buffer.from(data));
});
ipcMain.handle('rec-files', () => {
  if (!dir) return [];
  return Object.values(TRACKS).map(name => {
    const file = path.join(dir, name);
    return { name, file, size: fs.statSync(file).size };
  });
});
ipcMain.handle('open-folder', (e, which) => { const d = which ? inBase(which) : dir; if (d) shell.openPath(d); });

/* ---------- step 2: turning the recordings into text ---------- */
// Recordings, newest first. Only folders inside the test folder that have both tracks.
ipcMain.handle('rec-list', () => {
  let names = [];
  try { names = fs.readdirSync(base()); } catch (e) { return []; }
  return names.map(name => {
    const d = path.join(base(), name);
    try {
      const sizes = Object.values(TRACKS).map(t => fs.statSync(path.join(d, t)).size);
      return { name, kb: Math.round((sizes[0] + sizes[1]) / 1024) };
    } catch (e) { return null; }
  }).filter(Boolean).sort((a, b) => b.name.localeCompare(a.name));
});
function inBase(name) {
  const d = path.resolve(base(), String(name));
  return path.dirname(d) === base() ? d : null;
}

// What each model gives back. Only some return the time of every phrase; with it the two tracks become one dialog.
const MODELS = {
  'gpt-transcribe': { format: 'json' },
  'gpt-4o-transcribe': { format: 'json' },
  'gpt-4o-mini-transcribe': { format: 'json' },
  'gpt-4o-transcribe-diarize': { format: 'diarized_json', chunking: 'auto' },
  'whisper-1': { format: 'verbose_json', granularity: ['segment'] }
};
const MAX_FILE = 25 * 1024 * 1024; // OpenAI takes files up to 25 MB

function errorText(e) {
  const s = e && e.status;
  if (s === 401) return 'Ключ не подошёл (401). Проверьте, что вставлен ключ ChatGPT целиком.';
  if (s === 403) return 'Нет доступа к этой модели или страна не поддерживается (403).';
  if (s === 404) return 'Такой модели нет или нет к ней доступа (404).';
  if (s === 429) return /quota|billing|credit/i.test(e.code || '') ? 'На счёте OpenAI нет денег (429).' : 'Слишком много запросов, попробуйте через минуту (429).';
  if (s === 400) return 'OpenAI не принял запрос (400): ' + String((e.error && e.error.message) || '').slice(0, 200);
  if (s >= 500) return 'У OpenAI сбой (' + s + '), попробуйте позже.';
  if (e && /fetch|ECONN|ENOTFOUND|network|timed out/i.test(String(e.message))) return 'Нет связи с OpenAI. Проверьте интернет.';
  return 'Ошибка: ' + String(e && e.message || e).slice(0, 200);
}

async function transcribeTrack(client, model, file) {
  const m = MODELS[model];
  const buf = fs.readFileSync(file);
  if (buf.length > MAX_FILE) throw new Error('Файл больше 25 МБ — такую запись придётся резать на куски');
  if (!buf.length) return { text: '', segments: [], ms: 0 };
  const t0 = Date.now();
  const body = { file: await toFile(buf, 'track.webm', { type: 'audio/webm' }), model, response_format: m.format, language: 'ru' };
  if (m.chunking) body.chunking_strategy = m.chunking;
  if (m.granularity) body.timestamp_granularities = m.granularity;
  let r, noLang = false;
  try { r = await client.audio.transcriptions.create(body); } catch (e) {
    // If a model does not take the language hint, try once more without it and say so in the result.
    if (e.status !== 400 || !/language/i.test(String(e.error && e.error.message || e.message))) throw e;
    delete body.language; noLang = true;
    body.file = await toFile(buf, 'track.webm', { type: 'audio/webm' });
    r = await client.audio.transcriptions.create(body);
  }
  const segments = (r.segments || []).map(s => ({ start: s.start, end: s.end, text: String(s.text || '').trim() })).filter(s => s.text);
  return { text: String(r.text || '').trim(), segments, usage: r.usage || null, ms: Date.now() - t0, noLang };
}

// Puts the phrases of both tracks in time order: «Вы» is the microphone, «Собеседник» is the computer sound.
function byTime(mic, sys) {
  if (!mic.segments.length && !sys.segments.length) return null;
  return mic.segments.map(s => ({ start: s.start, who: 'Вы', text: s.text }))
    .concat(sys.segments.map(s => ({ start: s.start, who: 'Собеседник', text: s.text })))
    .sort((a, b) => a.start - b.start);
}
function mmss(sec) { const s = Math.floor(sec); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); }
function usageText(u) {
  if (!u) return 'OpenAI не сообщил';
  if (u.type === 'duration') return Math.round(u.seconds) + ' с звука';
  if (u.type === 'tokens') return u.input_tokens + ' входных + ' + u.output_tokens + ' выходных токенов';
  return JSON.stringify(u);
}

// maxRetries as in the program: on 429, 5xx and a broken connection the SDK tries twice more by itself.
let cached = null;
function clientFor(key) {
  key = String(key || process.env.OPENAI_API_KEY || '').trim();
  if (!key) return { error: 'Вставьте ключ ChatGPT (OpenAI)' };
  if (/^sk-ant-/.test(key)) return { error: 'Это ключ Claude, а нужен ключ ChatGPT (OpenAI)' };
  if (!cached || cached.key !== key) cached = { key, client: new OpenAI({ apiKey: key, maxRetries: 2, timeout: 10 * 60 * 1000 }) };
  return { client: cached.client };
}

ipcMain.handle('transcribe', async (e, name, key, models) => {
  const d = inBase(name);
  if (!d) return { error: 'Не нашёл эту запись' };
  const { client, error } = clientFor(key);
  if (error) return { error };
  const results = [];
  for (const model of models.filter(m => MODELS[m])) {
    e.sender.send('tr-progress', model);
    const res = { model };
    try {
      const [mic, sys] = await Promise.all([transcribeTrack(client, model, path.join(d, TRACKS.mic)), transcribeTrack(client, model, path.join(d, TRACKS.sys))]);
      Object.assign(res, { mic, sys, dialog: byTime(mic, sys) });
    } catch (err) {
      // Only the code goes to the console: the text of a service error may contain a piece of the key.
      console.log('transcribe failed:', model, err && err.status);
      res.error = errorText(err);
    }
    results.push(res);
  }
  return { results };
});

/* ---------- «своя нарезка»: the window cuts the tracks at pauses, each piece goes here ---------- */
ipcMain.handle('read-track', (e, name, track) => {
  const d = inBase(name);
  if (!d || !TRACKS[track]) return null;
  const buf = fs.readFileSync(path.join(d, TRACKS[track]));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
});
// One piece of speech (a WAV made by the window) → text. The prompt carries what was said just before,
// so a short piece does not lose its meaning.
const PIECE_MODELS = ['gpt-4o-mini-transcribe', 'gpt-transcribe', 'gpt-4o-transcribe'];
ipcMain.handle('transcribe-piece', async (e, key, wav, prompt, model) => {
  const { client, error } = clientFor(key);
  if (error) return { error };
  try {
    const body = { file: await toFile(Buffer.from(wav), 'piece.wav', { type: 'audio/wav' }), model: PIECE_MODELS.includes(model) ? model : PIECE_MODELS[0], response_format: 'json', language: 'ru' };
    if (prompt) body.prompt = String(prompt).slice(-800);
    const r = await client.audio.transcriptions.create(body);
    return { text: String(r.text || '').trim(), usage: r.usage || null };
  } catch (err) {
    console.log('piece failed:', err && err.status);
    return { error: errorText(err) };
  }
});

ipcMain.handle('save-report', (e, name, results) => {
  const d = inBase(name);
  if (!d) return;
  fs.writeFileSync(path.join(d, 'расшифровка.md'), report(name, results));
  // The conversation by time from «своя нарезка» (or diarize) is what step 3 makes the summary from.
  const best = results.find(r => r.model.startsWith('своя нарезка') && r.dialog) || results.find(r => r.dialog);
  if (best) fs.writeFileSync(path.join(d, 'разговор.json'), JSON.stringify({ source: best.model, lines: best.dialog.map(l => ({ start: l.start, who: l.who, text: l.text })) }, null, 2));
});

/* ---------- a file: text from an audio or video file ---------- */
const MEDIA = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'webm', 'mp4', 'mov', 'mkv', 'avi', 'm4v', '3gp'];
const MAX_MEDIA = 2 * 1024 * 1024 * 1024; // the window keeps the whole file in memory while it takes the sound out
function mediaInfo(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!MEDIA.includes(ext)) return { error: 'Такой файл не подходит: нужен звук или видео (' + MEDIA.join(', ') + ')' };
  let size;
  try { size = fs.statSync(file).size; } catch (e) { return { error: 'Не открылся файл' }; }
  if (size > MAX_MEDIA) return { error: 'Файл больше 2 ГБ — для проверки возьмите покороче' };
  return { file, name: path.basename(file), size };
}
ipcMain.handle('pick-file', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Аудио или видео для расшифровки', properties: ['openFile'], filters: [{ name: 'Аудио и видео', extensions: MEDIA }] });
  return r.canceled || !r.filePaths[0] ? null : mediaInfo(r.filePaths[0]);
});
ipcMain.handle('media-info', (e, file) => mediaInfo(String(file || '')));
let mediaFile = null; // only the file the user picked can be read
ipcMain.handle('read-media', (e, file) => {
  const info = mediaInfo(String(file || ''));
  if (info.error) return info;
  mediaFile = info.file;
  const buf = fs.readFileSync(info.file);
  return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) };
});
// Results go to a folder next to the recordings: «Файл · <name> · <time>», with the text, timings and subtitles.
ipcMain.handle('save-media-text', (e, out) => {
  if (!mediaFile) return null;
  const name = ('Файл · ' + path.parse(mediaFile).name).replace(/[<>:"/\\|?*]/g, '_').slice(0, 80) + ' · ' + stamp();
  const d = path.join(base(), name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'текст.txt'), String(out.text || ''));
  fs.writeFileSync(path.join(d, 'тайминги.txt'), String(out.timings || ''));
  fs.writeFileSync(path.join(d, 'субтитры.srt'), String(out.srt || ''));
  fs.writeFileSync(path.join(d, 'сведения.txt'), 'Файл: ' + mediaFile + '\n' + String(out.info || '') + '\n');
  return name;
});

/* ---------- step 3: the summary of the call ---------- */
// The conversation of a recording: разговор.json, or, for recordings transcribed before it existed,
// the «Разговор по времени» part of расшифровка.md (своя нарезка first, then diarize).
function readDialog(d) {
  try { return JSON.parse(fs.readFileSync(path.join(d, 'разговор.json'), 'utf8')); } catch (e) { /* older recording */ }
  let md = '';
  try { md = fs.readFileSync(path.join(d, 'расшифровка.md'), 'utf8'); } catch (e) { return null; }
  const blocks = md.split(/^## /m).slice(1);
  const block = blocks.find(b => b.startsWith('своя нарезка')) || blocks.find(b => /### Разговор по времени/.test(b));
  if (!block) return null;
  const lines = [];
  for (const m of block.matchAll(/^- (\d+):(\d\d) \*\*(Вы|Собеседник):\*\* (.*)$/gm)) lines.push({ start: +m[1] * 60 + +m[2], who: m[3], text: m[4] });
  return lines.length ? { source: block.split('\n')[0].trim(), lines } : null;
}
ipcMain.handle('dialog-info', (e, name) => {
  const d = inBase(name), dl = d && readDialog(d);
  return dl ? { source: dl.source, lines: dl.lines.length } : null;
});

// Prices per million tokens, the same as PRICES in Snowball's main.js.
const PRICES = {
  'gpt-6.1-sol': { input: 2, cached: 0.10, output: 10 },
  'gpt-6-luna': { input: 0.10, cached: 0.10, output: 0.50 },
  'gpt-6-astra': { input: 10, cached: 10, output: 50 }
};
const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const p2 = n => String(n).padStart(2, '0');
// The recording folder is named by the moment the recording started: «2026-10-26 01-49-08».
function callDate(name) {
  const m = String(name).match(/^(\d{4})-(\d\d)-(\d\d) (\d\d)-(\d\d)/);
  return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5]) : new Date();
}
function whenLine(d) {
  return WEEKDAYS[d.getDay()] + ', ' + d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear() + ' года, ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) +
    ' (дата: ' + d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ')';
}

const SUMMARY_PROMPT = [
  'Ты делаешь итоги созвона для программы Snowball.ai. Тебе дают расшифровку разговора по времени.',
  '«Вы» — это владелец программы (тот, для кого итоги). «Собеседник» — все остальные участники; если имя есть в названии дела или звучит в разговоре, называй собеседника по имени.',
  'Расшифровку делала программа распознавания речи: в ней бывают ошибки в словах, названиях и именах. Исправляй очевидные ошибки по смыслу (например, марку машины или название программы), но ничего не придумывай.',
  '',
  'Заполни четыре части:',
  '1. brief — кратко о главном: 2–4 простых предложения, о чём говорили и чем закончилось.',
  '2. decisions — что решили или о чём договорились. Только то, что в разговоре действительно решено, коротко, по одному решению на строку.',
  '3. steps — следующие шаги: кто что пообещал сделать. title — суть в 2–6 словах, с глагола («Сократить вступление до 10 секунд»). who: me — делает владелец, other — собеседник, both — вместе. name — имя того, кто делает, если оно известно, иначе null. due — срок датой YYYY-MM-DD, если он назван (считай от даты созвона: «завтра», «к пятнице»), иначе null. due_text — как срок сказан в разговоре («к пятнице») или null.',
  '4. meetings — новые созвоны или встречи, о которых договорились. title — коротко, как дело в календаре: имя и суть в 2–5 словах, без слов «созвон» и «встреча» («Дима, финальная версия»). date — YYYY-MM-DD, from и to — HH:MM или null, если не названы. when_text — как это сказано («завтра в пять»).',
  '',
  'Если чего-то в разговоре нет — оставь пустой список, не выдумывай шаги и встречи. Если это не разговор, а, например, запись видео, так и напиши в brief, а decisions, steps и meetings оставь пустыми.',
  'Пиши по-русски, просто и без канцелярита.'
].join('\n');

const SUMMARY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['brief', 'decisions', 'steps', 'meetings'],
  properties: {
    brief: { type: 'string' },
    decisions: { type: 'array', items: { type: 'string' } },
    steps: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title', 'who', 'name', 'due', 'due_text'], properties: {
      title: { type: 'string' }, who: { type: 'string', enum: ['me', 'other', 'both'] }, name: { type: ['string', 'null'] },
      due: { type: ['string', 'null'] }, due_text: { type: ['string', 'null'] } } } },
    meetings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title', 'date', 'from', 'to', 'when_text'], properties: {
      title: { type: 'string' }, date: { type: ['string', 'null'] }, from: { type: ['string', 'null'] }, to: { type: ['string', 'null'] }, when_text: { type: 'string' } } } }
  }
};

ipcMain.handle('summarize', async (e, name, key, opts) => {
  const d = inBase(name);
  if (!d) return { error: 'Не нашёл эту запись' };
  const dl = readDialog(d);
  if (!dl) return { error: 'У этой записи ещё нет разговора по времени. Сначала расшифруйте её в шаге 2 со «своей нарезкой».' };
  const { client, error } = clientFor(key);
  if (error) return { error };
  const model = PRICES[opts.model] ? opts.model : 'gpt-6.1-sol';
  const effort = ['low', 'medium', 'high'].includes(opts.effort) ? opts.effort : 'medium';
  const when = callDate(name);
  const title = String(opts.title || '').trim().slice(0, 200);
  const input = (title ? 'Дело в календаре: «' + title + '».\n' : 'Дела в календаре нет.\n') + 'Созвон был: ' + whenLine(when) + '.\n\nРасшифровка:\n' +
    dl.lines.map(l => mmss(l.start) + ' ' + l.who + ': ' + l.text).join('\n');
  const t0 = Date.now();
  try {
    const r = await client.responses.create({
      model, instructions: SUMMARY_PROMPT, input, reasoning: { effort }, max_output_tokens: 16000, store: false,
      text: { format: { type: 'json_schema', name: 'call_summary', strict: true, schema: SUMMARY_SCHEMA } }
    });
    if (r.status === 'incomplete') return { error: 'Ответ оборвался. Попробуйте размышления «Быстро».' };
    const text = r.output_text || '';
    let summary;
    try { summary = JSON.parse(text); } catch (err) { return { error: 'Модель ответила не анкетой, а текстом. Попробуйте ещё раз.' }; }
    const u = r.usage || {}, cached = (u.input_tokens_details && u.input_tokens_details.cached_tokens) || 0, pr = PRICES[model];
    const usd = ((Math.max(0, (u.input_tokens || 0) - cached)) * pr.input + cached * pr.cached + (u.output_tokens || 0) * pr.output) / 1e6;
    const out = { model, effort, title, source: dl.source, ms: Date.now() - t0, usd, tokens: { input: u.input_tokens || 0, output: u.output_tokens || 0 }, summary };
    fs.writeFileSync(path.join(d, 'итоги.json'), JSON.stringify(out, null, 2));
    fs.writeFileSync(path.join(d, 'итоги.md'), summaryMd(name, out));
    return out;
  } catch (err) {
    console.log('summary failed:', err && err.status);
    return { error: errorText(err) };
  }
});

function summaryMd(name, o) {
  const s = o.summary, who = st => (st.who === 'me' ? 'Вы' : st.who === 'both' ? 'Вместе' : 'Собеседник') + (st.name ? ' (' + st.name + ')' : '');
  return ['# Итоги созвона ' + name, '',
    'Модель ' + o.model + ', размышления ' + o.effort + ' · ' + (o.ms / 1000).toFixed(1) + ' с · ' + o.tokens.input + ' + ' + o.tokens.output + ' токенов · $' + o.usd.toFixed(4) + ' · по расшифровке «' + o.source + '»', '',
    '## Кратко', '', s.brief, '',
    '## Решили', '', s.decisions.length ? s.decisions.map(x => '- ' + x).join('\n') : '(ничего)', '',
    '## Следующие шаги', '', s.steps.length ? s.steps.map(x => '- ' + x.title + ' — ' + who(x) + (x.due ? ', срок ' + x.due : '') + (x.due_text ? ' («' + x.due_text + '»)' : '')).join('\n') : '(нет)', '',
    '## Договорились созвониться', '', s.meetings.length ? s.meetings.map(x => '- ' + x.title + ' — ' + (x.date || 'день не назван') + (x.from ? ' ' + x.from + (x.to ? '–' + x.to : '') : '') + ' («' + x.when_text + '»)').join('\n') : '(нет)', ''
  ].join('\n');
}

// Everything in one file next to the recording, so the models can be compared later.
function report(name, results) {
  const out = ['# Расшифровка записи ' + name, ''];
  for (const r of results) {
    out.push('## ' + r.model, '');
    if (r.error) { out.push('Ошибка: ' + r.error, ''); continue; }
    out.push('Время: микрофон ' + (r.mic.ms / 1000).toFixed(1) + ' с, звук компьютера ' + (r.sys.ms / 1000).toFixed(1) + ' с.');
    out.push('Расход: микрофон — ' + usageText(r.mic.usage) + '; звук компьютера — ' + usageText(r.sys.usage) + '.');
    if (r.mic.noLang || r.sys.noLang) out.push('Подсказку «речь на русском» модель не приняла, расшифровано без неё.');
    if (r.extra) out.push(r.extra);
    out.push('');
    if (r.dialog) {
      out.push('### Разговор по времени', '');
      for (const l of r.dialog) out.push('- ' + mmss(l.start) + ' **' + l.who + ':** ' + l.text);
      out.push('');
    }
    out.push('### Микрофон (вы)', '', r.mic.text || '(тишина)', '', '### Звук компьютера (собеседник)', '', r.sys.text || '(тишина)', '');
  }
  return out.join('\n');
}

ipcMain.handle('selftest-done', (e, result) => {
  console.log(JSON.stringify(result, null, 2));
  app.quit();
});

app.on('window-all-closed', () => app.quit());
