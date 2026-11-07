'use strict';
// Check recovery after a paid-model response using a local fake API and a separate profile.
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { Store } = require('../storage');
const { connect, freePort } = require('./guide-shots/cdp');

(async () => {
  const root = path.resolve(__dirname, '..'), tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-summary-ui-'));
  const profile = path.join(tmp, 'profile'), data = path.join(tmp, 'data');
  await fs.mkdir(profile); await fs.mkdir(data);
  await fs.writeFile(path.join(profile, 'settings.json'), JSON.stringify({ dataDir: data }));
  await fs.writeFile(path.join(data, 'profile.json'), JSON.stringify({ name: 'Тест', welcomed: true }));
  const store = await new Store(data).init();
  await store.saveTranscript({ id: 'tr1', name: 'Тест.wav', text: 'Текст для итогов.', duration: 2, cues: [{ start: 0, end: 2, text: 'Текст для итогов.' }] });
  let requests = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      requests++;
      const body = Buffer.concat(chunks).toString('utf8');
      const output = body.includes('"name":"summary"')
        ? { brief: 'Краткий итог.', points: ['Важная мысль'] }
        : { title: 'Тестовый созвон', who: 'Дима', brief: 'Обсудили задачу.', decisions: ['Начать работу'], steps: [], meets: [] };
      res.setHeader('content-type', 'application/json');
      const response = JSON.stringify({ id: 'r1', object: 'response', status: 'completed', output: [{ type: 'message', id: 'm1', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: JSON.stringify(output), annotations: [] }] }],
        usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 10, total_tokens: 20 } });
      if (body.includes('УДЕРЖАТЬ')) setTimeout(() => res.end(response), 700); else res.end(response);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const [inspectPort, debugPort] = await Promise.all([freePort(), freePort()]);
  const child = spawn(require('electron'), ['.', '--inspect=' + inspectPort, '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile],
    { cwd: root, env: { ...process.env, OPENAI_BASE_URL: 'http://127.0.0.1:' + server.address().port + '/v1' }, stdio: 'ignore', windowsHide: true });
  try {
    const main = await connect(inspectPort, (t) => t.type === 'node');
    assert.equal(path.resolve(await main.ev("process.mainModule.require('electron').app.getPath('userData')")), path.resolve(profile));
    const page = await connect(debugPort, (t) => /index\.html/.test(t.url));
    await page.until('!!window.vsApi && document.readyState === "complete"');
    assert.equal((await page.ev(`vsApi.assistantCheckKey('openai','sk-test-summary-0000000000')`)).ok, true);
    await main.ev(`(() => {
      const fs=process.mainModule.require('fs').promises; global.snowSummaryRename=fs.rename;
      fs.rename=async (from,to)=>{if(to===${JSON.stringify(path.join(data, 'calendar.json'))}){const e=new Error('disk full');e.code='ENOSPC';throw e}return global.snowSummaryRename(from,to)}; return true;
    })()`);
    await page.ev(`document.querySelector('[data-page="calendar"]').click(); document.querySelector('#cal-recap-btn').click(); true`);
    await page.ev(`document.querySelector('#rd-event').value=''; document.querySelector('#rd-text').value='Текст созвона.'; document.querySelector('#rd-form').requestSubmit(); true`);
    await page.until(`!!document.querySelector('#recap-dlg .recap-recovery')`);
    assert.equal((await page.ev('vsApi.load()')).events.length, 0);
    const afterRecap = requests;
    await main.ev(`process.mainModule.require('fs').promises.rename=global.snowSummaryRename; true`);
    await page.ev(`document.querySelector('#recap-dlg .recap-recovery .btn-primary').click(); true`);
    await page.until(`!document.querySelector('#recap-dlg .recap-recovery')`);
    assert.equal(requests, afterRecap, 'retry must not contact the model');
    const events = (await page.ev('vsApi.load()')).events;
    assert.equal(events.length, 1);
    assert.equal(events[0].recap.brief, 'Обсудили задачу.');
    const beforeDelayed = requests;
    await page.ev(`window.snowRecapPending=vsApi.recapMake({eventId:${JSON.stringify(events[0].id)},text:'УДЕРЖАТЬ'}); true`);
    for (let i = 0; i < 30 && requests === beforeDelayed; i++) await page.sleep(30);
    assert.ok(requests > beforeDelayed);
    const changed = await page.ev(`vsApi.recapUpdate(${JSON.stringify(events[0].id)},${JSON.stringify({ ...events[0].recap, brief: 'Новая версия' })},${JSON.stringify(events[0].recapRevision)})`);
    assert.equal(changed.ok, true);
    const conflict = await page.ev('window.snowRecapPending');
    assert.equal(conflict.ok, false);
    assert.ok(conflict.recovery && conflict.recovery.text.includes('Обсудили задачу.'));
    assert.equal((await page.ev(`vsApi.recapCommit(${JSON.stringify(conflict.recovery.id)})`)).ok, false);
    assert.equal((await page.ev('vsApi.load()')).events[0].recap.brief, 'Новая версия');
    await page.ev(`document.querySelector('#rd-cancel').click(); document.querySelector('[data-page="transcribe"]').click(); true`);
    await page.until(`!!document.querySelector('#tr-list .tr-open')`);
    await page.ev(`document.querySelector('#tr-list .tr-open').click(); true`);
    await page.until(`!!document.querySelector('.tr-seg')`);
    await main.ev(`(() => {const fs=process.mainModule.require('fs').promises;fs.rename=async (from,to)=>{if(to===${JSON.stringify(path.join(data, 'Транскрибации', 'tr1.json'))}){const e=new Error('disk full');e.code='ENOSPC';throw e}return global.snowSummaryRename(from,to)};return true})()`);
    await page.ev(`Array.from(document.querySelectorAll('.tr-seg button')).find(b=>b.textContent==='Кратко').click(); true`);
    await page.ev(`Array.from(document.querySelectorAll('.tr-sum button')).find(b=>b.textContent.includes('Сделать кратко')).click(); true`);
    await page.until(`!!document.querySelector('textarea[aria-label="Несохранённое краткое содержание"]')`);
    assert.match(await page.ev(`document.querySelector('textarea[aria-label="Несохранённое краткое содержание"]').value`), /Краткий итог/);
    const afterSummary = requests;
    await main.ev(`process.mainModule.require('fs').promises.rename=global.snowSummaryRename; true`);
    await page.ev(`document.querySelector('textarea[aria-label="Несохранённое краткое содержание"]').closest('section').querySelector('.btn-primary').click(); true`);
    await page.until(`!document.querySelector('textarea[aria-label="Несохранённое краткое содержание"]')`);
    assert.equal(requests, afterSummary, 'retry must not contact the model');
    assert.equal((await page.ev(`vsApi.transcriptGet('tr1')`)).transcript.summary.brief, 'Краткий итог.');
    page.close(); main.close();
    console.log('OK: meeting and transcript summaries remain available and save on retry without another API request');
  } finally {
    child.kill();
    await new Promise((resolve) => child.exitCode !== null ? resolve() : child.once('exit', resolve));
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
