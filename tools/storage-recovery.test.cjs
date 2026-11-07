'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Store, copyDataTo } = require('../storage');

test('conversation saves detect other windows and deletion without restoring old data', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-chat-conflict-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = await new Store(dir).init();
  const original = { id: 'chat1', title: 'Разговор', messages: [{ role: 'user', text: 'Начало' }] };
  const first = await store.saveChat({ ...original, expectedUpdatedAt: null });
  const next = await store.saveChat({ ...original, title: 'Новее', expectedUpdatedAt: first.updatedAt });
  assert.ok(next.updatedAt > first.updatedAt);
  await assert.rejects(store.saveChat({ ...original, title: 'Старая копия', expectedUpdatedAt: first.updatedAt }), { code: 'CHAT_CONFLICT' });
  assert.equal(store.getChat('chat1').title, 'Новее');
  await store.deleteChat('chat1');
  await assert.rejects(store.saveChat({ ...original, expectedUpdatedAt: next.updatedAt }), { code: 'CHAT_CONFLICT' });
  assert.equal(store.getChat('chat1'), null);
});

test('an old assistant card cannot change or delete a newer event or task', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-assistant-stale-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = await new Store(dir).init();
  const event = await store.saveEvent({ date: '2026-11-06', title: 'Первое дело' });
  const eventSig = (e) => JSON.stringify([e.date, e.from, e.to, e.who, e.title, e.kind, e.note, e.remind]);
  const task = await store.saveTask({ title: 'Первая задача' });
  await store.saveEvent({ ...event, title: 'Изменённое дело' });
  await store.saveTask({ id: task.id, title: 'Изменённая задача' });
  await assert.rejects(store.saveEvent({ ...event, title: 'Из карточки', expectedAction: eventSig(event) }), /stale/);
  await assert.rejects(store.deleteEvent(event.id, eventSig(event)), /stale/);
  await assert.rejects(store.saveTask({ id: task.id, title: 'Из карточки', expectedAction: JSON.stringify(task) }), /stale/);
  await assert.rejects(store.deleteTask(task.id, JSON.stringify(task)), /stale/);
  assert.equal(store.findEvent(event.id).title, 'Изменённое дело');
  assert.equal(store.findTask(task.id).title, 'Изменённая задача');
  await store.deleteEvent(event.id, eventSig(store.findEvent(event.id)));
  await store.deleteTask(task.id, JSON.stringify(store.findTask(task.id)));
  assert.equal(store.findEvent(event.id), null);
  assert.equal(store.findTask(task.id), null);
});

test('failed list saves keep both the old file and the visible data', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-list-write-failure-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = await new Store(dir).init();
  const event = await store.saveEvent({ date: '2026-11-05', title: 'Встреча' });
  const column = await store.addColumn('Свой столбец');
  const task = await store.saveTask({ title: 'Задача', status: column.id });
  await store.saveChat({ id: 'chat1', title: 'Разговор', messages: [{ role: 'user', text: 'Привет' }] });
  const old = {
    calendar: await fs.readFile(path.join(dir, 'calendar.json'), 'utf8'),
    tasks: await fs.readFile(path.join(dir, 'tasks.json'), 'utf8'),
    chats: await fs.readFile(path.join(dir, 'chats.json'), 'utf8')
  };
  const rename = fs.rename;
  let blocked = '';
  fs.rename = async (from, to) => {
    if (to === path.join(dir, blocked + '.json')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    return rename(from, to);
  };
  t.after(() => { fs.rename = rename; });
  for (const [file, change] of [
    ['calendar', () => store.saveEvent({ ...event, title: 'Изменено' })],
    ['calendar', () => store.deleteEvent(event.id)],
    ['tasks', () => store.saveTask({ id: task.id, title: 'Изменено' })],
    ['tasks', () => store.deleteColumn(column.id)],
    ['tasks', () => store.setArchiveMode('manual')],
    ['chats', () => store.saveChat({ id: 'chat1', title: 'Изменено', messages: [{ role: 'user', text: 'Новый текст' }] })],
    ['chats', () => store.deleteChat('chat1')]
  ]) {
    blocked = file;
    await assert.rejects(change(), { code: 'ENOSPC' });
    assert.equal(await fs.readFile(path.join(dir, file + '.json'), 'utf8'), old[file]);
    assert.equal(store.findEvent(event.id).title, 'Встреча');
    assert.equal(store.findTask(task.id).title, 'Задача');
    assert.equal(store.findTask(task.id).status, column.id);
    assert.equal(store.columns[0].name, 'Свой столбец');
    assert.equal(store.archiveMode, 'day');
    assert.equal(store.getChat('chat1').title, 'Разговор');
  }
  fs.rename = rename;
  await store.deleteColumn(column.id);
  assert.equal(store.findTask(task.id).status, 'todo');
  assert.equal((await new Store(dir).init()).findTask(task.id).status, 'todo');
});

test('other readers see old calendar, tasks and chats until a save succeeds', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-list-pending-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = await new Store(dir).init();
  const event = await store.saveEvent({ date: '2026-11-05', title: 'До' });
  const task = await store.saveTask({ title: 'До' });
  await store.saveChat({ id: 'chat1', title: 'До', messages: [{ role: 'user', text: 'Привет' }] });
  for (const [method, change, read] of [
    ['writeCalendar', () => store.saveEvent({ ...event, title: 'После' }), () => store.findEvent(event.id).title],
    ['writeTasks', () => store.saveTask({ id: task.id, title: 'После' }), () => store.findTask(task.id).title],
    ['writeChats', () => store.saveChat({ id: 'chat1', title: 'После', messages: [{ role: 'user', text: 'Привет' }] }), () => store.getChat('chat1').title]
  ]) {
    const original = store[method];
    let release, entered;
    const started = new Promise((resolve) => { entered = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    store[method] = async function () { entered(); await gate; return original.call(this); };
    const saving = change();
    await started;
    assert.equal(read(), 'До');
    release();
    await saving;
    assert.equal(read(), 'После');
    store[method] = original;
  }
});

test('failed imports do not expose unsaved calendar, task or chat entries', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-import-failure-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const sourceDir = path.join(dir, 'backup');
  await fs.mkdir(sourceDir);
  const source = await new Store(sourceDir).init();
  await source.saveEvent({ date: '2026-11-05', title: 'Импортированная встреча' });
  await source.saveTask({ title: 'Импортированная задача' });
  await source.saveChat({ id: 'chat1', title: 'Импортированный разговор', messages: [{ role: 'user', text: 'Привет' }] });
  for (const [method, read] of [
    ['writeCalendar', (store) => store.events.length],
    ['writeTasks', (store) => store.tasks.length],
    ['writeChats', (store) => store.chats.length]
  ]) {
    const targetDir = path.join(dir, method);
    await fs.mkdir(targetDir);
    const target = await new Store(targetDir).init();
    target[method] = async () => { throw new Error('disk full'); };
    await assert.rejects(target.mergeFrom(sourceDir, 'backup'), /disk full/);
    assert.equal(read(target), 0);
    assert.equal(read(await new Store(targetDir).init()), 0);
  }
});

test('backup import preserves existing files, protects incomplete saves and can be retried', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-import-files-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const sourceDir = path.join(dir, 'source'), backup = path.join(dir, 'backup');
  await fs.mkdir(sourceDir); await fs.mkdir(backup);
  const source = await new Store(sourceDir).init();
  const prompt = await source.savePrompt({ item: { title: 'Промт', text: 'Текст' }, addFiles: [{ name: 'file.txt', data: Buffer.from('Из копии') }] });
  const image = await source.saveChatImage('chat1', 'картинка', Buffer.from('Картинка копии'), 'png');
  await source.saveChat({ id: 'chat1', title: 'Разговор', messages: [{ role: 'user', text: 'Привет', images: [image] }] });
  const skill = await source.addSkill({ name: 'skill.md', bytes: Buffer.from('# Из копии') });
  for (const entry of source.packEntries('backup').entries) {
    const dest = path.join(backup, ...entry.name.split('/'));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    if (entry.file) await fs.copyFile(entry.file, dest); else await fs.writeFile(dest, entry.data);
  }
  const targetDir = path.join(dir, 'target');
  await fs.mkdir(targetDir);
  const target = await new Store(targetDir).init();
  const orphan = path.join(target.promptDir(prompt.id), 'file.txt');
  await fs.mkdir(path.dirname(orphan), { recursive: true });
  await fs.writeFile(orphan, 'Существующий файл');
  const write = target.write;
  target.write = async () => { throw new Error('disk full'); };
  await assert.rejects(target.mergeFrom(backup, 'backup'), /disk full/);
  assert.equal(target.find(prompt.id), null);
  assert.equal(await fs.readFile(orphan, 'utf8'), 'Существующий файл');
  assert.deepEqual(await fs.readdir(path.dirname(orphan)), ['file.txt']);
  target.write = write;

  const existingImage = target.chatImagePath('chat1', image.stored);
  await fs.mkdir(path.dirname(existingImage), { recursive: true });
  await fs.writeFile(existingImage, 'Существующая картинка');
  await assert.rejects(target.mergeFrom(backup, 'backup'), /import attachment already exists/);
  assert.equal(await fs.readFile(existingImage, 'utf8'), 'Существующая картинка');
  assert.equal(target.getChat('chat1'), null);
  assert.equal(target.find(prompt.id).files.length, 1);
  assert.equal(await fs.readFile(orphan, 'utf8'), 'Существующий файл');
  // Identical files from a previous interrupted attempt are safe to reuse.
  await fs.writeFile(existingImage, 'Картинка копии');
  const existingSkill = path.join(target.skillDir(skill.id), skill.file.stored);
  await fs.mkdir(path.dirname(existingSkill), { recursive: true });
  await fs.writeFile(existingSkill, 'Существующий скилл');
  await assert.rejects(target.mergeFrom(backup, 'backup'), /import attachment already exists/);
  assert.equal(await fs.readFile(existingSkill, 'utf8'), 'Существующий скилл');
  assert.equal(target.findSkill(skill.id), null);
  assert.ok(target.getChat('chat1'));
  await fs.writeFile(existingSkill, '# Из копии');
  const writeSkills = target.writeSkills;
  target.writeSkills = async () => { throw new Error('disk full'); };
  await assert.rejects(target.mergeFrom(backup, 'backup'), /disk full/);
  assert.equal(target.findSkill(skill.id), null);
  assert.equal(await fs.readFile(existingSkill, 'utf8'), '# Из копии');
  target.writeSkills = writeSkills;
  await target.mergeFrom(backup, 'backup');
  const reopened = await new Store(targetDir).init();
  assert.ok(reopened.find(prompt.id)); assert.ok(reopened.getChat('chat1')); assert.ok(reopened.findSkill(skill.id));
  assert.equal(await fs.readFile(existingImage, 'utf8'), 'Картинка копии');
});

test('broken backup sections and missing attachments are reported', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-import-broken-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const targetDir = path.join(dir, 'target'), backup = path.join(dir, 'backup');
  await fs.mkdir(targetDir); await fs.mkdir(backup);
  const target = await new Store(targetDir).init();
  await fs.writeFile(path.join(backup, 'prompts.json'), JSON.stringify({ prompts: [{ id: 'p1', title: 'Промт', files: [{ id: 'f1', stored: 'missing.txt' }] }] }));
  await assert.rejects(target.mergeFrom(backup, 'backup'), /missing archive attachment/);
  assert.equal(target.find('p1'), null);
  await fs.writeFile(path.join(backup, 'prompts.json'), JSON.stringify({ prompts: [] }));
  await fs.writeFile(path.join(backup, 'calendar.json'), '{broken');
  await assert.rejects(target.mergeFrom(backup, 'backup'), /invalid archive list/);
  await fs.writeFile(path.join(backup, 'prompts.json'), '{broken');
  await assert.rejects(target.mergeFrom(backup, 'backup'), /invalid archive prompts/);
});

test('legacy prompt import publishes new records only after saving', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-old-import-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = await new Store(dir).init();
  const raw = JSON.stringify({ prompts: [{ id: 'p1', title: 'Старый формат', text: 'Текст' }] });
  const write = store.write;
  store.write = async () => { throw new Error('disk full'); };
  await assert.rejects(store.importJson(raw), /disk full/);
  assert.equal(store.find('p1'), null);
  assert.equal((await new Store(dir).init()).find('p1'), null);
  store.write = write;
  assert.equal((await store.importJson(raw)).added, 1);
  assert.ok((await new Store(dir).init()).find('p1'));
});

test('skill changes keep the previous list and file if saving fails', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-skill-failure-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let trashCalls = 0;
  const store = await new Store(dir, { trash: async () => { trashCalls++; } }).init();
  const skill = await store.addSkill({ name: 'skill.md', bytes: Buffer.from('# Исходный'), desc: 'До' });
  const file = store.skillFilePath(skill.id);
  const old = await fs.readFile(store.skillsPath, 'utf8');
  const rename = fs.rename;
  fs.rename = async (from, to) => {
    if (to === store.skillsPath) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    return rename(from, to);
  };
  t.after(() => { fs.rename = rename; });
  for (const action of [
    () => store.addSkill({ name: 'new.md', bytes: Buffer.from('# Новый') }),
    () => store.saveSkill({ id: skill.id, desc: 'После' }),
    () => store.deleteSkill(skill.id)
  ]) {
    await assert.rejects(action(), { code: 'ENOSPC' });
    assert.equal(await fs.readFile(store.skillsPath, 'utf8'), old);
    assert.equal(store.skills.length, 1);
    assert.equal(store.findSkill(skill.id).desc, 'До');
    assert.equal(await fs.readFile(file, 'utf8'), '# Исходный');
    assert.equal(trashCalls, 0);
  }
  fs.rename = rename;
  assert.deepEqual(await fs.readdir(store.skillsRoot), [skill.id]);
  await store.saveSkill({ id: skill.id, desc: 'После' });
  assert.equal((await new Store(dir).init()).findSkill(skill.id).desc, 'После');
});

test('skill edits and generated descriptions cannot overwrite newer changes', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-skill-conflict-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = await new Store(dir).init();
  const skill = await store.addSkill({ name: 'skill.md', bytes: Buffer.from('# Скилл'), desc: 'Исходное описание', type: 'text' });
  const expectedFields = { title: JSON.stringify(skill.title), type: JSON.stringify(skill.type), desc: JSON.stringify(skill.desc) };
  await store.saveSkill({ id: skill.id, desc: 'Написано в другом окне' });
  await assert.rejects(store.saveSkill({ id: skill.id, desc: 'Старый текст', expectedFields }), /skill changed/);
  assert.equal(store.findSkill(skill.id).desc, 'Написано в другом окне');
  await assert.rejects(store.saveSkill({ id: skill.id, desc: 'Ответ ассистента', expectedFields: { desc: JSON.stringify(skill.desc) } }), /skill changed/);
  await store.deleteSkill(skill.id);
  await assert.rejects(store.saveSkill({ id: skill.id, desc: 'Старый текст', expectedFields }), /skill changed/);
});

test('other windows see the previous skill list until each change is saved', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-skill-pending-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = await new Store(dir, { trash: async () => {} }).init();
  const skill = await store.addSkill({ name: 'skill.md', bytes: Buffer.from('# Скилл'), desc: 'До' });
  for (const [change, pending, saved] of [
    [() => store.addSkill({ name: 'other.md', bytes: Buffer.from('# Другой') }), () => store.skills.length === 1, () => store.skills.length === 2],
    [() => store.saveSkill({ id: skill.id, desc: 'После' }), () => store.findSkill(skill.id).desc === 'До', () => store.findSkill(skill.id).desc === 'После'],
    [() => store.deleteSkill(skill.id), () => !!store.findSkill(skill.id), () => !store.findSkill(skill.id)]
  ]) {
    const original = store.writeSkills;
    let entered, release;
    const started = new Promise((resolve) => { entered = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    store.writeSkills = async function () { entered(); await gate; return original.call(this); };
    const saving = change();
    await started;
    assert.ok(pending());
    release();
    await saving;
    assert.ok(saved());
    store.writeSkills = original;
  }
});

test('an existing unregistered skill folder is never overwritten or recursively removed', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-skill-folder-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = await new Store(dir).init();
  const mkdir = fs.mkdir;
  let orphan;
  fs.mkdir = async (p, opts) => {
    if (!orphan && path.dirname(p) === store.skillsRoot && !opts) {
      orphan = p;
      await mkdir(p);
      await fs.writeFile(path.join(p, 'existing.md'), 'Не трогать');
    }
    return mkdir(p, opts);
  };
  t.after(() => { fs.mkdir = mkdir; });
  const skill = await store.addSkill({ name: 'skill.md', bytes: Buffer.from('# Новый') });
  fs.mkdir = mkdir;
  assert.ok(orphan);
  assert.notEqual(store.skillDir(skill.id), orphan);
  assert.equal(await fs.readFile(path.join(orphan, 'existing.md'), 'utf8'), 'Не трогать');
});

test('failed moving a removed skill to the recycle bin is reported without deleting its file', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-skill-trash-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = await new Store(dir, { trash: async () => { throw new Error('unavailable'); } }).init();
  const skill = await store.addSkill({ name: 'skill.md', bytes: Buffer.from('# Скилл') });
  const file = store.skillFilePath(skill.id);
  const result = await store.deleteSkill(skill.id);
  assert.equal(result.fileStatus, 'left');
  assert.equal(store.findSkill(skill.id), null);
  assert.equal(await fs.readFile(file, 'utf8'), '# Скилл');
});

test('transcript write and deletion failures keep the saved record and its file', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-transcript-failure-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = await new Store(dir, { trash: async () => { throw new Error('recycle bin unavailable'); } }).init();
  await store.saveTranscript({ id: 'tr1', name: 'Аудио', text: 'Исходный текст', cues: [{ start: 0, end: 1, text: 'Исходный текст' }] });
  const file = store.transcriptPath('tr1'), old = await fs.readFile(file, 'utf8');
  const rename = fs.rename;
  fs.rename = async (from, to) => {
    if (to === file) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    return rename(from, to);
  };
  t.after(() => { fs.rename = rename; });
  await assert.rejects(store.saveTranscript({ id: 'tr1', text: 'Новый текст' }), { code: 'ENOSPC' });
  assert.equal(store.getTranscript('tr1').text, 'Исходный текст');
  assert.equal(await fs.readFile(file, 'utf8'), old);
  fs.rename = rename;
  await assert.rejects(store.deleteTranscript('tr1'), /recycle bin unavailable/);
  assert.equal(store.getTranscript('tr1').text, 'Исходный текст');
  assert.equal(await fs.readFile(file, 'utf8'), old);
  assert.equal((await new Store(dir).init()).getTranscript('tr1').text, 'Исходный текст');
});

test('stale transcript edits and summaries do not overwrite newer text or restore a deleted record', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-transcript-conflict-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = await new Store(dir, { trash: async (file) => fs.unlink(file) }).init();
  const original = await store.saveTranscript({ id: 'tr1', text: 'Старый текст', cues: [{ start: 0, end: 1, text: 'Старый текст' }] });
  const editExpected = { text: JSON.stringify(original.text), cues: JSON.stringify(original.cues) };
  const summaryExpected = { text: JSON.stringify(original.text), summary: JSON.stringify(original.summary) };
  await store.saveTranscript({ id: 'tr1', text: 'Новый текст', cues: [{ start: 0, end: 1, text: 'Новый текст' }] });
  await assert.rejects(store.saveTranscript({ id: 'tr1', text: 'Старая правка', expectedFields: editExpected }), /transcript changed/);
  await assert.rejects(store.saveTranscript({ id: 'tr1', summary: { brief: 'Старые итоги' }, expectedFields: summaryExpected }), /transcript changed/);
  assert.equal(store.getTranscript('tr1').text, 'Новый текст');
  assert.equal(store.getTranscript('tr1').summary, null);
  await store.deleteTranscript('tr1');
  await assert.rejects(store.saveTranscript({ id: 'tr1', text: 'Старая правка', expectedFields: editExpected }), /transcript changed/);
  assert.equal(store.getTranscript('tr1'), null);
});

test('damaged transcription files remain untouched and are reported', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-transcript-broken-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = await new Store(dir).init();
  await fs.mkdir(store.transcriptsRoot, { recursive: true });
  const file = path.join(store.transcriptsRoot, 'broken.json');
  await fs.writeFile(file, '{broken');
  const reopened = await new Store(dir).init();
  assert.equal(await fs.readFile(file, 'utf8'), '{broken');
  assert.equal(reopened.dataWarnings.length, 1);
  assert.equal(reopened.dataWarnings[0].transcript, true);
  assert.equal(reopened.transcriptList().length, 0);
  await assert.rejects(reopened.saveTranscript({ id: 'broken', text: 'Другой текст' }), /transcript file already exists/);
  await assert.rejects(reopened.putTranscript({ id: 'broken', text: 'Другой текст' }), /transcript file already exists/);
  assert.equal(await fs.readFile(file, 'utf8'), '{broken');
});

test('meeting results protect newer results and do not create an event when its write fails', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-recap-conflict-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = await new Store(dir).init();
  const event = await store.saveEvent({ date: '2026-11-05', title: 'Созвон' });
  const expected = store.calendarView().find((e) => e.id === event.id).recapRevision;
  await store.saveEvent({ ...event, title: 'Новое название' });
  await store.setRecap(event.id, { brief: 'Итоги', text: 'Полный текст' }, expected);
  await assert.rejects(store.setRecap(event.id, { brief: 'Старые итоги' }, expected), /recap changed/);
  assert.equal(store.findEvent(event.id).recap.brief, 'Итоги');
  assert.equal(store.recapText(event.id), 'Полный текст');
  const write = store.writeCalendar;
  store.writeCalendar = async () => { throw new Error('disk full'); };
  await assert.rejects(store.saveEvent({ date: '2026-11-06', title: 'Новый созвон', recap: { brief: 'Итоги', text: 'Текст' } }), /disk full/);
  assert.equal(store.events.length, 1);
  store.writeCalendar = write;
  await store.deleteEvent(event.id);
  await assert.rejects(store.setRecap(event.id, { brief: 'Старые итоги' }, expected), /recap changed/);
});

test('important lists recover their last saved copy and keep damaged files', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-recovery-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = await new Store(dir).init();
  await store.saveTask({ title: 'Задача' });
  await store.saveEvent({ date: '2026-11-05', title: 'Встреча' });
  await store.saveChat({ id: 'chat1', title: 'Разговор', messages: [{ role: 'user', content: 'Привет' }] });
  await store.addSkill({ name: 'skill.md', bytes: Buffer.from('# Skill\nTest') });
  for (const name of ['tasks', 'calendar', 'chats', 'skills']) {
    assert.ok(await fs.readFile(path.join(dir, name + '.backup.json')));
    await fs.writeFile(path.join(dir, name + '.json'), '{broken');
  }
  const recovered = await new Store(dir).init();
  assert.equal(recovered.tasks[0].title, 'Задача');
  assert.equal(recovered.events[0].title, 'Встреча');
  assert.equal(recovered.chats[0].title, 'Разговор');
  assert.equal(recovered.skills.length, 1);
  assert.equal(recovered.dataWarnings.length, 4);
  for (const warning of recovered.dataWarnings) {
    assert.equal(warning.restored, true);
    assert.equal(await fs.readFile(path.join(dir, warning.broken), 'utf8'), '{broken');
    assert.doesNotThrow(() => JSON.parse(require('node:fs').readFileSync(path.join(dir, warning.file), 'utf8')));
  }
  const destination = path.join(dir, 'copy');
  await copyDataTo(dir, destination);
  assert.ok(await fs.readFile(path.join(destination, 'tasks.backup.json')));
});

test('damaged data without a backup is preserved and reported even after a new save', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-no-backup-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'tasks.json'), '{broken');
  const store = await new Store(dir).init();
  assert.equal(store.dataWarnings.length, 1);
  assert.equal(store.dataWarnings[0].restored, false);
  await store.saveTask({ title: 'Новая задача' });
  assert.equal(await fs.readFile(path.join(dir, store.dataWarnings[0].broken), 'utf8'), '{broken');
  assert.equal((await new Store(dir).init()).tasks[0].title, 'Новая задача');
});

test('a missing data file is restored if its backup exists', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-missing-list-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = await new Store(dir).init();
  await store.saveTask({ title: 'Не потерять' });
  await fs.unlink(path.join(dir, 'tasks.json'));
  const recovered = await new Store(dir).init();
  assert.equal(recovered.tasks[0].title, 'Не потерять');
  assert.equal(recovered.dataWarnings[0].missing, true);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'tasks.json'), 'utf8')).tasks[0].title, 'Не потерять');
});

test('a stale editor cannot overwrite a newer prompt or resurrect a deleted one', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-conflict-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = await new Store(dir).init();
  const created = await store.savePrompt({ item: { title: 'Исходный', type: 'Видео', text: 'Текст' } });
  const prompt = store.find(created.id);
  const expected = JSON.stringify([prompt.title, prompt.type, prompt.text, prompt.comment, prompt.files.map((f) => f.id)]);
  await store.savePrompt({ item: { id: created.id, title: 'Изменён в другом окне', type: 'Видео', text: 'Текст' }, expected });
  await assert.rejects(store.savePrompt({ item: { id: created.id, title: 'Старая версия', type: 'Видео', text: 'Текст' }, expected }), /prompt changed/);
  assert.equal(store.find(created.id).title, 'Изменён в другом окне');
  await store.deletePrompt(created.id);
  await assert.rejects(store.savePrompt({ item: { id: created.id, title: 'Старая версия', type: 'Видео', text: 'Текст' }, expected }), /prompt changed/);
  assert.equal(store.find(created.id), null);
});

test('a stale calendar form cannot overwrite or resurrect an event', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-event-conflict-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = await new Store(dir).init();
  const event = await store.saveEvent({ date: '2026-11-05', title: 'Встреча' });
  const expected = JSON.stringify([event.date, event.from, event.to, event.who, event.title, event.kind, event.note, event.remind]);
  await store.saveEvent({ ...event, title: 'Новая тема', expected });
  await assert.rejects(store.saveEvent({ ...event, title: 'Старая тема', expected }), /event changed/);
  assert.equal(store.findEvent(event.id).title, 'Новая тема');
  await store.deleteEvent(event.id);
  await assert.rejects(store.saveEvent({ ...event, expected }), /event changed/);
  assert.equal(store.findEvent(event.id), null);
});

test('task edits protect changed fields while allowing unrelated changes', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-task-conflict-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = await new Store(dir).init();
  const task = await store.saveTask({ title: 'Задача', note: 'Исходная заметка' });
  const expected = { note: JSON.stringify(task.note) };
  await store.saveTask({ id: task.id, title: 'Новое название' });
  await store.saveTask({ id: task.id, note: 'Новая заметка', expectedFields: expected });
  assert.equal(store.findTask(task.id).title, 'Новое название');
  await assert.rejects(store.saveTask({ id: task.id, note: 'Старая заметка', expectedFields: expected }), /task changed/);
  assert.equal(store.findTask(task.id).note, 'Новая заметка');
  await store.deleteTask(task.id);
  await assert.rejects(store.saveTask({ id: task.id, note: 'Старая заметка', expectedFields: expected }), /task changed/);
  assert.equal(store.findTask(task.id), null);
});

test('failed prompt writes keep old data and attachments, then a successful retry removes old files', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-prompt-write-failure-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const trashed = [];
  const store = await new Store(dir, { trash: async (file) => {
    const disk = JSON.parse(await fs.readFile(path.join(dir, 'prompts.json'), 'utf8'));
    assert.ok(disk.prompts.every((p) => p.files.every((f) => f.stored !== path.basename(file))), 'metadata must be saved before the old file is removed');
    trashed.push(file); await fs.rm(file, { force: true });
  } }).init();
  const created = await store.savePrompt({ item: { title: 'Старое', type: 'Видео', text: 'Исходный текст' },
    addFiles: [{ name: 'old.txt', data: Uint8Array.from([1, 2, 3]) }] });
  const id = created.id, previous = structuredClone(store.find(id)), oldFile = store.filePath(id, previous.files[0].id);
  const diskBefore = await fs.readFile(store.dataPath, 'utf8'), originalWrite = store.write;
  store.write = async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
  const change = { item: { id, title: 'Новое', type: 'Видео', text: 'Новый текст' },
    removeFileIds: [previous.files[0].id], addFiles: [{ name: 'new.txt', data: Uint8Array.from([4, 5, 6]) }] };
  await assert.rejects(store.savePrompt(change), { code: 'ENOSPC' });
  assert.deepEqual(store.find(id), previous);
  assert.equal(await fs.readFile(store.dataPath, 'utf8'), diskBefore);
  assert.deepEqual(await fs.readFile(oldFile), Buffer.from([1, 2, 3]));
  assert.deepEqual(await fs.readdir(store.promptDir(id)), ['old.txt']);
  assert.equal(trashed.length, 0);
  await assert.rejects(store.addFiles(id, [{ name: 'old.txt', data: Uint8Array.from([7]) }]), { code: 'ENOSPC' });
  await assert.rejects(store.removeFile(id, previous.files[0].id), { code: 'ENOSPC' });
  await assert.rejects(store.deletePrompt(id), { code: 'ENOSPC' });
  await assert.rejects(store.savePrompt({ item: { id: 'new-prompt', title: 'Новый', type: 'Видео', text: 'Текст' },
    addFiles: [{ name: 'new.txt', data: Uint8Array.from([8]) }] }), { code: 'ENOSPC' });
  assert.equal(store.find('new-prompt'), null);
  assert.deepEqual(await fs.readdir(store.promptDir('new-prompt')), []);
  assert.deepEqual(store.find(id), previous);
  assert.deepEqual(await fs.readdir(store.promptDir(id)), ['old.txt']);
  store.write = originalWrite;
  await store.savePrompt(change);
  assert.equal(store.find(id).title, 'Новое');
  assert.deepEqual(await fs.readdir(store.promptDir(id)), ['new.txt']);
  assert.deepEqual(trashed, [oldFile]);
  assert.equal((await new Store(dir).init()).find(id).files[0].name, 'new.txt');
});

test('disk errors during the final file replacement preserve the primary and backup', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-prompt-rename-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = await new Store(dir).init();
  const { id } = await store.savePrompt({ item: { title: 'Первый', type: 'Видео', text: 'Текст' } });
  const diskBefore = await fs.readFile(store.dataPath, 'utf8');
  const originalRename = fs.rename;
  t.after(() => { fs.rename = originalRename; });
  fs.rename = async (source, target) => {
    if (source === store.dataPath + '.tmp' && target === store.dataPath) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    return originalRename(source, target);
  };
  await assert.rejects(store.savePrompt({ item: { id, title: 'Не сохранился', type: 'Видео', text: 'Текст' } }), { code: 'ENOSPC' });
  assert.equal(store.find(id).title, 'Первый');
  assert.equal(await fs.readFile(store.dataPath, 'utf8'), diskBefore);
  assert.equal(JSON.parse(await fs.readFile(store.backupPath, 'utf8')).prompts[0].title, 'Первый');
  await assert.rejects(fs.access(store.dataPath + '.tmp'), { code: 'ENOENT' });
  const backupBefore = await fs.readFile(store.backupPath, 'utf8');
  fs.rename = async (source, target) => {
    if (target === store.backupPath) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    return originalRename(source, target);
  };
  await assert.rejects(store.savePrompt({ item: { id, title: 'Не сохранился', type: 'Видео', text: 'Текст' } }), { code: 'ENOSPC' });
  assert.equal(await fs.readFile(store.dataPath, 'utf8'), diskBefore);
  assert.equal(await fs.readFile(store.backupPath, 'utf8'), backupBefore);
  assert.equal(store.find(id).title, 'Первый');
  fs.rename = originalRename;
  await store.savePrompt({ item: { id, title: 'Сохранён', type: 'Видео', text: 'Текст' } });
  assert.equal((await new Store(dir).init()).find(id).title, 'Сохранён');
});

test('other readers see the previous prompt until the new version is saved', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-prompt-pending-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = await new Store(dir).init();
  const { id } = await store.savePrompt({ item: { title: 'Старый', type: 'Видео', text: 'Текст' } });
  const originalWrite = store.write;
  let started, continueWrite;
  const entered = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { continueWrite = resolve; });
  store.write = async function (options) { started(); await gate; return originalWrite.call(this, options); };
  const saving = store.savePrompt({ item: { id, title: 'Новый', type: 'Видео', text: 'Текст' } });
  await entered;
  assert.equal(store.view()[0].title, 'Старый');
  assert.equal(JSON.parse(await fs.readFile(store.dataPath, 'utf8')).prompts[0].title, 'Старый');
  continueWrite();
  await saving;
  assert.equal(store.view()[0].title, 'Новый');
});

test('export reports missing prompt, chat and skill attachments', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-missing-files-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = await new Store(dir).init();
  const p = await store.savePrompt({ item: { title: 'Промт', type: 'Видео', text: 'Текст' }, addFiles: [{ name: 'pic.png', data: Buffer.from('test') }] });
  await fs.unlink(store.filePath(p.id, store.find(p.id).files[0].id));
  const image = await store.saveChatImage('chat1', 'image.jpg', Buffer.from('test'), 'jpg');
  await store.saveChat({ id: 'chat1', title: 'Разговор', messages: [{ role: 'user', content: 'Фото', images: [image] }] });
  await fs.unlink(store.chatImagePath('chat1', image.stored));
  const skill = await store.addSkill({ name: 'skill.md', bytes: Buffer.from('# Skill') });
  await fs.unlink(store.skillFilePath(skill.id));
  assert.equal(store.packEntries('backup').missing.length, 3);
  assert.equal(store.packEntries('share').missing.length, 1);
});
