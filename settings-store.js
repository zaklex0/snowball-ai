'use strict';
// Settings are small, but include the data-folder location and spending history: keep the last good copy.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const backupPath = (file) => file.replace(/\.json$/i, '.backup.json');
function parse(raw) {
  try {
    const value = JSON.parse(String(raw).replace(/^\uFEFF/, ''));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch (e) { return null; }
}
function readIfPresent(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
function tempPath(file) { return path.join(path.dirname(file), '.snowball-settings-' + crypto.randomBytes(12).toString('hex') + '.tmp'); }
function atomicWrite(file, value) {
  const tmp = tempPath(file);
  let fd;
  // Do not remove a pre-existing file if the random temporary name happens to collide.
  fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, value);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, file);
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) {} }
    try { fs.unlinkSync(tmp); } catch (e) { if (e.code !== 'ENOENT') { /* keep the original error */ } }
  }
}
function writeSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const value = JSON.stringify(settings, null, 2);
  atomicWrite(file, value);
  let backupError = null;
  try { atomicWrite(backupPath(file), value); } catch (e) { backupError = e; }
  return { backupError };
}
function loadSettingsFile(file) {
  const raw = readIfPresent(file);
  if (raw !== null) {
    const settings = parse(raw);
    if (settings) return { settings, warning: null };
  }
  let broken = null;
  if (raw !== null) {
    broken = path.join(path.dirname(file), 'settings.broken-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex') + '.json');
    fs.copyFileSync(file, broken, fs.constants.COPYFILE_EXCL);
  }
  const backupRaw = readIfPresent(backupPath(file));
  const backup = backupRaw === null ? null : parse(backupRaw);
  if (backup) return { settings: backup, warning: broken
    ? 'Настройки были повреждены и восстановлены из запасной копии. Исходный файл сохранён: ' + broken
    : 'Файл настроек отсутствовал; настройки восстановлены из запасной копии.' };
  if (broken) return { settings: {}, warning: 'Настройки повреждены, исправной копии нет. Исходный файл сохранён: ' + broken + '. Если данные лежат в другой папке, выберите её в настройках.' };
  return { settings: {}, warning: null };
}
module.exports = { loadSettingsFile, writeSettings, backupPath };
