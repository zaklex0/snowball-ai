'use strict';
// Snowball.ai files — ".snowball" (a backup of everything) and ".snowprompt" (prompts to share) — are ordinary
// zip archives: a few JSON files plus the attached files as they are. They are written and read piece by piece,
// so big videos never have to fit in memory. Like storage.js, this module does not need Electron.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const yazl = require('yazl');
const yauzl = require('yauzl');

// Pictures and videos are already compressed: packing them again only costs time.
const STORE_ONLY = /\.(png|jpe?g|webp|gif|avif|heic|mp4|webm|mov|m4v|mkv|mp3|m4a|aac|ogg|opus|flac|zip|7z|rar)$/i;
const MAX_TOTAL = 20 * 1024 * 1024 * 1024;   // 20 GB unpacked: more than any real backup, less than a disk-filling trick

function badFile() {
  const e = new Error('bad archive');
  e.userMessage = 'Этот файл не получилось прочитать: он повреждён или это не файл Snowball.ai.';
  return e;
}

// entries: [{ name: 'prompts.json', data: string | Buffer } or { name: 'files/p1/a.png', file: absolute path }]
// The archive is written next to the target and renamed at the end, so a half-written file never stays behind.
function writeZip(target, entries) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const tmp = target + '.part';
    const out = fs.createWriteStream(tmp);
    let failed = false;
    const fail = (e) => { if (failed) return; failed = true; out.destroy(); fsp.rm(tmp, { force: true }).finally(() => reject(e)); };
    out.on('error', fail);
    zip.outputStream.on('error', fail);
    out.on('close', () => { if (!failed) fsp.rename(tmp, target).then(resolve, fail); });
    zip.outputStream.pipe(out);
    for (const e of entries) {
      if (e.file) zip.addFile(e.file, e.name, { compress: !STORE_ONLY.test(e.name) });
      else zip.addBuffer(Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8'), e.name);
    }
    zip.end();
  });
}

// Unpacks every file into dest. Names that would land outside dest ("../", "C:\") make the whole archive invalid.
function extractZip(source, dest) {
  return new Promise((resolve, reject) => {
    yauzl.open(source, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (err, zip) => {
      if (err) { reject(badFile()); return; }
      const names = [];
      let total = 0;
      let done = false;
      const fail = (e) => { if (done) return; done = true; try { zip.close(); } catch (x) { /* already closed */ } reject(e && e.userMessage ? e : badFile()); };
      zip.on('error', fail);
      zip.on('end', () => { if (!done) { done = true; resolve(names); } });
      zip.on('entry', (entry) => {
        const name = entry.fileName.replace(/\\/g, '/');
        if (name.endsWith('/')) { zip.readEntry(); return; }
        const parts = name.split('/');
        if (path.isAbsolute(name) || /^[a-z]:/i.test(name) || parts.some((p) => p === '..' || p === '')) { fail(badFile()); return; }
        total += entry.uncompressedSize;
        if (total > MAX_TOTAL) { fail(badFile()); return; }
        const out = path.join(dest, ...parts);
        fsp.mkdir(path.dirname(out), { recursive: true }).then(() => {
          zip.openReadStream(entry, (e2, rs) => {
            if (e2) { fail(e2); return; }
            const ws = fs.createWriteStream(out);
            rs.on('error', fail);
            ws.on('error', fail);
            ws.on('close', () => { if (done) return; names.push(name); zip.readEntry(); });
            rs.pipe(ws);
          });
        }, fail);
      });
      zip.readEntry();
    });
  });
}

// What a skill archive holds, without unpacking it: the list of files ({ path, size }, folders left out) and the text
// of its main Markdown file — SKILL.md nearest to the top, otherwise the first .md nearest to the top (at most 512 KB).
const SKILL_MD_MAX = 512 * 1024;
function readZipIndex(source) {
  return new Promise((resolve, reject) => {
    yauzl.open(source, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (err, zip) => {
      if (err) { reject(badFile()); return; }
      const files = [];
      let best = null;   // { path, rank, text }
      let done = false;
      const fail = (e) => { if (done) return; done = true; try { zip.close(); } catch (x) { /* already closed */ } reject(e && e.userMessage ? e : badFile()); };
      zip.on('error', fail);
      zip.on('end', () => { if (!done) { done = true; resolve({ files, main: best ? best.path : '', text: best ? best.text : '' }); } });
      zip.on('entry', (entry) => {
        const name = entry.fileName.replace(/\\/g, '/');
        if (name.endsWith('/') || /(^|\/)(__MACOSX|\.DS_Store)(\/|$)/.test(name)) { zip.readEntry(); return; }
        files.push({ path: name, size: entry.uncompressedSize });
        const base = name.split('/').pop().toLowerCase();
        const depth = name.split('/').length;
        const rank = (base === 'skill.md' ? 0 : 1000) + depth;
        if (!/\.(md|markdown)$/.test(base) || entry.uncompressedSize > SKILL_MD_MAX || (best && best.rank <= rank)) { zip.readEntry(); return; }
        zip.openReadStream(entry, (e2, rs) => {
          if (e2) { fail(e2); return; }
          const parts = [];
          rs.on('data', (c) => parts.push(c));
          rs.on('error', fail);
          rs.on('end', () => { best = { path: name, rank, text: Buffer.concat(parts).toString('utf8') }; zip.readEntry(); });
        });
      });
      zip.readEntry();
    });
  });
}

module.exports = { writeZip, extractZip, readZipIndex };
