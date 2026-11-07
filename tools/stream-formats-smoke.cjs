'use strict';
// FFmpeg is only used here to generate test fixtures, never by the application.
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { connect } = require('./guide-shots/cdp');

function wave() {
  const rate = 48000, samples = rate * 12, b = Buffer.alloc(44 + samples * 4);
  b.write('RIFF', 0); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(samples * 4, 40);
  for (let i = 0; i < samples; i++) {
    const t = i / rate, on = (t >= 1 && t < 4) || (t >= 6 && t < 9);
    const v = on ? Math.round(Math.sin(2 * Math.PI * 220 * t) * 10000) : 0;
    b.writeInt16LE(v, 44 + i * 4); b.writeInt16LE(Math.round(v * 0.5), 46 + i * 4);
  }
  return b;
}
(async () => {
  const root = path.resolve(__dirname, '..'), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snowball-formats-'));
  const profile = path.join(tmp, 'profile'), data = path.join(tmp, 'data'), input = path.join(tmp, 'input.wav');
  fs.mkdirSync(profile); fs.mkdirSync(data); fs.writeFileSync(input, wave());
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ dataDir: data }));
  const formats = [
    ['mp3', ['-c:a', 'libmp3lame']], ['m4a', ['-c:a', 'aac']],
    ['webm', ['-c:a', 'libopus']], ['flac', ['-c:a', 'flac']],
    ['ogg', ['-c:a', 'libvorbis']], ['opus', ['-c:a', 'libopus']]
  ];
  for (const [ext, args] of formats) {
    const run = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', input, ...args, path.join(tmp, 'input.' + ext)], { windowsHide: true, encoding: 'utf8' });
    if (run.status !== 0) throw new Error('Fixture ' + ext + ': ' + (run.stderr || run.error));
  }
  for (const [name, offset] of [['input.mp4', 0], ['delayed.mp4', 2]]) {
    const run = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=1:d=14',
      '-itsoffset', String(offset), '-i', input, '-map', '0:v', '-map', '1:a', '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', path.join(tmp, name)],
      { windowsHide: true, encoding: 'utf8' });
    if (run.status !== 0) throw new Error('Fixture ' + name + ': ' + (run.stderr || run.error));
  }
  for (const ext of ['wav', 'mov']) {
    const run = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', input, '-c:a', 'pcm_s24le', path.join(tmp, '24bit.' + ext)],
      { windowsHide: true, encoding: 'utf8' });
    if (run.status !== 0) throw new Error('24-bit fixture: ' + (run.stderr || run.error));
  }
  const longFile = path.join(tmp, 'long.mp3');
  const longRun = spawnSync('ffmpeg', ['-v', 'error', '-y', '-stream_loop', '-1', '-i', input, '-t', '1800', '-ar', '22050', '-b:a', '32k', longFile],
    { windowsHide: true, encoding: 'utf8' });
  if (longRun.status !== 0) throw new Error('Long fixture: ' + (longRun.stderr || longRun.error));
  const child = spawn(require('electron'), ['.', '--inspect=9255', '--remote-debugging-port=9355', '--user-data-dir=' + profile],
    { cwd: root, stdio: 'ignore', windowsHide: true });
  try {
    const main = await connect(9255, (t) => t.type === 'node');
    assert.equal(path.resolve(await main.ev("process.mainModule.require('electron').app.getPath('userData')")), path.resolve(profile));
    const page = await connect(9355, (t) => /index\.html/.test(t.url));
    await page.until('!!window.transcriptionStream && !!window.vsApi');
    const cases = ['wav', ...formats.map((x) => x[0]), 'mp4'].map((ext) => ({ name: ext, file: path.join(tmp, 'input.' + ext), offset: 0 }));
    cases.push({ name: 'mp4 with delayed sound', file: path.join(tmp, 'delayed.mp4'), offset: 2 });
    cases.push({ name: '24-bit wav', file: path.join(tmp, '24bit.wav'), offset: 0 }, { name: '24-bit mov', file: path.join(tmp, '24bit.mov'), offset: 0 });
    for (const { name, file, offset } of cases) {
      const result = await page.ev(`(async()=>{const info=await vsApi.mediaInfo(${JSON.stringify(file)}); let r;
      try { r=await transcriptionStream.open(info,vsApi); } catch(e) {
        const all=await vsApi.mediaRead(info.file,info.token), audio=await new OfflineAudioContext(1,1,16000).decodeAudioData(all.data);
        return {fallback:true,duration:audio.duration};
      } try {
        const levels=await r.scan(null,()=>false), found=transcriptionCore.findSpeechLevels(levels);
        const voiced=await r.wav(${1.5 + offset},${3.5 + offset}), silent=await r.wav(${4.5 + offset},${5.5 + offset});
        function rms(w){const v=new DataView(w);let sum=0,n=(w.byteLength-44)/2;for(let i=0;i<n;i++){let x=v.getInt16(44+i*2,true)/32768;sum+=x*x}return Math.sqrt(sum/n)}
        let difference=null;
        if (${JSON.stringify(name)}==='wav') {
          const all=await vsApi.mediaRead(info.file,info.token), raw=await new OfflineAudioContext(1,1,16000).decodeAudioData(all.data);
          const off=new OfflineAudioContext(1,32000,16000), node=off.createBufferSource();node.buffer=raw;node.connect(off.destination);node.start(0,1.5,2);
          const reference=(await off.startRendering()).getChannelData(0), view=new DataView(voiced);let sum=0;
          for(let i=0;i<reference.length;i++)sum+=Math.abs(reference[i]-view.getInt16(44+2*i,true)/32768);
          difference=sum/reference.length;
        }
        return {pieces:found.pieces,rms:rms(voiced),quiet:rms(silent),duration:r.duration,difference};
      } finally {r.close()} })()`);
      if (result.fallback) {
        assert.ok(result.duration > 11.9, name + ': ' + JSON.stringify(result));
        console.log('OK', name, 'uses previous decoder');
        continue;
      }
      assert.equal(result.pieces.length, 2, name + ': ' + JSON.stringify(result));
      for (let i = 0; i < 2; i++) {
        assert.ok(Math.abs(result.pieces[i].sa - (1 + i * 5 + offset)) < 0.16, name + ': ' + JSON.stringify(result));
        assert.ok(Math.abs(result.pieces[i].sb - (4 + i * 5 + offset)) < 0.16, name + ': ' + JSON.stringify(result));
      }
      assert.ok(result.rms > 0.1 && result.quiet < 0.02, name + ': ' + JSON.stringify(result));
      if (name === 'wav') assert.ok(result.difference < 0.006, name + ': ' + JSON.stringify(result));
      console.log('OK', name, 'two speech segments, timing and decoded sound');
    }
    const rendererPid = await main.ev(`process.mainModule.require('electron').BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('index.html')).webContents.getOSProcessId()`);
    const metric = () => main.ev(`process.mainModule.require('electron').app.getAppMetrics().find(x=>x.pid===${rendererPid}).memory`);
    const before = await metric();
    const longResult = await page.ev(`(async()=>{const info=await vsApi.mediaInfo(${JSON.stringify(longFile)}), r=await transcriptionStream.open(info,vsApi); try {
      const levels=await r.scan(null,()=>false), found=transcriptionCore.findSpeechLevels(levels), wav=await r.wav(0,540);
      return {duration:r.duration,frames:levels.length,pieces:found.pieces.length,last:found.pieces.at(-1),wavBytes:wav.byteLength};
    } finally {r.close()} })()`);
    const after = await metric();
    assert.ok(longResult.duration > 1799 && longResult.duration < 1801, JSON.stringify(longResult));
    assert.equal(longResult.pieces, 300, JSON.stringify(longResult));
    assert.ok(Math.abs(longResult.last.sa - 1794) < 0.18, JSON.stringify(longResult));
    assert.ok(Math.abs(longResult.last.sb - 1797) < 0.18, JSON.stringify(longResult));
    assert.equal(longResult.wavBytes, 540 * 16000 * 2 + 44);
    console.log('OK 30-minute MP3, timing at end, 9-minute audio segment, renderer memory KB:', JSON.stringify({ before, after }));
    const allowed = await page.ev(`vsApi.mediaInfo(${JSON.stringify(input)})`);
    assert.equal(allowed.ok, true);
    const invalid = await page.ev(`vsApi.mediaReadRange(${JSON.stringify(input)},${JSON.stringify(allowed.token)},0,9000000)`);
    assert.equal(invalid.ok, false);
    fs.appendFileSync(input, Buffer.from([0]));
    const changed = await page.ev(`vsApi.mediaReadRange(${JSON.stringify(input)},${JSON.stringify(allowed.token)},0,64)`);
    assert.equal(changed.ok, false);
    assert.match(changed.error, /изменился/);
    const reselected = await page.ev(`vsApi.mediaInfo(${JSON.stringify(input)})`);
    assert.equal(reselected.ok, true);
    const stillChanged = await page.ev(`vsApi.mediaReadRange(${JSON.stringify(input)},${JSON.stringify(allowed.token)},0,64)`);
    assert.equal(stillChanged.ok, false);
    const newSelection = await page.ev(`vsApi.mediaReadRange(${JSON.stringify(input)},${JSON.stringify(reselected.token)},0,64)`);
    assert.equal(newSelection.ok, true);
    await page.ev(`vsApi.mediaRelease(${JSON.stringify(reselected.token)})`);
    assert.equal((await page.ev(`vsApi.mediaReadRange(${JSON.stringify(input)},${JSON.stringify(reselected.token)},0,64)`)).ok, false);
    const stopped = await page.ev(`(async()=>{const info=await vsApi.mediaInfo(${JSON.stringify(longFile)}), r=await transcriptionStream.open(info,vsApi); try {
      let scan=false, wav=false; try { await r.scan(null,()=>true); } catch(e) { scan=e.message==='stopped'; }
      try { await r.wav(0,540,()=>true); } catch(e) { wav=e.message==='stopped'; }
      return {scan,wav};
    } finally {r.close()} })()`);
    assert.deepEqual(stopped, { scan: true, wav: true });
    // A sparse test file has a logical size above 2 GiB but occupies very little actual disk space.
    const large = path.join(tmp, 'large.wav');
    fs.copyFileSync(input, large);
    const sparse = spawnSync('fsutil', ['sparse', 'setflag', large], { windowsHide: true, encoding: 'utf8' });
    if (sparse.status === 0) {
      fs.truncateSync(large, 2 * 1024 * 1024 * 1024 + 1);
      const info = await page.ev(`vsApi.mediaInfo(${JSON.stringify(large)})`);
      assert.equal(info.ok, true);
      const part = await page.ev(`vsApi.mediaReadRange(${JSON.stringify(large)},${JSON.stringify(info.token)},0,64)`);
      assert.equal(part.ok, true);
      const full = await page.ev(`vsApi.mediaRead(${JSON.stringify(large)},${JSON.stringify(info.token)})`);
      assert.equal(full.ok, false);
      assert.match(full.error, /по частям/);
      console.log('OK sparse file above 2 GiB: bounded reads allowed, whole-file fallback refused');
    } else console.log('SKIP sparse >2 GiB fixture: filesystem does not support sparse files');
    page.close(); main.close();
  } finally {
    child.kill(); await new Promise((resolve) => child.exitCode !== null ? resolve() : child.once('exit', resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
