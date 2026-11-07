'use strict';
// Exercise a sizeable attachment without relying on real user data or buffering the whole file in memory.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { writeZip, extractZip } = require('../archive');

(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-large-export-'));
  try {
    const size = 96 * 1024 * 1024, source = path.join(dir, 'clip.mp4'), target = path.join(dir, 'backup.snowball');
    const input = await fs.open(source, 'w');
    await input.truncate(size);
    await input.write(Buffer.from('НАЧАЛО'), 0, Buffer.byteLength('НАЧАЛО'), 0);
    await input.write(Buffer.from('КОНЕЦ'), 0, Buffer.byteLength('КОНЕЦ'), size - Buffer.byteLength('КОНЕЦ'));
    await input.close();
    const initial = process.memoryUsage().rss;
    let peak = initial;
    const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 20);
    try { await writeZip(target, [{ name: 'files/p1/clip.mp4', file: source }]); }
    finally { clearInterval(timer); }
    await extractZip(target, path.join(dir, 'unpacked'));
    const output = await fs.open(path.join(dir, 'unpacked', 'files', 'p1', 'clip.mp4'), 'r');
    try {
      assert.equal((await output.stat()).size, size);
      const first = Buffer.alloc(Buffer.byteLength('НАЧАЛО')), last = Buffer.alloc(Buffer.byteLength('КОНЕЦ'));
      await output.read(first, 0, first.length, 0);
      await output.read(last, 0, last.length, size - last.length);
      assert.equal(first.toString(), 'НАЧАЛО');
      assert.equal(last.toString(), 'КОНЕЦ');
    } finally { await output.close(); }
    assert.ok(peak - initial < 128 * 1024 * 1024, 'archive export should stream the file in chunks');
    console.log('OK: 96 MB attachment exported and restored; peak additional memory ~' + Math.round((peak - initial) / 1048576) + ' MB');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
