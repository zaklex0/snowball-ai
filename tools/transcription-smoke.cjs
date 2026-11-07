'use strict';
// Exercises transcription with an isolated profile and a local fake API; no real account is used.
const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { connect, freePort } = require('./guide-shots/cdp');

function wave(flat = false, seconds = 40) {
  const rate = 16000, samples = rate * seconds, b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF', 0); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    const second = i / rate;
    const loud = flat ? second >= 2 && second < 38 : second % 5 >= 1 && second % 5 < 4;
    const sound = loud ? Math.sin(2 * Math.PI * 220 * second) * 0.3 : 0;
    b.writeInt16LE(Math.round(sound * 32767), 44 + i * 2);
  }
  return b;
}

(async () => {
  const fallback = process.argv.includes('--fallback');
  const root = path.resolve(__dirname, '..');
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'snowball-transcription-'));
  const profile = path.join(tmp, 'profile'), data = path.join(tmp, 'data'), media = path.join(tmp, 'voice.wav'), flatMedia = path.join(tmp, 'continuous.wav'), longMedia = path.join(tmp, 'long.wav');
  await fsp.mkdir(profile); await fsp.mkdir(data);
  await fsp.writeFile(path.join(profile, 'settings.json'), JSON.stringify({ dataDir: data }));
  await fsp.writeFile(path.join(data, 'profile.json'), JSON.stringify({ name: 'Тест', welcomed: true }));
  await fsp.writeFile(media, wave());
  await fsp.writeFile(flatMedia, wave(true));
  await fsp.writeFile(longMedia, wave(false, 560));
  let pieces = 0, failureMode = true, stopTextAt = 0, diarCount = 0, delayDiar = false, failDiarSecond = false;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/responses') {
        res.end(JSON.stringify({ id: 'test', object: 'response', status: 'completed', output: [] }));
      } else if (req.url === '/v1/audio/transcriptions') {
        if (Buffer.concat(chunks).includes(Buffer.from('gpt-4o-transcribe-diarize'))) {
          const current = ++diarCount;
          if (failDiarSecond && current === 2) { res.statusCode = 400; res.end(JSON.stringify({ error: { message: 'test failure', type: 'invalid_request_error' } })); return; }
          const reply = () => res.end(JSON.stringify({ segments: [
            { start: 0, end: 18, text: 'Первая реплика.', speaker: 'A' },
            { start: 18, end: 37, text: 'Вторая реплика.', speaker: 'B' }
          ] }));
          if (delayDiar) setTimeout(reply, 1000); else reply();
          return;
        }
        const n = ++pieces;
        if (failureMode && n === 3) setTimeout(() => { res.statusCode = 400; res.end(JSON.stringify({ error: { message: 'test failure', type: 'invalid_request_error' } })); }, 250);
        else if (stopTextAt) setTimeout(() => res.end(JSON.stringify({ text: 'Остановленный фрагмент ' + n + '.' })), n === stopTextAt + 1 ? 100 : 1200);
        else res.end(JSON.stringify({ text: 'Тестовый фрагмент ' + n + '.' }));
      } else { res.statusCode = 404; res.end('{}'); }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + '/v1';
  const [inspectPort, debugPort] = await Promise.all([freePort(), freePort()]);
  const child = spawn(require('electron'), ['.', '--inspect=' + inspectPort, '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile],
    { cwd: root, env: { ...process.env, OPENAI_BASE_URL: base }, stdio: 'ignore', windowsHide: true });
  try {
    const main = await connect(inspectPort, (t) => t.type === 'node');
    assert.equal(path.resolve(await main.ev("process.mainModule.require('electron').app.getPath('userData')")), path.resolve(profile));
    const page = await connect(debugPort, (t) => /index\.html/.test(t.url));
    await page.until('!!window.vsApi && document.readyState === "complete"');
    await page.ev(`document.querySelector('#set-key-openai').value='sk-test-transcription-00000000'; document.querySelector('[data-provider="openai"] .set-key').requestSubmit(); true`);
    await page.until(`document.querySelector('[data-provider="openai"] .set-status').textContent.includes('Ключ сохранён')`, 30000);
    if (fallback) {
      await page.ev(`window.transcriptionStream.open=async()=>{throw Error('Streaming unavailable in this test')}; true`);
    } else {
      // The normal whole-file decoder must not be used: these scenarios exercise the streaming path.
      await main.ev(`(() => { const ipc=process.mainModule.require('electron').ipcMain; ipc.removeHandler('media-read'); ipc.handle('media-read',()=>({ok:false,error:'Whole-file reading disabled for this test'})); return true; })()`);
      const probe = await page.ev(`(async()=>{ const info=await vsApi.mediaInfo(${JSON.stringify(media)}); const s=await window.transcriptionStream.open(info,vsApi); try {const levels=await s.scan(null,()=>false); const wav=await s.wav(1,4); return {levels:levels.length, bytes:wav.byteLength, duration:s.duration};} finally {s.close()} })()`);
      assert.ok(probe.levels > 1000 && probe.bytes > 90000 && probe.duration > 39);
    }
    await main.ev(`process.mainModule.require('electron').dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(media)}]})`);
    await page.ev(`document.querySelector('[data-page="transcribe"]').click(); true`);
    await page.until(`!!document.querySelector('.tr-drop button')`);
    await page.ev(`document.querySelector('.tr-drop button').click(); true`);
    await page.until(`!!document.querySelector('.tr-file .btn-primary')`);
    await page.ev(`document.querySelector('.tr-file .btn-primary').click(); true`);
    await page.until(`document.querySelector('#banner-text').textContent.includes('Готовые фрагменты сохранены')`, 60000);
    const result = await page.ev('vsApi.transcriptList()');
    assert.ok(pieces >= 3);
    assert.equal(result.transcripts.length, 1);
    assert.ok(result.transcripts[0].name.startsWith('Неполная —'));
    const record = await page.ev(`vsApi.transcriptGet(${JSON.stringify(result.transcripts[0].id)})`);
    assert.match(record.transcript.text, /Тестовый фрагмент/);
    assert.ok(record.transcript.cues.length > 0);
    failureMode = false;
    await main.ev(`(() => {
      const fs=process.mainModule.require('fs').promises;
      global.snowTranscriptRename=fs.rename;
      fs.rename=async (from,to)=>{if(to.startsWith(${JSON.stringify(path.join(data, 'Транскрибации') + path.sep)}) && to.endsWith('.json')){const e=new Error('disk full');e.code='ENOSPC';throw e}return global.snowTranscriptRename(from,to)};
      return true;
    })()`);
    await page.ev(`document.querySelector('#tr-new').click(); true`);
    await page.until(`!!document.querySelector('.tr-drop button')`);
    await page.ev(`document.querySelector('.tr-drop button').click(); true`);
    await page.until(`!!document.querySelector('.tr-file .btn-primary')`);
    await page.ev(`document.querySelector('.tr-file .btn-primary').click(); true`);
    await page.until(`!!document.querySelector('textarea[aria-label="Несохранённая расшифровка"]')`, 60000);
    assert.match(await page.ev(`document.querySelector('textarea[aria-label="Несохранённая расшифровка"]').value`), /Тестовый фрагмент/);
    assert.equal((await page.ev('vsApi.transcriptList()')).transcripts.length, 1);
    const piecesBeforeSaveRetry = pieces;
    await main.ev(`process.mainModule.require('fs').promises.rename=global.snowTranscriptRename; true`);
    await page.ev(`document.querySelector('textarea[aria-label="Несохранённая расшифровка"]').closest('section').querySelector('.btn-primary').click(); true`);
    await page.until(`!document.querySelector('.tr-file') && document.querySelectorAll('#tr-list .tr-item').length >= 2`, 60000);
    assert.equal(pieces, piecesBeforeSaveRetry, 'retrying a save must not make additional transcription requests');
    const completed = await page.ev('vsApi.transcriptList()');
    const full = completed.transcripts.find((x) => x.name === 'voice.wav');
    assert.ok(full);
    const fullRecord = await page.ev(`vsApi.transcriptGet(${JSON.stringify(full.id)})`);
    assert.equal(fullRecord.transcript.cues.length, 8);
    for (const cue of fullRecord.transcript.cues) {
      const i = Math.round((cue.start - 1) / 5);
      assert.ok(Math.abs(cue.start - (1 + 5 * i)) < 0.1, JSON.stringify(cue));
      assert.ok(Math.abs(cue.end - (4 + 5 * i)) < 0.1, JSON.stringify(cue));
    }
    await main.ev(`process.mainModule.require('electron').dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(flatMedia)}]})`);
    await page.ev(`document.querySelector('#tr-new').click(); true`);
    await page.until(`!!document.querySelector('.tr-drop button')`);
    await page.ev(`document.querySelector('.tr-drop button').click(); true`);
    await page.until(`!!document.querySelector('.tr-file .btn-primary')`);
    const beforeRetry = pieces;
    await page.ev(`document.querySelector('.tr-file .btn-primary').click(); true`);
    await page.until(`Array.from(document.querySelectorAll('.tr-file button')).some(b=>b.textContent.includes('Попробовать с другим порогом'))`, 60000);
    assert.equal(pieces, beforeRetry, 'no audio should be sent before the explicit retry');
    assert.match(await page.ev(`document.querySelector('.tr-file').textContent`), /может стоить больше/);
    await page.send('Emulation.setDeviceMetricsOverride', { width: 750, height: 700, deviceScaleFactor: 1, mobile: false });
    await page.ev(`document.documentElement.setAttribute('data-theme','macos'); true`);
    for (const look of ['light', 'dark']) {
      await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: look }] });
      const box = await page.ev(`(() => { const r=Array.from(document.querySelectorAll('.tr-file button')).find(b=>b.textContent.includes('Попробовать с другим порогом')).getBoundingClientRect(); return { left:r.left, right:r.right }; })()`);
      assert.ok(box.left >= 0 && box.right <= 750, JSON.stringify({ look, box }));
    }
    await page.ev(`Array.from(document.querySelectorAll('.tr-file button')).find(b=>b.textContent.includes('Попробовать с другим порогом')).click(); true`);
    await page.until(`!document.querySelector('.tr-file') && document.querySelectorAll('#tr-list .tr-item').length >= 3`, 60000);
    const retried = await page.ev('vsApi.transcriptList()');
    assert.ok(retried.transcripts.some((x) => x.name === 'continuous.wav'));
    assert.ok(pieces > beforeRetry);
    const earlierIds = retried.transcripts.map((x) => x.id);
    await main.ev(`process.mainModule.require('electron').dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(media)}]})`);
    await page.ev(`document.querySelector('#tr-new').click(); true`);
    await page.until(`!!document.querySelector('.tr-drop button')`);
    await page.ev(`document.querySelector('.tr-drop button').click(); true`);
    await page.until(`!!document.querySelector('.tr-mbtn')`);
    await page.ev(`document.querySelector('.tr-mbtn').click(); true`);
    await page.until(`Array.from(document.querySelectorAll('.tr-mmenu .mm-item')).some(b=>b.textContent.includes('Диалог'))`);
    await page.ev(`Array.from(document.querySelectorAll('.tr-mmenu .mm-item')).find(b=>b.textContent.includes('Диалог')).click(); true`);
    await page.ev(`document.querySelector('.tr-file .btn-primary').click(); true`);
    await page.until(`!document.querySelector('.tr-file') && document.querySelectorAll('#tr-list .tr-item').length >= 4`, 60000);
    const dialogList = await page.ev('vsApi.transcriptList()');
    const dialogItem = dialogList.transcripts.find((x) => !earlierIds.includes(x.id));
    assert.ok(dialogItem);
    const dialogRecord = await page.ev(`vsApi.transcriptGet(${JSON.stringify(dialogItem.id)})`);
    assert.equal(dialogRecord.transcript.model, 'gpt-4o-transcribe-diarize');
    assert.ok(dialogRecord.transcript.cues.some((x) => x.speaker === 'Собеседник 1'));
    assert.ok(dialogRecord.transcript.cues.some((x) => x.speaker === 'Собеседник 2'));
    // Stop while ordinary requests are in flight: completed responses must be saved, not discarded.
    const oldIds = dialogList.transcripts.map((x) => x.id);
    stopTextAt = pieces;
    await page.ev(`document.querySelector('#tr-new').click(); true`);
    await page.until(`!!document.querySelector('.tr-drop button')`);
    await page.ev(`document.querySelector('.tr-drop button').click(); true`);
    await page.until(`!!document.querySelector('.tr-mbtn')`);
    await page.ev(`document.querySelector('.tr-mbtn').click(); true`);
    await page.until(`Array.from(document.querySelectorAll('.tr-mmenu .mm-item')).some(b=>b.textContent.includes('GPT transcribe'))`);
    await page.ev(`Array.from(document.querySelectorAll('.tr-mmenu .mm-item')).find(b=>b.textContent.includes('GPT transcribe')).click(); true`);
    await page.ev(`document.querySelector('.tr-file .btn-primary').click(); true`);
    await page.until(`!!document.querySelector('.tr-prog .tr-soft') && /Расшифровано кусков: [1-9]/.test(document.querySelector('.tr-prog .tr-soft').textContent)`, 60000);
    await page.ev(`Array.from(document.querySelectorAll('.tr-file button')).find(b=>b.textContent.includes('Остановить')).click(); true`);
    await page.until(`!document.querySelector('.tr-file') && document.querySelector('#banner-text').textContent.includes('Расшифровка остановлена')`, 60000);
    const afterStop = await page.ev('vsApi.transcriptList()');
    const stopItem = afterStop.transcripts.find((x) => !oldIds.includes(x.id));
    assert.ok(stopItem && stopItem.name.startsWith('Неполная —'));
    const stoppedRecord = await page.ev(`vsApi.transcriptGet(${JSON.stringify(stopItem.id)})`);
    assert.match(stoppedRecord.transcript.text, /Остановленный фрагмент/);
    assert.ok(stoppedRecord.transcript.usd > 0 && stoppedRecord.transcript.sent > 0);
    assert.ok(pieces - stopTextAt < 8, 'stopping must not start every remaining request');
    stopTextAt = 0;
    // Stop while a voice-identification request is already in flight; its returned text must survive.
    const previousIds = afterStop.transcripts.map((x) => x.id), initialDiar = diarCount;
    delayDiar = true;
    await page.ev(`document.querySelector('#tr-new').click(); true`);
    await page.until(`!!document.querySelector('.tr-drop button')`);
    await page.ev(`document.querySelector('.tr-drop button').click(); true`);
    await page.until(`!!document.querySelector('.tr-mbtn')`);
    await page.ev(`document.querySelector('.tr-mbtn').click(); true`);
    await page.until(`Array.from(document.querySelectorAll('.tr-mmenu .mm-item')).some(b=>b.textContent.includes('Диалог'))`);
    await page.ev(`Array.from(document.querySelectorAll('.tr-mmenu .mm-item')).find(b=>b.textContent.includes('Диалог')).click(); true`);
    await page.ev(`document.querySelector('.tr-file .btn-primary').click(); true`);
    for (let i = 0; i < 100 && diarCount === initialDiar; i++) await page.sleep(100);
    assert.ok(diarCount > initialDiar, 'voice-identification request must have started');
    await page.ev(`Array.from(document.querySelectorAll('.tr-file button')).find(b=>b.textContent.includes('Остановить')).click(); true`);
    await page.until(`!document.querySelector('.tr-file') && document.querySelector('#banner-text').textContent.includes('Готовые фрагменты сохранены')`, 60000);
    const afterDiarStop = await page.ev('vsApi.transcriptList()');
    const voiceItem = afterDiarStop.transcripts.find((x) => !previousIds.includes(x.id));
    assert.ok(voiceItem && voiceItem.name.startsWith('Неполная —'));
    const voiceStop = await page.ev(`vsApi.transcriptGet(${JSON.stringify(voiceItem.id)})`);
    assert.match(voiceStop.transcript.text, /Первая реплика/);
    assert.ok(voiceStop.transcript.usd > 0 && voiceStop.transcript.sent > 0);
    delayDiar = false;
    // If stopped during the second model, keep the full first model's text and both costs.
    const beforeRefineIds = afterDiarStop.transcripts.map((x) => x.id);
    stopTextAt = pieces;
    await page.ev(`document.querySelector('#tr-new').click(); true`);
    await page.until(`!!document.querySelector('.tr-drop button')`);
    await page.ev(`document.querySelector('.tr-drop button').click(); true`);
    await page.until(`!!document.querySelector('.tr-file .btn-primary')`);
    await page.ev(`document.querySelector('.tr-file .btn-primary').click(); true`);
    await page.until(`!!document.querySelector('.tr-prog .tr-soft') && /Пишу текст: готово кусков [1-9]/.test(document.querySelector('.tr-prog .tr-soft').textContent)`, 60000);
    await page.ev(`Array.from(document.querySelectorAll('.tr-file button')).find(b=>b.textContent.includes('Остановить')).click(); true`);
    await page.until(`!document.querySelector('.tr-file') && document.querySelector('#banner-text').textContent.includes('Сохранён текст модели')`, 60000);
    const afterRefineStop = await page.ev('vsApi.transcriptList()');
    const refineItem = afterRefineStop.transcripts.find((x) => !beforeRefineIds.includes(x.id));
    assert.ok(refineItem && refineItem.name.startsWith('Неполная —'));
    const refineRecord = await page.ev(`vsApi.transcriptGet(${JSON.stringify(refineItem.id)})`);
    assert.match(refineRecord.transcript.text, /Первая реплика/);
    assert.ok(refineRecord.transcript.usd > voiceStop.transcript.usd && refineRecord.transcript.sent > 0);
    stopTextAt = 0;
    // A later voice-identification failure must preserve the earlier, already paid part.
    const beforeLongIds = afterRefineStop.transcripts.map((x) => x.id);
    diarCount = 0; failDiarSecond = true;
    await main.ev(`process.mainModule.require('electron').dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(longMedia)}]})`);
    await page.ev(`document.querySelector('#tr-new').click(); true`);
    await page.until(`!!document.querySelector('.tr-drop button')`);
    await page.ev(`document.querySelector('.tr-drop button').click(); true`);
    await page.until(`!!document.querySelector('.tr-file .btn-primary')`);
    await page.ev(`document.querySelector('.tr-file .btn-primary').click(); true`);
    await page.until(`!document.querySelector('.tr-file') && document.querySelector('#banner-text').textContent.includes('Не удалось различить голоса во всей записи')`, 60000);
    const afterDiarError = await page.ev('vsApi.transcriptList()');
    const partialDiar = afterDiarError.transcripts.find((x) => !beforeLongIds.includes(x.id));
    assert.ok(partialDiar && partialDiar.name.startsWith('Неполная —'));
    const partialDiarRecord = await page.ev(`vsApi.transcriptGet(${JSON.stringify(partialDiar.id)})`);
    assert.match(partialDiarRecord.transcript.text, /Первая реплика/);
    assert.ok(partialDiarRecord.transcript.usd > 0 && partialDiarRecord.transcript.sent > 0);
    assert.equal(diarCount, 2);
    page.close(); main.close();
    console.log('OK ' + (fallback ? 'fallback' : 'streaming') + ': full and partial transcription, stop, voice detection errors and two speakers');
  } finally {
    child.kill();
    await new Promise((resolve) => child.exitCode !== null ? resolve() : child.once('exit', resolve));
    await new Promise((resolve) => server.close(resolve));
    await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
